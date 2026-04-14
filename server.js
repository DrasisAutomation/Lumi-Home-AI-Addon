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
const OAI_KEY = addonOptions.openai_api_key || process.env.OAI_KEY || "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";
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
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fp === MEMORY_FILE ? { rooms: {} } : []; } }
function writeJson(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2)); }

function getIstTimeStr(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d || new Date());
}

function logAction(device, actionStr, rawCmd) {
  const h = readJson(HISTORY_FILE);
  const t = new Date();
  const devName = Array.isArray(device) ? device.join(', ') : String(device);
  h.push({ device: devName.toLowerCase(), action: actionStr.toUpperCase(), timestamp: t.toISOString(), rawCmd });
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
≡ƒºá CORE BEHAVIOR
-----------------------------------------
1. Understand intent (not just keywords)
2. Handle indirect sentences naturally
3. Ask smart follow-up questions before actions
4. Use memory of rooms and devices
5. Confirm before critical actions
6. Maintain short conversation memory

-----------------------------------------
≡ƒÄ» CONTEXT AWARE INTELLIGENCE
-----------------------------------------

If user says:
- "I am cold"
ΓåÆ DO NOT execute directly
ΓåÆ Ask:
"Boss, I think you might want me to turn off the AC. Should I do that?"

If user says:
- "I am hot"
ΓåÆ Ask:
"Boss, should I turn on the AC for you?"

If user says:
- "Too bright"
ΓåÆ Ask:
"Boss, which room are you in?"

If user gives room:
ΓåÆ Ask:
"Boss, would you like me to reduce the brightness?"

If user says YES:
ΓåÆ Reduce brightness

-----------------------------------------
≡ƒÅá ROOM UNDERSTANDING
-----------------------------------------

Use:
1. Learned memory
2. Entity names

If room missing ΓåÆ ALWAYS ask

-----------------------------------------
≡ƒÆ¼ CONVERSATION MEMORY
-----------------------------------------

Maintain flow:
User ΓåÆ AI ΓåÆ User ΓåÆ AI ΓåÆ EXECUTE

-----------------------------------------
≡ƒöü FOLLOW-UP ACTION SYSTEM
-----------------------------------------

If AI asked and user says:
"yes", "ok", "do it"

ΓåÆ Execute last suggested action

If user says "no"
ΓåÆ Cancel

-----------------------------------------
≡ƒºá LEARNING MODE (ADVANCED)
-----------------------------------------

If user teaches something, you MUST return a strict JSON payload with the 'learn' parameter:

ROOM ALIAS:
- "mohan room means experience room"

ΓåÆ Return:

{
  "learn": {
    "type": "room_alias",
    "alias": "mohan room",
    "target": "experience room"
  },
  "chat": "Got it boss, mohan room is the experience room."
}

ROOM DEVICE W/ SUBCATEGORY (Works for lights, covers, sensors, devices):
- "this light is the chandelier in living room"

ΓåÆ Return:

{
  "learn": {
    "type": "room_device",
    "category": "lights",
    "sub_category": "chandelier",
    "entity_id": "light.rgbw_1",
    "value": "living room"
  },
  "chat": "Got it boss, saved as chandelier in living room."
}

AC ENTITY LEARNING W/ MODES (18, 20, on, off):
- "this is home theater ac 18 degree"

ΓåÆ Return:

{
  "learn": {
    "type": "room_ac",
    "sub_category": "main ac",
    "mode": "18",
    "entity_id": "switch.ac_18",
    "value": "home theater"
  },
  "chat": "Saved 18 degree mode for home theater AC."
}

-----------------------------------------
≡ƒôé MEMORY USAGE & SENSORS
-----------------------------------------

Memory includes room_aliases, lights, ac, covers, sensors, devices (with subcategories):
${JSON.stringify(mem || {}, null, 2)}

* If user queries sensor details (e.g. "temperature here"), lookup the room's sensor entity in memory. Then find its state from the ENTITIES context below and reply naturally!
* If user acts on a subcategory (e.g. "turn on chandelier"), trigger ALL entities listed under that subcategory.

-----------------------------------------
SERVICES & ENTITY DOMAINS (CRITICAL RULES):
* ΓÜá∩╕Å ALWAYS match the domain/service to the ENTITY PREFIX.
* If entity is switch. (e.g., switch.curtain_main) ΓåÆ ALWAYS use switch / turn_on or turn_off. NEVER use open_cover.
* If entity is cover. ΓåÆ use cover / open_cover or close_cover.

lightΓåÆturn_on(brightness_pct 0-100, color_temp_kelvin 2000-6500 ONLY, rgb_color[r,g,b])/turn_off/toggle
switch/fan/input_booleanΓåÆturn_on/turn_off/toggle (Use this for curtains IF entity starts with switch.)
coverΓåÆopen_cover/close_cover/set_cover_position(position 0-100) (Use this for curtains IF entity starts with cover.)
media_playerΓåÆmedia_play/media_pause/volume_set(volume_level 0-1)
climateΓåÆset_temperature(temperature)/set_hvac_mode (If exact AC degree switch not in memory)
scene/scriptΓåÆturn_on

-----------------------------------------
≡ƒôª RESPONSE FORMAT (STRICT JSON ONLY)
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
    "learn": {
      "type": "room_alias",
      "alias": "showroom",
      "target": "mohan room"
    }
  },
  {
    "learn": {
      "type": "room_device",
      "category": "lights",
      "sub_category": "center light",
      "entity_id": "switch.center_light",
      "value": "showroom"
    },
    "chat": "Saved both center light and room alias!"
  }
]

