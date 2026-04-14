const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PORT = process.env.PORT || 8099;

const HA_URL = "http://supervisor/core/api";
const HA_TOKEN = process.env.SUPERVISOR_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNGNlNThiNDk1Nzk0NDVmYjUxNzE2NDA0N2Q0MGNmZCIsImlhdCI6MTc2NTM0NzQ5MSwiZXhwIjoyMDgwNzA3NDkxfQ.Se5PGwx0U9aqyVRnD1uwvCv3F-aOE8H53CKA5TqsV7U";
console.log("TOKEN:", HA_TOKEN ? "EXISTS" : "MISSING");
let addonOptions = {};
try { addonOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch(e) {}
const OAI_KEY = addonOptions.openai_api_key || process.env.OAI_KEY || "";
const OAI_MODEL = "gpt-4o-mini";

const HISTORY_FILE = path.join(DIR, 'history.json');
const SCHEDULE_FILE = path.join(DIR, 'schedule.json');
const MEMORY_FILE = path.join(DIR, 'memory.json');

// Ensure json files exist
try { if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]'); } catch (_) {}
try { if (!fs.existsSync(SCHEDULE_FILE)) fs.writeFileSync(SCHEDULE_FILE, '[]'); } catch (_) {}
try { if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({rooms: {}, ac: {}})); } catch (_) {}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json'
};

// State
let PENDING_REPEAT = null;
let SC_TIMERS = {};
let CHAT_HISTORY = [];

// --- UTILS ---
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; } }
function writeJson(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2)); }

function getIstTimeStr(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d || new Date());
}

function logAction(device, actionStr, rawCmd) {
  const h = readJson(HISTORY_FILE);
  const t = new Date();
  h.push({ device: device.toLowerCase(), action: actionStr.toUpperCase(), timestamp: t.toISOString(), rawCmd });
  if (h.length > 2000) h.shift();
  writeJson(HISTORY_FILE, h);
}

