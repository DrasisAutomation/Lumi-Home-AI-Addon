
/* ══════════════════════════════════════
   LUCIDE ICON INIT
══════════════════════════════════════ */
function initLucide(){
  if(window.lucide&&window.lucide.createIcons){
    lucide.createIcons();
  } else {
    setTimeout(initLucide,60);
  }
}
initLucide();

/* ══════════════════════════════════════
   CONFIG (config.json + localStorage)
══════════════════════════════════════ */
const LS_KEY  ="lumi_cfg";

let ENTITIES=[];
let SELECTED=new Set();

/* Load from config.json (when served from HTTP), fallback to localStorage */
async function loadConfig(){
  // 1. Try config.json via HTTP
  try{
    const r=await fetch('config.json?v='+Date.now());
    if(r.ok){
      const j=await r.json();
      if(Array.isArray(j.aiEnabledDevices)){
        SELECTED=new Set(j.aiEnabledDevices);
        return;
      }
    }
  }catch(_){}
  // 2. Fallback: localStorage
  try{
    const raw=localStorage.getItem(LS_KEY);
    if(raw){
      const j=JSON.parse(raw);
      if(Array.isArray(j.aiEnabledDevices)) SELECTED=new Set(j.aiEnabledDevices);
    }
  }catch(_){}
}

const API_BASE = window.location.pathname.endsWith('/') ? window.location.pathname.slice(0, -1) : window.location.pathname;

/* Save: try POST /save-config (local server), then localStorage */
async function saveConfig(){
  const payload={aiEnabledDevices:[...SELECTED]};
  let savedToFile=false;
  try{
    const r=await fetch(`${API_BASE}/save-config`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    if(r.ok) savedToFile=true;
  }catch(_){}
  // Always also write to localStorage as backup
  try{ localStorage.setItem(LS_KEY,JSON.stringify(payload)); }catch(_){}
  return savedToFile;
}

/* ══════════════════════════════════════
   REST API TO BACKEND
══════════════════════════════════════ */
function setDot(c,l){document.getElementById('dot').className=c;document.getElementById('slbl').textContent=l;}

async function loadEnt(){
  setDot('ok','Connected'); // Managed by Ingress
  try{
    const r = await fetch(`${API_BASE}/api/states`);
    const d = await r.json();
    if (d.error) {
       document.getElementById('dlg-ent-list').innerHTML = `<div style="padding:16px;color:var(--red);text-align:center">${esc(d.error)}</div>`;
       return;
    }
    if (!Array.isArray(d.result)) {
       document.getElementById('dlg-ent-list').innerHTML = `<div style="padding:16px;color:var(--red);text-align:center">Invalid HA Response: ${esc(JSON.stringify(d.result))}</div>`;
       return;
    }
    ENTITIES=(d.result||[]).map(s=>({
      entity_id:s.entity_id,domain:s.entity_id.split('.')[0],
      state:s.state,name:s.attributes?.friendly_name||s.entity_id,
      attributes:s.attributes||{}
    }));
    ENTITIES.sort((a,b)=>a.domain.localeCompare(b.domain)||a.name.localeCompare(b.name));
    const ecnt=document.getElementById('ecnt');
    ecnt.textContent='('+ENTITIES.length+')';
  }catch(e){console.warn(e);}
}

/* ══════════════════════════════════════
   DOMAIN ICON MAP
══════════════════════════════════════ */
const DIM={
  light:'lightbulb',switch:'toggle-right',cover:'layers',
  climate:'thermometer',media_player:'speaker',sensor:'activity',
  binary_sensor:'radio',input_boolean:'check-square',scene:'sparkles',
  script:'code-2',automation:'cpu',fan:'wind',camera:'camera',
  lock:'lock',vacuum:'disc',alarm_control_panel:'shield',
  water_heater:'droplets',humidifier:'cloud-drizzle'
};
function dico(d){return DIM[d]||'square';}

/* ══════════════════════════════════════
   AI
══════════════════════════════════════ */

/* Boss replies */
const OK_REPLIES=["Done boss! What's next?","Got it boss! Anything else?","All set boss! What's next?","Consider it done boss!"];
const FAIL_REPLIES=["Couldn't do that one boss.","That didn't work boss."];
function okReply(){return OK_REPLIES[Math.floor(Math.random()*OK_REPLIES.length)];}
function failReply(){return FAIL_REPLIES[Math.floor(Math.random()*FAIL_REPLIES.length)];}

/* Entity scoring */
function getAIEntities(q){
  const pool=SELECTED.size>0
    ?ENTITIES.filter(e=>SELECTED.has(e.entity_id))
    :ENTITIES.filter(e=>['light','switch','cover','fan','input_boolean','scene','media_player','climate'].includes(e.domain)).slice(0,50);
  if(!q) return pool;
  const words=q.toLowerCase().split(/\s+/).filter(w=>w.length>2);
  return pool.map(e=>{
    const h=(e.name+' '+e.entity_id).toLowerCase();
    let sc=0;words.forEach(w=>{if(h.includes(w))sc+=3;});
    return{e,sc};
  }).sort((a,b)=>b.sc-a.sc).slice(0,40).map(s=>s.e);
}

/* Unified prompt — AI decides intent, single call, no keyword guessing */
function sendCmd(txt) {
  const el = document.getElementById('cmd');
  el.value = txt;
  send(false);
}

function getIstTimeStr(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d || new Date());
}