LEARNING (CRITICAL - YOU MUST INCLUDE THE 'learn' OBJECT IF USER TEACHES YOU SOMETHING):
{
  "learn": {
    "type": "room_alias | room_device | room_ac",
    "category": "lights | covers | sensors | devices (IF room_device)",
    "sub_category": "chandelier | main blind | etc.",
    "entity_id": "...",
    "value": "...",
    "alias": "...",
    "target": "..."
  },
  "chat": "Saved boss."
}

-----------------------------------------
ΓÜá∩╕Å STRICT RULES
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
  console.log("GPT RAW RESP:", raw);
  let jsonStr = raw;
  let parsed;
  const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  
  if (match) {
    jsonStr = match[0];
    // Natively repair disjointed objects if the AI forgets to wrap multiple elements in an array
    if (jsonStr.match(/^\s*\{[\s\S]*\}\s*\{[\s\S]*\}\s*$/)) {
        jsonStr = `[${jsonStr.replace(/\}\s*\{/g, '},{')}]`;
    }
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        parsed = { chat: raw };
    }
  } else {
    parsed = { chat: raw };
  }
  
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
      
      if (c.learn.type === 'room_alias') {
         if (!m.room_aliases) m.room_aliases = {};
         m.room_aliases[c.learn.alias] = c.learn.target;
      }
      
      let rv = c.learn.value;
      if (rv) {
         if (!m.rooms) m.rooms = {};
         if (!m.rooms[rv]) m.rooms[rv] = {};
         
         if (!m.rooms[rv].lights) m.rooms[rv].lights = {};
         if (!m.rooms[rv].covers) m.rooms[rv].covers = {};
         if (!m.rooms[rv].sensors) m.rooms[rv].sensors = {};
         if (!m.rooms[rv].devices) m.rooms[rv].devices = {};
         if (!m.rooms[rv].ac) m.rooms[rv].ac = {};
         
         if (['room_device', 'room', 'light', 'cover', 'sensor'].includes(c.learn.type)) {
            let cat = c.learn.category || (c.learn.entity_id?.startsWith('light') ? 'lights' : c.learn.entity_id?.startsWith('cover') ? 'covers' : c.learn.entity_id?.startsWith('sensor') ? 'sensors' : 'devices');
            let sub = c.learn.sub_category || 'default';
            
            if (Array.isArray(m.rooms[rv][cat])) {
               m.rooms[rv][cat] = { default: m.rooms[rv][cat] };
            }
            if (!m.rooms[rv][cat][sub]) m.rooms[rv][cat][sub] = [];
            if (!m.rooms[rv][cat][sub].includes(c.learn.entity_id)) m.rooms[rv][cat][sub].push(c.learn.entity_id);
         } else if (c.learn.type === 'room_ac' || c.learn.type === 'ac') {
            let sub = c.learn.sub_category || 'default';
            if (m.rooms[rv].ac.on || m.rooms[rv].ac.off) {
                let tempAc = { ...m.rooms[rv].ac };
                m.rooms[rv].ac = { default: tempAc };
            }
            if (!m.rooms[rv].ac[sub]) m.rooms[rv].ac[sub] = {};
            m.rooms[rv].ac[sub][c.learn.mode || 'on'] = c.learn.entity_id;
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
      if (c.domain === 'cover') {
        if (c.service === 'open_cover') {
          c.service = 'set_cover_position';
          c.data.position = 100;
        } else if (c.service === 'close_cover') {
          c.service = 'set_cover_position';
          c.data.position = 0;
        }
      }
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
  console.log(`[REQUEST] ${req.method} ${req.url}`);
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

  // --- SMS PROXY ENDPOINT ---
  if (req.method === 'POST' && req.url === '/api/send-otp') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let { phoneNumber, otp } = JSON.parse(body);
        phoneNumber = String(phoneNumber || '').trim();
        otp = String(otp || '').trim();
        
        if (!phoneNumber || !otp || !/^[0-9]{10}$/.test(phoneNumber) || !/^[0-9]{6}$/.test(otp)) {
          console.error(`Received invalid format. Phone: [${phoneNumber}] length=${phoneNumber.length}, OTP: [${otp}] length=${otp.length}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Invalid format received exactly as: phone=[${phoneNumber}], otp=[${otp}]` }));
        }

        const msg = `Your OTP for login is ${otp}. It is valid for 5 minutes. Do not share this code with anyone. Contact support if the OTP was not requested by you - Ziamore.`;
        const smsUrl = `https://sms.textspeed.in/vb/apikey.php?apikey=gdCD8AQiQWAPDTS2&senderid=ZIAMRE&templateid=1707177390087516591&number=${phoneNumber}&message=${encodeURIComponent(msg)}`;
        
        https.get(smsUrl, (smsRes) => {
          let data = '';
          smsRes.on('data', chunk => data += chunk);
          smsRes.on('end', () => {
            let parsedData = {};
            try { parsedData = JSON.parse(data); } catch(err) { parsedData = { raw: data }; }
            
            if (smsRes.statusCode >= 400) {
              res.writeHead(smsRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'SMS Provider Error: ' + smsRes.statusCode, data: parsedData }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'OTP dispatched via proxy.', data: parsedData }));
            }
          });
        }).on('error', (e) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'SMS proxy failed: ' + e.message }));
        });
      } catch (e) {
        console.error("Top level caught:", e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
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

        // 2. LOGS & HISTORY & MEMORY
        if (q.includes('clear') && q.includes('memory')) {
            CHAT_HISTORY = [];
            writeJson(MEMORY_FILE, { rooms: {} });
            return replyJSON(res, { chat: "Done! I have wiped my memory file and conversation context." });
        }
        
        if ((q.includes('history') || q.includes('log')) && (q.includes('delete') || q.includes('remove') || q.includes('clear')) && q.includes('all')) {
            writeJson(HISTORY_FILE, []);
            CHAT_HISTORY = []; // Good idea to clear chat history as well
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
        const boundary = '----Boundary' + Math.random().toString(36).substring(2);
        const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${format}"\r\nContent-Type: audio/${format}\r\n\r\n`;
        const post = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--`;
        const payload = Buffer.concat([
          Buffer.from(pre, 'utf8'),
          Buffer.from(audioBase64, 'base64'),
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
  
  // HA Ingress can sometimes pass empty string for root URL if trailing slash is missing
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  
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
  } catch (err) { 
    console.error(`[Static File Error] Failed to serve ${fp}:`, err.message);
    res.writeHead(404); 
    res.end('404 Not Found - ' + urlPath); 
  }
});

function replyJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumi Demo AI Backend running at http://localhost:${PORT}`);
});