// --- HA API ---
async function callSvc(domain, service, data) {
  const r = await fetch(`${HA_URL}/services/${domain}/${service}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`HA Error ${r.status}: ${errText}`);
  }
  return r.json();
}

function buildPrompt(entsStr) {
  const mem = readJson(MEMORY_FILE);
  return `You are Lumi, a smart home AI assistant.

Your owner is "Boss". Always call the user "Boss".

You must behave like a HUMAN assistant, not just execute commands.

-----------------------------------------
🧠 CORE BEHAVIOR
-----------------------------------------
1. Understand intent (not just keywords)
2. Handle indirect sentences naturally
3. Ask smart follow-up questions before actions
4. Use memory of rooms and devices
5. Confirm before critical actions
6. Maintain short conversation memory

-----------------------------------------
🎯 CONTEXT AWARE INTELLIGENCE
-----------------------------------------

If user says:
- "I am cold"
→ DO NOT execute directly
→ Ask:
"Boss, I think you might want me to turn off the AC. Should I do that?"

If user says:
- "I am hot"
→ Ask:
"Boss, should I turn on the AC for you?"

If user says:
- "Too bright"
→ Ask:
"Boss, which room are you in?"

If user gives room:
→ Ask:
"Boss, would you like me to reduce the brightness?"

If user says YES:
→ Reduce brightness

-----------------------------------------
🏠 ROOM UNDERSTANDING
-----------------------------------------

Use:
1. Learned memory
2. Entity names

If room missing → ALWAYS ask

-----------------------------------------
💬 CONVERSATION MEMORY
-----------------------------------------

Maintain flow:
User → AI → User → AI → EXECUTE

-----------------------------------------
🔁 FOLLOW-UP ACTION SYSTEM
-----------------------------------------

If AI asked and user says:
"yes", "ok", "do it"

→ Execute last suggested action

If user says "no"
→ Cancel

-----------------------------------------
🧠 LEARNING MODE (ADVANCED)
-----------------------------------------

If user teaches:

ROOM DEVICE / LIGHT:
- "this light is in living room"
- "this device belongs to bedroom"

→ Return:

{
  "learn": {
    "type": "room_device",
    "category": "lights",
    "entity_id": "light.rgbw_1",
    "value": "living room"
  },
  "chat": "Got it boss, I saved this device in the living room."
}

-----------------------------------------

AC ENTITY LEARNING:

If user assigns an AC entity to a specific room:
- "this is home theater ac on entity"
- "use this for turning off ac in showroom"

→ Return:

{
  "learn": {
    "type": "room_ac",
    "mode": "on",
    "entity_id": "switch.home_theater_ac_on",
    "value": "home theater"
  },
  "chat": "Got it boss, I will use this to turn ON the AC for the home theater."
}

OR

{
  "learn": {
    "type": "room_ac",
    "mode": "off",
    "entity_id": "switch.showroom_ac_off",
    "value": "showroom"
  },
  "chat": "Got it boss, I will use this to turn OFF the AC for the showroom."
}

-----------------------------------------
📂 MEMORY USAGE
-----------------------------------------

Use stored memory:

Rooms (Contains localized ACs and generic target devices):
${JSON.stringify(mem.rooms || {}, null, 2)}

-----------------------------------------
SERVICES:
light→turn_on(brightness_pct 0-100,brightness_step_pct -100 to 100,color_temp,rgb_color[r,g,b] ONLY. DO NOT use color_name)/turn_off/toggle
switch/fan/input_boolean→turn_on/turn_off/toggle
cover→open_cover/close_cover/set_cover_position(position 0-100)
media_player→media_play/media_pause/volume_set(volume_level 0-1)
climate→set_temperature(temperature)/set_hvac_mode
scene/script→turn_on

-----------------------------------------
📦 RESPONSE FORMAT (STRICT JSON ONLY)
-----------------------------------------

Chat:
{"chat":"Boss, which room are you in?"}

Light Command:
{
  "domain":"light",
  "service":"turn_on",
  "data":{
    "entity_id":"light.rgbw_1",
    "brightness_pct":30
  },
  "chat":"Done boss, brightness reduced."
}

AC OFF (If entity starts with climate.):
{
  "domain":"climate",
  "service":"set_hvac_mode",
  "data":{
    "entity_id":"climate.air_conditioner",
    "hvac_mode":"off"
  },
  "chat":"Done boss, AC turned off."
}

AC ON (If entity starts with climate.):
{
  "domain":"climate",
  "service":"set_hvac_mode",
  "data":{
    "entity_id":"climate.air_conditioner",
    "hvac_mode":"cool"
  },
  "chat":"Done boss, AC turned on."
}

AC SWITCH (If learned AC entity starts with switch. or light.):
{
  "domain":"switch",  
  "service":"turn_on", // Note: Often 'turn_on' is used to fire an IR switch even for "off"
  "data":{
    "entity_id":"switch.home_theater_ac_off"
  },
  "chat":"Done boss, triggered the AC switch."
}

MULTIPLE ITEMS (Including Actions & Learning):
If you need to return multiple commands OR multiple learned variables in the same response, ALWAYS wrap them inside a single JSON array:
[
  {
    "learn": {"type": "room_ac", "mode": "on", "entity_id": "switch.ac_24", "value": "showroom"}
  },
  {
    "learn": {"type": "room_ac", "mode": "off", "entity_id": "switch.ac_26", "value": "showroom"}
  }
]

LEARNING:
{
  "learn": {
    "type": "...",
    "entity_id": "...",
    "value": "..."
  },
  "chat": "Saved boss."
}

-----------------------------------------
⚠️ STRICT RULES
-----------------------------------------
- ALWAYS return JSON ONLY. NO raw text before or after.
- Do NOT prepend your JSON with labels like "MULTIPLE:" or "AC ON:". Just output the raw '{' or '['.
- NEVER auto execute indirect intent
- ALWAYS confirm first (UNLESS it is a scheduled action with a time delay, then execute immediately)
- ALWAYS ask room if missing
- ALWAYS remember learned data
- ALWAYS behave like assistant
- Do NOT ask confirmation questions if the user specifies a time delay or schedule (e.g. "at 3:30 PM"). Output the JSON action directly!

-----------------------------------------
ENTITIES:
${entsStr}`;
}

async function parseNL(txt, entsStr) {
  const msgs = [
    { role: 'system', content: buildPrompt(entsStr) },
    ...CHAT_HISTORY,
    { role: 'user', content: txt }
  ];

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OAI_KEY}` },
    body: JSON.stringify({
      model: OAI_MODEL,
      temperature: 0.1,
      max_tokens: 400,
      messages: msgs
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  
  const raw = data.choices[0].message.content.trim();
  let jsonStr = raw;
  const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (match) jsonStr = match[0];
  
  // Natively repair disjointed objects if the AI forgets to wrap multiple elements in an array
  if (jsonStr.match(/^\s*\{[\s\S]*\}\s*\{[\s\S]*\}\s*$/)) {
      jsonStr = `[${jsonStr.replace(/\}\s*\{/g, '},{')}]`;
  }
  
  const parsed = JSON.parse(jsonStr);
  
  CHAT_HISTORY.push({ role: 'user', content: txt });
  CHAT_HISTORY.push({ role: 'assistant', content: raw });
  if (CHAT_HISTORY.length > 20) CHAT_HISTORY = CHAT_HISTORY.slice(-20);
  
  return parsed;
}

// --- COMMAND EXECUTION ---
async function executeCmds(cmds, reqEntities) {
  let results = [];
  cmds = Array.isArray(cmds) ? cmds : [cmds];
  for (const c of cmds) {
    if (c.error) { results.push({ err: c.error }); continue; }
    
    if (c.learn) {
      let m = readJson(MEMORY_FILE);
      let rv = c.learn.value;
      if (rv) {
         if (!m.rooms) m.rooms = {};
         if (!m.rooms[rv]) m.rooms[rv] = { lights: [], ac: {}, devices: [] };
         
         if (c.learn.type === 'room_device' || c.learn.type === 'room' || c.learn.type === 'light') {
            let cat = c.learn.category || (c.learn.entity_id.startsWith('light') ? 'lights' : 'devices');
            if (!m.rooms[rv][cat]) m.rooms[rv][cat] = [];
            if (!m.rooms[rv][cat].includes(c.learn.entity_id)) m.rooms[rv][cat].push(c.learn.entity_id);
         } else if (c.learn.type === 'room_ac' || c.learn.type === 'ac') {
            if (!m.rooms[rv].ac) m.rooms[rv].ac = {};
            m.rooms[rv].ac[c.learn.mode || 'on'] = c.learn.entity_id;
         }
      }
      writeJson(MEMORY_FILE, m);
      // Let the loop continue processing if there is a domain command attached, 
      // but if it's purely learning, skip executing HA calls.
      if (!c.domain) { continue; }
    }
    
    if (c.chat && !c.domain && !c.learn) { results.push({ chat: c.chat }); continue; }
    
    const eid = c.data?.entity_id;
    const ent = reqEntities.find(e => e.entity_id === eid);
    const name = ent ? ent.name : eid;
    try {
      await callSvc(c.domain, c.service, c.data);
      let actionStr = 'ON';
      if (c.service.includes('off') || c.service.includes('close')) actionStr = 'OFF';
      
      logAction(name, actionStr, c);
      results.push({ name, err: null });
    } catch (e) {
      results.push({ name, err: e.message });
    }
  }
  return results;
}

// --- SCHEDULER ENGINE ---
function scheduleExecution(delayMs, cmds, reqEntities, niceTime) {
  const s = readJson(SCHEDULE_FILE);
  const id = Date.now().toString();
  const executeAt = new Date(Date.now() + delayMs).toISOString();
  
  s.push({ id, cmds, reqEntities, executeAt, displayTime: niceTime });
  writeJson(SCHEDULE_FILE, s);
  
  startTimerForSchedule(id, delayMs, cmds, reqEntities);
}

function startTimerForSchedule(id, delayMs, cmds, reqEntities) {
  const d = Math.max(0, delayMs);
  SC_TIMERS[id] = setTimeout(async () => {
    try { await executeCmds(cmds, reqEntities); } catch (e) { console.error('Schedule Execution Error:', e); }
    let s = readJson(SCHEDULE_FILE);
    s = s.filter(x => x.id !== id);
    writeJson(SCHEDULE_FILE, s);
    delete SC_TIMERS[id];
  }, d);
}

function loadSchedules() {
  const s = readJson(SCHEDULE_FILE);
  const now = Date.now();
  s.forEach(sch => {
    const delay = new Date(sch.executeAt).getTime() - now;
    startTimerForSchedule(sch.id, delay, sch.cmds, sch.reqEntities);
  });
}
loadSchedules();

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url === '/save-config') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(payload, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });
    return;
  }

  // --- STATES ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/states') {
    try {
      const r = await fetch(`${HA_URL}/states`, {
        headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (!r.ok) {
        const errText = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `HA Error ${r.status}: ${errText}` }));
      }
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/schedule') {
    const s = readJson(SCHEDULE_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/schedule')) {
    const id = req.url.split('id=')[1];
    let s = readJson(SCHEDULE_FILE);
    if (id) {
      if (SC_TIMERS[id]) { clearTimeout(SC_TIMERS[id]); delete SC_TIMERS[id]; }
      s = s.filter(x => x.id !== id);
    } else {
      s.forEach(x => { if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; } });
      s = [];
    }
    writeJson(SCHEDULE_FILE, s);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ok:true}));
  }
  
  if (req.method === 'GET' && req.url === '/api/history') {
    const h = readJson(HISTORY_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(h));
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, entities } = JSON.parse(body);
        let q = (text || '').toLowerCase().trim();
        const entsStr = (entities || []).map(e => `${e.name}|${e.entity_id}|${e.state}`).join('\n') || '(none)';

        // 1. Follow-up "YES"
        if (q === 'yes' || q === 'yeah' || q === 'yep') {
            if (PENDING_REPEAT) {
              const r = await executeCmds(PENDING_REPEAT.cmds, entities);
              PENDING_REPEAT = null;
              let outputs = [];
			  for (let i = 0; i < r.length; i++) {
				if (r[i].err) outputs.push(`${r[i].name} failed: ${r[i].err}`);
				else outputs.push(`${getIstTimeStr()} | ${r[i].name.toLowerCase()} | ON`); // Simplification for text UI
			  }
			  return replyJSON(res, { chat: outputs.join('\n') });
            }
        } else {
            PENDING_REPEAT = null;
        }

        // 2. LOGS & HISTORY
        if ((q.includes('history') || q.includes('log')) && (q.includes('delete') || q.includes('remove') || q.includes('clear')) && q.includes('all')) {
            writeJson(HISTORY_FILE, []);
            return replyJSON(res, { chat: "Done boss! I have cleared your entire action history." });
        }

        const logMatch = q.match(/last\s*(\d+)?\s*log/);
        if (logMatch || q.includes('last logs') || q.includes('show logs') || q === 'logs' || q === 'logs.') {
          const count = parseInt(logMatch?.[1] || 10);
          const h = readJson(HISTORY_FILE);
          const l = h.slice(-count);
          if (l.length === 0) return replyJSON(res, {chat: "No logs found boss."});
          
          let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px">`;
          l.forEach(x => {
            const time = getIstTimeStr(new Date(x.timestamp));
            const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
            logHtml += `<div style="background:var(--surf2);padding:8px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);box-shadow:0 2px 8px rgba(0,0,0,0.2);">
              <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${x.device}</span></span>
              <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${x.action}</span>
            </div>`;
          });
          logHtml += `</div>`;
          return replyJSON(res, {chat: logHtml, isHtml: true});
        }

        // 3. REPEAT LAST ACTION
        if (q === 'repeat last action' || q === 'repeat last') {
          const h = readJson(HISTORY_FILE);
          for (let i = h.length - 1; i >= 0; i--) {
            if (h[i].rawCmd) {
              const c = h[i].rawCmd;
              const r = await executeCmds([c], entities);
              const name = (r[0] && !r[0].err) ? r[0].name : "the device";
              let actionStr = 'turned ON';
              if (c.service && (c.service.includes('off') || c.service.includes('close'))) actionStr = 'turned OFF';
              return replyJSON(res, { chat: `I have ${actionStr} ${name.toLowerCase()} boss!` });
            }
          }
          return replyJSON(res, { chat: "No previous action to repeat boss." });
        }

        // 4. SCHEDULES MANAGEMENT
        if (q.includes('schedule') || q.includes('schedules')) {
          if (q.match(/\b(show|what|list)\b/)) {
            const sum = readJson(SCHEDULE_FILE).length;
            if (sum === 0) return replyJSON(res, { chat: "No schedules found boss." });
            return replyJSON(res, { chat: `You have ${sum} scheduled actions boss. Check the schedule icon at the top for details!` });
          }
          if (q.includes('remove') || q.includes('delete') || q.includes('cancel') || q.includes('clear')) {
            let s = readJson(SCHEDULE_FILE);
            if (q.includes('all')) {
              s.forEach(x => { if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; } });
              writeJson(SCHEDULE_FILE, []);
              return replyJSON(res, { chat: "Done boss! I have removed all schedules." });
            }
            
            const tMatch = q.match(/(\d+):(\d+)/);
            if (tMatch) {
                const targetTimeStr = `${tMatch[1]}:${tMatch[2]}`;
                const initialLen = s.length;
                s = s.filter(x => {
                    if (x.displayTime && x.displayTime.includes(targetTimeStr)) {
                        if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; }
                        return false;
                    }
                    return true;
                });
                writeJson(SCHEDULE_FILE, s);
                if (s.length < initialLen) return replyJSON(res, { chat: `Done boss! I have removed the schedule for ${targetTimeStr}.` });
                else return replyJSON(res, { chat: `I couldn't find a schedule at ${targetTimeStr} boss.` });
            }
          }
        }

        // 5. TIME LOOKBACK
        if (q.includes('yesterday') || q.includes('ago') || q.includes('before') || q.match(/(\d+)\s*mis\s*befor/)) {
          let target = Date.now();
          let windowMs = 15 * 60 * 1000;
          if (q.includes('yesterday')) target -= 24 * 3600 * 1000;
          else {
            let m = q.match(/(\d+)\s*(hour|minute|day|min|mis)s?\s*(?:ago|before|befor)/);
            if (!m) m = q.match(/(?:before|befor)\s*(\d+)\s*(hour|minute|day|min|mis)s?/);
            if (m) {
              const v = parseInt(m[1]), u = m[2];
              if (u === 'hour') target -= v * 3600 * 1000;
              if (u === 'minute' || u === 'min' || u === 'mis') { target -= v * 60 * 1000; windowMs = 2 * 60 * 1000; }
              if (u === 'day') target -= v * 24 * 3600 * 1000;
            }
          }
          
          let countLimit = 0;
          let limitMatch = q.match(/(?:show|what).*(?:me\s)?(\d+)\s*action/);
          if (limitMatch) countLimit = parseInt(limitMatch[1]);
          
          const h = readJson(HISTORY_FILE);
          let found = h.filter(x => Math.abs(new Date(x.timestamp).getTime() - target) <= windowMs);
          if (countLimit > 0) found = found.slice(-countLimit);
          
          if (!found.length) return replyJSON(res, { chat: "No actions found around that time boss."});
          
          PENDING_REPEAT = { cmds: found.map(x => x.rawCmd).filter(x => !!x) };
          
          let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px">`;
          found.forEach(x => {
            const time = getIstTimeStr(new Date(x.timestamp));
            const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
            logHtml += `<div style="background:var(--surf2);padding:8px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);box-shadow:0 2px 8px rgba(0,0,0,0.2);">
              <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${x.device}</span></span>
              <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${x.action}</span>
            </div>`;
          });
          logHtml += `</div><div style="margin-top:10px;font-size:13.5px">Do you want me to repeat this?</div>`;
          return replyJSON(res, {chat: logHtml, isHtml: true});
        }

        // 5. DELAYS & SCHEDULES
        let delayMs = 0;
        let niceTime = '';
        const delayMatch = q.match(/after (\d+) (second|minute|hour)s?/);
        const atMatch = q.match(/at (\d+)(?::(\d+))?\s*(pm|am)?/);
        
        let cleanedQ = q;
        if (delayMatch) {
          const v = parseInt(delayMatch[1]), u = delayMatch[2];
          if (u === 'second') delayMs = v * 1000;
          if (u === 'minute') delayMs = v * 60 * 1000;
          if (u === 'hour') delayMs = v * 3600 * 1000;
          cleanedQ = cleanedQ.replace(delayMatch[0], '').trim();
          niceTime = `in ${v} ${u}s`;
        } else if (atMatch) {
          let hr = parseInt(atMatch[1]);
          let mn = parseInt(atMatch[2] || 0);
          let ampm = atMatch[3];
          if (ampm === 'pm' && hr < 12) hr += 12;
          if (ampm === 'am' && hr === 12) hr = 0;
          
          let now = new Date();
          const istStr = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Kolkata', year:'numeric', month:'numeric', day:'numeric'}).format(now);
          const tDate = new Date(`${istStr} ${hr}:${mn}:00 GMT+0530`);
          if (tDate.getTime() < Date.now()) tDate.setDate(tDate.getDate() + 1);
          delayMs = tDate.getTime() - Date.now();
          cleanedQ = cleanedQ.replace(atMatch[0], '').trim();
          niceTime = `at ${hr}:${mn.toString().padStart(2, '0')} ${ampm||''}`.trim();
        }

        // 6. OPENAI NLP
        const aiQuery = delayMs > 0 ? `${cleanedQ} (CRITICAL: User is scheduling this. DO NOT ask for confirmation, output the action JSON immediately.)` : (cleanedQ || "turn on");
        const parsed = await parseNL(aiQuery, entsStr);
        if (parsed.chat && !parsed.domain && !parsed.learn) return replyJSON(res, { chat: parsed.chat });
        
        const cmds = Array.isArray(parsed) ? parsed : [parsed];

        if (delayMs > 0) {
          scheduleExecution(delayMs, cmds, entities, niceTime);
          return replyJSON(res, { chat: `Got it boss, I've scheduled that for ${niceTime}.` });
        } else {
          // Immediate
          const results = await executeCmds(cmds, entities);
          let outputs = [];
          for (let i = 0; i < results.length; i++) {
              if (results[i].err) outputs.push(`${results[i].name} failed: ${results[i].err}`);
          }
          if (outputs.length > 0) return replyJSON(res, { chat: outputs.join('\\n') });
          
          return replyJSON(res, { chat: Array.isArray(parsed) ? (parsed[0].chat || "Consider it done boss!") : (parsed.chat || "Done boss!") });
        }
      } catch (e) {
        return replyJSON(res, { chat: `Ran into an issue boss: ${e.message}` });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/transcribe') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { audioBase64, ext } = JSON.parse(body);
        const format = ext || 'webm';
        const fileBuffer = Buffer.from(audioBase64, 'base64');

        // --- SAVE TO HOME ASSISTANT VIA FTP ---
        try {
          const ftp = require('basic-ftp');
          const { Readable } = require('stream');
          const client = new ftp.Client();
          client.ftp.verbose = false;
          
          await client.access({
             host: process.env.FTP_HOST || "192.168.2.25",
             user: "lumiai",
             password: "lumiai",
             secure: false
          });
          
          try {
             await client.ensureDir("www/community/images/mp3");
          } catch(e) {
             // Fallback if structure is different
          }
          
          const stream = new Readable();
          stream.push(fileBuffer);
          stream.push(null);
          
          const filename = `recording_${Date.now()}.${format}`;
          await client.uploadFrom(stream, `www/community/images/mp3/${filename}`);
          
          client.close();
          console.log(`Saved audio via FTP to: www/community/images/mp3/${filename}`);
        } catch (ftpErr) {
          console.error("FTP Save Error:", ftpErr.message);
        }

        const boundary = '----Boundary' + Math.random().toString(36).substring(2);
        const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${format}"\r\nContent-Type: audio/${format}\r\n\r\n`;
        const post = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--`;
        const payload = Buffer.concat([
          Buffer.from(pre, 'utf8'),
          fileBuffer,
          Buffer.from(post, 'utf8')
        ]);
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Authorization': `Bearer ${OAI_KEY}`
          },
          body: payload
        });
        const ans = await r.json();
        if (ans.error) throw new Error(ans.error.message);
        return replyJSON(res, { text: ans.text || "" });
      } catch (e) {
        return replyJSON(res, { error: e.message });
      }
    });
    return;
  }

  // Serving static files
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const fp = path.join(DIR, urlPath);
  try {
    const data = fs.readFileSync(fp);
    const ext  = path.extname(fp);
    const ct   = MIME[ext] || 'text/plain';
    res.writeHead(200, { 
      'Content-Type': ct, 
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
    res.end(data);
  } catch (_) { res.writeHead(404); res.end('Not found'); }
});

function replyJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumi Demo AI Backend running at http://localhost:${PORT}`);
});