async function openLogsDlg() {
  document.getElementById('logs-ov').style.display='flex';
  const el = document.getElementById('logs-list');
  el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--txt3)">Loading...</div>';
  try {
    const r = await fetch(`${API_BASE}/api/history`);
    const s = await r.json();
    if (!s.length) {
      el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--txt3)">No logs found.</div>';
      return;
    }
    const l = s.slice(-30).reverse();
    let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;padding:16px">`;
    l.forEach(x => {
      const time = getIstTimeStr(new Date(x.timestamp));
      const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
      logHtml += `<div style="background:var(--surf2);padding:10px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);">
        <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${esc(x.device)}</span></span>
        <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${esc(x.action)}</span>
      </div>`;
    });
    logHtml += `</div>`;
    el.innerHTML = logHtml;
  } catch (e) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--red)">Failed to load.</div>';
  }
}

async function delSched(id) {
  try {
    document.getElementById('sched-list').innerHTML = '<div style="padding:16px;text-align:center;color:var(--txt3)">Deleting...</div>';
    await fetch(`${API_BASE}/api/schedule?id=` + id, { method: 'DELETE' });
    openSchedDlg();
  } catch (e) {
    console.error(e);
  }
}

async function openSchedDlg() {
  document.getElementById('sched-ov').style.display='flex';
  const el = document.getElementById('sched-list');
  el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--txt3)">Loading...</div>';
  try {
    const r = await fetch(`${API_BASE}/api/schedule`);
    const s = await r.json();
    if (!s.length) {
      el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--txt3)">No scheduled actions.</div>';
      return;
    }
    el.innerHTML = s.map(x => {
      const acts = x.cmds.map(c => {
        let n = c.data?.entity_id || 'Device';
        if (x.reqEntities) {
          const e = x.reqEntities.find(ee=>ee.entity_id===n);
          if (e) n = e.name;
        }
        let t = (c.service && c.service.includes('off')) ? 'OFF' : 'ON';
        return `${esc(n)} &rarr; ${t}`;
      }).join(', ');
      return `<div class="de-r" style="display:flex;justify-content:space-between;align-items:center;padding:14px;border-bottom:1px solid var(--bdr)">
        <div style="font-size:13px;width:100%">
          <div style="color:var(--txt);font-weight:500">${esc(x.displayTime)}</div>
          <div style="color:var(--txt3);font-size:11.5px;margin-top:4px;white-space:normal;line-height:1.4">${acts}</div>
        </div>
        <button onclick="delSched('${x.id}')" style="background:none;border:none;color:var(--red);cursor:pointer;padding:6px;opacity:0.8;transition:opacity 0.2s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8" aria-label="Delete"><i data-lucide="trash-2" style="width:16px;height:16px"></i></button>
      </div>`;
    }).join('');
    lucide.createIcons({nodes:el.querySelectorAll('[data-lucide]')});
  } catch (e) {
    el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--red)">Failed to load.</div>';
  }
}



/* ══════════════════════════════════════
   CHAT UI
══════════════════════════════════════ */
let chatOn=false,tC=0;
function activateChat(){
  if(chatOn)return;chatOn=true;
  document.getElementById('hero').style.display='none';
  document.getElementById('msgs').style.display='flex';
  document.getElementById('inp').style.display='block';
  setTimeout(()=>document.getElementById('cmd2').focus(),80);
}
function addU(txt){
  activateChat();
  const c=document.getElementById('msgs');
  const d=document.createElement('div');d.className='mr u';
  d.innerHTML=`<div class="bb u">${esc(txt)}</div>`;
  c.appendChild(d);c.scrollTop=c.scrollHeight;
}
function addTyp(){
  activateChat();
  const c=document.getElementById('msgs');
  const id='t'+(tC++);
  const d=document.createElement('div');d.className='mr';d.id=id;
  d.innerHTML=`<div class="av"><i data-lucide="bot"></i></div><div class="bb a"><div class="td"><span></span><span></span><span></span></div></div>`;
  c.appendChild(d);c.scrollTop=c.scrollHeight;
  lucide.createIcons({nodes:d.querySelectorAll('[data-lucide]')});
  return id;
}
function rmTyp(id){const e=document.getElementById(id);if(e)e.remove();}
function addA(txt, isHtml){
  const c=document.getElementById('msgs');
  const d=document.createElement('div');d.className='mr';
  let inner=`<div class="av"><i data-lucide="bot"></i></div><div class="bb a" ${isHtml ? 'style="width:100%;max-width:100%;background:transparent!important;padding:0;box-shadow:none"' : ''}>${isHtml ? txt : esc(txt)}</div>`;
  d.innerHTML=inner;
  c.appendChild(d);c.scrollTop=c.scrollHeight;
  lucide.createIcons({nodes:d.querySelectorAll('[data-lucide]')});
  if (typeof speakText === 'function' && !isHtml) speakText(txt);
}

/* ══════════════════════════════════════
   SETTINGS BUTTON VISIBILITY
══════════════════════════════════════ */
let settingsHideTimer=null;
function showSettingsBtn(){
  const b=document.getElementById('btn-settings');
  b.style.display='flex';
  clearTimeout(settingsHideTimer);
  settingsHideTimer=setTimeout(hideSettingsBtn,30*60*1000);
}
function hideSettingsBtn(){
  document.getElementById('btn-settings').style.display='none';
  clearTimeout(settingsHideTimer);
}

async function send(fromBottom){
  const el=document.getElementById(fromBottom?'cmd2':'cmd');
  const txt=el.value.trim();if(!txt)return;
  el.value='';

  // ── Secret commands (show/hide settings) ──
  const cmd=txt.toLowerCase().trim();
  if(cmd.includes('show')&&(cmd.includes('entity config')||cmd.includes('setting'))){
    showSettingsBtn();
    addU(txt);
    addA('Here you go boss! Settings will auto-hide in 30 minutes.');
    return;
  }
  if(cmd.includes('hide')&&(cmd.includes('entity config')||cmd.includes('setting'))){
    hideSettingsBtn();
    addU(txt);
    addA('Settings hidden boss!');
    return;
  }

  addU(txt);
  const tid=addTyp();
  try{
    const reqEntities = SELECTED.size > 0 
      ? ENTITIES.filter(e => SELECTED.has(e.entity_id)) 
      : ENTITIES.filter(e => ['light','switch','cover','fan','input_boolean','scene','media_player','climate'].includes(e.domain)).slice(0, 50);

    const r = await fetch(`${API_BASE}/api/chat`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ text: txt, entities: reqEntities })
    });
    
    let parsed;
    try {
      parsed = await r.json();
    } catch(e) { throw new Error('Server returned invalid data'); }
    
    rmTyp(tid);
    
    if (parsed.error) addA('Issue boss: ' + parsed.error);
    else if (parsed.chat) addA(parsed.chat, parsed.isHtml);
  } catch(e) {
    rmTyp(tid);
    addA('Ran into an issue boss: ' + e.message);
  }
}

function onKey(e){if(e.key==='Enter')send(false);}
function onKey2(e){if(e.key==='Enter')send(true);}




/* ══════════════════════════════════════
   TEXT-TO-SPEECH
══════════════════════════════════════ */
let ttsEnabled=false;
let ttsVoice=null;

// Pre-load voices and pick best female English voice
function loadTTSVoice(){
  const pick=()=>{
    const voices=window.speechSynthesis.getVoices();
    // Priority: Google UK English Female > any female > any English
    ttsVoice=
      voices.find(v=>/google uk english female/i.test(v.name))||
      voices.find(v=>/female/i.test(v.name)&&/en/i.test(v.lang))||
      voices.find(v=>/en/i.test(v.lang)&&v.name.toLowerCase().includes('zira'))||
      voices.find(v=>/en/i.test(v.lang)&&v.name.toLowerCase().includes('samantha'))||
      voices.find(v=>/en/i.test(v.lang))||null;
  };
  pick();
  if(window.speechSynthesis.onvoiceschanged!==undefined)
    window.speechSynthesis.onvoiceschanged=pick;
}
loadTTSVoice();

function toggleSpeak(){
  ttsEnabled=!ttsEnabled;
  if(!ttsEnabled) window.speechSynthesis.cancel(); // stop any playing
  // Sync both buttons (hero + bottom)
  ['btn-spk','btn-spk2'].forEach(id=>{
    const b=document.getElementById(id);
    if(!b) return;
    b.classList.toggle('active',ttsEnabled);
    b.title=ttsEnabled?'Read aloud (on)':'Read aloud (off)';
    b.setAttribute('aria-label',ttsEnabled?'Read aloud (on)':'Read aloud (off)');
    // Swap icon
    b.innerHTML=ttsEnabled?'<i data-lucide="volume-2"></i>':'<i data-lucide="volume-x"></i>';
    lucide.createIcons({nodes:b.querySelectorAll('[data-lucide]')});
  });
  toast(ttsEnabled?'Speak mode on':'Speak mode off');
}

function speakText(txt){
  if(!ttsEnabled||!txt) return;
  window.speechSynthesis.cancel(); // cancel any ongoing speech
  const utt=new SpeechSynthesisUtterance(txt);
  if(ttsVoice) utt.voice=ttsVoice;
  utt.lang='en-US';
  utt.rate=1.0;  // natural speed
  utt.pitch=1.1; // slightly higher = more feminine if no female voice found
  utt.volume=1;
  window.speechSynthesis.speak(utt);
}

/* ══════════════════════════════════════
   VOICE
══════════════════════════════════════ */
let voiceRec=null, mediaRecorder=null, audioChunks=[];
let isVoiceCancelled = false;

async function startVoice(){
  document.getElementById('voice-ov').classList.add('open');
  document.getElementById('voice-interim').innerHTML='Listening...';
  isVoiceCancelled = false;
  
  if('webkitSpeechRecognition'in window || 'SpeechRecognition'in window){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    voiceRec=new SR();voiceRec.lang='en-US';voiceRec.interimResults=true;voiceRec.continuous=false;
    voiceRec.onresult=e=>{
      let interim='',final='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        if(e.results[i].isFinal) final+=e.results[i][0].transcript;
        else interim+=e.results[i][0].transcript;
      }
      document.getElementById('voice-interim').textContent=interim||final;
      if(final){
        const id=chatOn?'cmd2':'cmd';
        document.getElementById(id).value=final;
        closeVoice();send(chatOn);
      }
    };
    voiceRec.onerror=()=>closeVoice();voiceRec.onend=()=>closeVoice();
    try { voiceRec.start(); return; } catch(e) {}
  }
  
  // Whisper Fallback via WebRTC
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    const useWebm = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm');
    const ext = useWebm ? 'webm' : 'm4a';
    const finalMime = useWebm ? 'audio/webm' : 'audio/mp4';
    
    document.getElementById('voice-interim').innerHTML='Listening...<br><span style="opacity:0.7;font-size:12px;margin-top:4px;display:block">Talk, then tap mic again to send!</span>';
    
    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (isVoiceCancelled) { closeVoice(); return; }
      
      document.getElementById('voice-interim').textContent='Thinking...';
      const audioBlob = new Blob(audioChunks, { type: finalMime });
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
         const base64data = reader.result.split(',')[1];
         try {
           const r = await fetch(`${API_BASE}/api/transcribe`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ audioBase64: base64data, ext })
           });
           const ans = await r.json();
           if (ans.error) throw new Error(ans.error);
           const final = ans.text.trim();
           if (final) {
             const id=chatOn?'cmd2':'cmd';
             document.getElementById(id).value=final;
             send(chatOn);
           }
         } catch(err) { toast('Voice error: ' + err.message); }
         closeVoice();
      };
    };
    mediaRecorder.start();
  } catch(e) {
    toast('Microphone access denied or unsupported');
    closeVoice();
  }
}
function cancelVoice() {
  isVoiceCancelled = true;
  stopVoice();
}
function stopVoice(){
  if(voiceRec) { try{voiceRec.stop();}catch(e){} voiceRec=null; }
  if(mediaRecorder && mediaRecorder.state !== "inactive") { mediaRecorder.stop(); mediaRecorder=null; }
  else closeVoice();
}
function closeVoice(){
  document.getElementById('voice-ov').classList.remove('open');
  document.getElementById('voice-interim').textContent='';
}

/* ══════════════════════════════════════
   SETTINGS DIALOG
══════════════════════════════════════ */
function openDlg(){
  document.getElementById('dlg-epq').value='';
  renderDlgEnt();renderSelChips();
  document.getElementById('dlg-ov').classList.add('open');
}
function closeDlg(){document.getElementById('dlg-ov').classList.remove('open');}
function ovClick(e){if(e.target===e.currentTarget)closeDlg();}
async function saveDlg(){
  const saved=await saveConfig();
  closeDlg();
  toast(saved?'Saved to config.json':'Saved');
}

function renderDlgEnt(){
  const q=(document.getElementById('dlg-epq').value||'').toLowerCase().trim();
  const list=q
    ?ENTITIES.filter(e=>e.name.toLowerCase().includes(q)||e.entity_id.toLowerCase().includes(q)||e.domain.toLowerCase().includes(q))
    :ENTITIES.slice(0,100);
  const el=document.getElementById('dlg-ent-list');
  if(!list.length){
    el.innerHTML=`<div style="padding:16px;font-size:13px;color:var(--txt3);text-align:center">${ENTITIES.length?'No results.':'Connect to HA first.'}</div>`;
    return;
  }
  el.innerHTML=list.map(e=>{
    const isSel=SELECTED.has(e.entity_id);
    const addIco=isSel?'<i data-lucide="check"></i>':'<i data-lucide="plus"></i>';
    return`<div class="de-r">
      <div class="de-ico"><i data-lucide="${dico(e.domain)}"></i></div>
      <div class="de-inf"><div class="de-nm" title="${esc(e.name)}">${esc(e.name)}</div><div class="de-id">${esc(e.entity_id)}</div></div>
      <button class="de-pb${isSel?' sel':''}" onclick="dlgToggleSel('${e2(e.entity_id)}')" title="${isSel?'Remove':'Add'}">${addIco}</button>
    </div>`;
  }).join('');
  document.getElementById('sc-count').textContent=SELECTED.size;
  lucide.createIcons({nodes:el.querySelectorAll('[data-lucide]')});
}

function dlgToggleSel(eid){
  if(SELECTED.has(eid)) SELECTED.delete(eid); else SELECTED.add(eid);
  renderDlgEnt();renderSelChips();
}
function renderSelChips(){
  document.getElementById('sc-count').textContent=SELECTED.size;
  const c=document.getElementById('scc');
  if(!SELECTED.size){c.innerHTML='<span class="se">No devices selected — use + above to add.</span>';return;}
  c.innerHTML=[...SELECTED].map(id=>{
    const e=ENTITIES.find(x=>x.entity_id===id);
    return`<span class="sc">${esc(e?e.name:id)}<button onclick="removeSel('${e2(id)}')" title="Remove"><i data-lucide="x"></i></button></span>`;
  }).join('');
  lucide.createIcons({nodes:c.querySelectorAll('[data-lucide]')});
}
function removeSel(eid){SELECTED.delete(eid);renderDlgEnt();renderSelChips();}

/* ══════════════════════════════════════
   TOAST
══════════════════════════════════════ */
let tt;
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('show'),2600);}

/* ══════════════════════════════════════
   UTILS
══════════════════════════════════════ */
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function e2(s){return String(s).replace(/'/g,"\\'");}

/* ══════════════════════════════════════
   BOOT 
══════════════════════════════════════ */
(async()=>{
  await loadConfig();
  await loadEnt();
})();