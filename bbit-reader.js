

async function __withTimeout(promise, ms, label){
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error((label||'op')+'-timeout')), ms||7000))
  ]);
}
import { BoardShim, BrainFlowInputParams, BoardIds } from 'brainflow';
import { BandPowerEstimator } from './bbit-bandpower.js';
import fs from 'fs';

import http from 'http';
import url from 'url';
import path from 'path';

// --- Simple SSE server for realtime JSON ---
const SSE_PORT = 8080;
const sseClients = new Set();

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);

  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Serve a simple HTML dashboard if present
  const file = pathname === '/' ? '/live.html' : pathname;
  const full = path.join(process.cwd(), file);
  try {
    const st = fs.statSync(full);
    if (st.isFile()) {
      const ext = path.extname(full).toLowerCase();
      const type = ext === '.html' ? 'text/html' : 'text/plain';
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(full).pipe(res);
      return;
    }
  } catch (_) {}
  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('Not found');
});

server.listen(SSE_PORT, () => {
  console.log('SSE server listening on http://localhost:' + SSE_PORT);
});

function sseBroadcast(obj){
  // Send as SSE "eeg" event; also log to console for debugging
  const line = `event: eeg\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(line);
  try { console.log("EEG payload:", JSON.stringify(obj)); } catch {}
}


// --- Composite channel builder for EEG JAM ---
function combineChannels(data, chIndices, mode){
  const rows = chIndices.map(ch => data[ch]).filter(r => Array.isArray(r) && r.length);
  if (!rows.length) return null;
  const len = Math.min(...rows.map(r => r.length));
  if (len <= 0) return null;
  const median = (arr) => { const a = arr.slice().sort((x,y)=>x-y); const m=a.length>>1; return (a.length%2)?a[m]:0.5*(a[m-1]+a[m]); };
  const out = new Array(len);
  mode = (mode||'mean').toLowerCase();
  if (mode === 'median'){
    for (let t=0;t<len;t++){ const vals = rows.map(r=>r[t]); out[t] = median(vals); }
  } else if (mode === 'weighted'){
    const weights = rows.map(r => {
      let mean=0; for (let t=0;t<len;t++) mean+=r[t]; mean/=len;
      let sq=0; for (let t=0;t<len;t++){ const d=r[t]-mean; sq+=d*d; }
      const rms = Math.sqrt(sq/Math.max(1,len));
      const w = 1/Math.max(5, rms);
      return Math.min(w, 1/5);
    });
    const sumw = weights.reduce((a,b)=>a+b,0) || 1;
    for (let t=0;t<len;t++){ let s=0; for (let i=0;i<rows.length;i++) s+=weights[i]*rows[i][t]; out[t]=s/sumw; }
  } else {
    for (let t=0;t<len;t++){ let s=0; for (let i=0;i<rows.length;i++) s+=rows[i][t]; out[t]=s/rows.length; }
  }
  return out;
}


// Mid-line above middle panel: default ╦, but use ╧ at double→single junctions


const midBorderUpper = (w, connectors) => {
  const a = ('╠' + '═'.repeat(w) + '╣').split('');
  const idx = connectors.map(p => 1 + p);
  for (let i=0;i<idx.length;i++){
    const k = idx[i];
    if (a[k] === '═') a[k] = (i===1 ? '╪' : '╬'); // keep the classic look for the 2nd junction
  }
  return GRAY + a.join('') + RESET;
};


// Mid-line below middle panel: default ╩, but use ╧ at double→single junctions


const midBorderLower = (w, connectors) => {
  const a = ('╠' + '═'.repeat(w) + '╣').split('');
  const idx = connectors.map(p => 1 + p);
  for (let i=0;i<idx.length;i++){
    const k = idx[i];
    if (a[k] === '═') a[k] = (i===idx.length-1 ? '╧' : '╬'); // end with ╧ as requested
  }
  return GRAY + a.join('') + RESET;
};




// -------- Config --------
let cfg = {
  app_title: 'BBit Reader',
  mode: 'native',
  serial: '',
  mains: 50,
  bled_port: 'COM4',
  channel_index: 0,
  refresh_ms: 180,
  top_bar_width: 36,
  history_window_width: 36,
  right_panel_width: 20,
  calibration_seconds: 60,
  channel_labels: ["T3","T4","O1","O2"]
};
try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync('config.json','utf-8'))); }
catch (e) { /* ignore missing/invalid config */ }

// -------- Globals --------
const REFMS = Number(cfg.refresh_ms)||180;

let NO_CONTACT = false;
let CALIBRATED = false;

let FINAL_SCORE = null;
let CAL2_PHASE = -1; let CAL2_T0 = 0;
let CAL2_BEEPED_START=false, CAL2_BEEPED_SWITCH=false, CAL2_BEEPED_END=false;
const CAL_OPEN_SEC = 30, CAL_CLOSED_SEC = 30;
function beep(){ try { process.stdout.write('\x07'); } catch(_){} }

let noContactTicks = 0;
let NO_CONTACT_THRESHOLD_TICKS = 0; // set after REFMS known
let BAR_W   = Number(cfg.top_bar_width)||36;
let HIST_W  = Number(cfg.history_window_width)||BAR_W;
let RP_W    = Number(cfg.right_panel_width)||20;
const CAL_SECS = Number(cfg.calibration_seconds)||60;
NO_CONTACT_THRESHOLD_TICKS = Math.max(2, Math.ceil(2000/REFMS));

const CH_LABELS = Array.isArray(cfg.channel_labels) ? cfg.channel_labels : ["T3","T4","O1","O2"];
const APP_LABEL = (cfg.app_title||'BBit Reader');
// -------- Session state (player/game/session logging) --------
let APP_STATE = 'idle'; // 'idle' | 'await_player' | 'calibrating' | 'post_cal' | 'await_game' | 'measuring'
let INPUT_MODE = null;  // null | 'player' | 'game'
let INPUT_BUF = '';
let PLAYER_ID = null;   // number or string
let GAME_ID = null;     // number or string
let MEASURE_START_TS = 0;
let MEASURE_TIMER = null;
let LOG_ROWS = [];
let SESSION_MS = 5*60*1000; // 5 minutes

const csvHeader = [
  'time_ms','delta','theta','alpha','beta','gamma',
  'absDelta','absTheta','absAlpha','absBeta','absGamma',
  'EI','SC','DR','HB','score','no_contact'
].join(',');

function pad2(x){ const s=String(x||''); return s.length<2 ? ('0'+s) : s; }
function sessionFilename(){ return `G${pad2(GAME_ID)}-P${pad2(PLAYER_ID)}.log`; }

function startPrompt(mode){
  INPUT_MODE = mode; INPUT_BUF = '';
  if (mode==='player') APP_STATE = 'await_player';
  if (mode==='game')   APP_STATE = 'await_game';
}

function cancelPrompt(){
  INPUT_MODE = null; INPUT_BUF = '';
  if (CALIBRATED) APP_STATE = 'post_cal'; else APP_STATE = 'idle';
}

function startMeasurement(){
    if (cfg && cfg.auto_ids){
    if (typeof PLAYER_ID==='undefined' || !PLAYER_ID){ PLAYER_ID = 'P' + Math.floor(100000+Math.random()*900000); }
    if (typeof GAME_ID==='undefined'   || !GAME_ID){   GAME_ID   = 'G' + Math.floor(100000+Math.random()*900000); }
  }
if (!CALIBRATED) return;
  if (PLAYER_ID==null || PLAYER_ID==='') startPrompt('player');
  else {
    if (GAME_ID==null || GAME_ID==='') startPrompt('game');
    else {
      APP_STATE = 'measuring';
      MEASURE_START_TS = Date.now();
      LOG_ROWS = [csvHeader];
      if (MEASURE_TIMER) clearTimeout(MEASURE_TIMER);
      MEASURE_TIMER = setTimeout(()=> endSession('timeout'), SESSION_MS);
    }
  }
}

function endSession(reason){
  if (APP_STATE!=='measuring') return;
  const fname = (typeof sessionFilename==='function') ? sessionFilename() : 'Gyy-Pxx.log';
  // Compute final score (average of per-row score where no_contact==0)
  (function(){
    try {
      const rows = (Array.isArray(LOG_ROWS) && LOG_ROWS.length>1) ? LOG_ROWS.slice(1) : [];
      let sum = 0, n = 0, any = 0;
      for (const line of rows){
        const cols = String(line).split(',');
        if (cols.length >= 17){
          const sc = parseFloat(cols[15]);
          const nc = parseInt(cols[16],10);
          if (!Number.isNaN(sc)){
            any++;
            if (!nc){ sum += sc; n++; }
          }
        }
      }
      let avg = null;
      if (n>0) avg = sum / n;
      else if (any>0){
        let sum2 = 0; let n2 = 0;
        for (const line of rows){
          const cols = String(line).split(',');
          if (cols.length >= 16){
            const sc = parseFloat(cols[15]);
            if (!Number.isNaN(sc)){ sum2 += sc; n2++; }
          }
        }
        avg = n2>0 ? (sum2/n2) : 0;
      } else {
        avg = 0;
      }
      FINAL_SCORE = avg;
      if (Array.isArray(LOG_ROWS)){
        LOG_ROWS.push('');
        LOG_ROWS.push('final_score,' + (Number.isFinite(FINAL_SCORE)? FINAL_SCORE.toFixed(3) : 'NaN'));
      }
    } catch(e){ /* noop */ }
  })();
  try { fs.writeFileSync(fname, (Array.isArray(LOG_ROWS)?LOG_ROWS:[]).join('\n'), 'utf8'); } catch(e){}
  APP_STATE = 'post_cal';
  MEASURE_START_TS = 0;
  LOG_ROWS = [];
  GAME_ID = null; // require game id per measurement
  if (MEASURE_TIMER){ clearTimeout(MEASURE_TIMER); MEASURE_TIMER=null; }
}

// Dynamic bottom help / prompt
function headerHelp(){
  const baseNoR = '(C)alibrate (P)ause (Q)uit';
  const baseWithR = '(C)alibrate (P)ause (Q)uit (R)ecord';
  return CALIBRATED ? baseWithR : baseNoR;
}
function blinkDot(){
  const on = (Math.floor(Date.now()/500)%2)===0;
  return on ? (RED+'●'+RESET) : ' ';
}



function headerInfoLine(){
  const pDisp = (PLAYER_ID==null || PLAYER_ID==='') ? '--' : pad2(PLAYER_ID);
  const gDisp = (GAME_ID==null || GAME_ID==='') ? '--' : pad2(GAME_ID);
  const st = statusText();
  const dot = (APP_STATE==='measuring') ? (' '+blinkDot()) : '';
  return `Player P${pDisp}  •  Game G${gDisp}  •  ${st}${dot}`;
}

function headerPromptLine(){
  if (INPUT_MODE==='player'){ const cur=((Math.floor(Date.now()/500)%2)===0?'_':' '); return `Enter player # (xx): ${INPUT_BUF}${cur}`; }
  if (INPUT_MODE==='game'){ const cur=((Math.floor(Date.now()/500)%2)===0?'_':' '); return `Enter game # (yy): ${INPUT_BUF}${cur}`; }
  if (INPUT_MODE==='time'){ const cur=((Math.floor(Date.now()/500)%2)===0)?'_':' '; return 'Seconds: ' + String(INPUT_BUF) + String(cur); }
  return '';
}

function controlHelp(){
  // kept for compatibility; not shown anymore at bottom
  return headerHelp();
}

// -------- Colors --------
const RESET='\x1b[0m', GRAY='\x1b[90m', RED='\x1b[91m', YEL='\x1b[93m', ORN='\x1b[38;5;208m', GRN='\x1b[92m';
const COLORS={ Delta:{dark:'\x1b[36m',bright:'\x1b[96m'}, Theta:{dark:'\x1b[34m',bright:'\x1b[94m'}, Alpha:{dark:'\x1b[32m',bright:'\x1b[92m'}, Beta:{dark:'\x1b[33m',bright:'\x1b[93m'}, Gamma:{dark:'\x1b[35m',bright:'\x1b[95m'} };
const BANDS=['Delta','Theta','Alpha','Beta','Gamma'];
function rpLine(i){
  // After calibration, show the four requested EEG metrics in the right panel.
  // Otherwise, fall back to the original menu.
  const fmt = (x) => (typeof x === 'number' && isFinite(x)) ? x.toFixed(2) : '--';
  const readyToShow = (typeof CALIBRATED!=='undefined' && CALIBRATED===true) && 
                      (typeof APP_STATE!=='undefined' && APP_STATE!=='measuring' && APP_STATE!=='calibrating') &&
                      (!INPUT_MODE || INPUT_MODE==='');
  if (readyToShow && typeof smooth !== 'undefined' && smooth){
    if (i===0) return `EI  (beta/(alpha+theta)) : ${fmt(smooth.EI)}`;
    if (i===1) return `SC  (SMR/high beta)     : ${fmt(smooth.SC)}`;
    if (i===2) return `DR  (theta/alpha)       : ${fmt(smooth.DR)}`;
    if (i===3) return `HB  (20–30 Hz power)    : ${fmt(smooth.HB)}`;
    return '';
  }
  // --- Original menu behavior (fallback) ---
  const p = (!PLAYER_ID||PLAYER_ID==='') ? '###' : (String(PLAYER_ID).padStart(3,'0').slice(-3));
  const g = (!GAME_ID  ||GAME_ID  ==='') ? '###' : (String(GAME_ID).padStart(3,'0').slice(-3));
  if (i===0) return '(P)layer: ' + p;
  if (i===1) return '(S)ession: ' + g;
  if (i===2) return '(C)alibrate';
  if (i===3) return '(M)easure';
  if (i===4) return '(Q)uit';
  if (i===5) return '(T)ime';
  return '';
}

let G_PCT = 0;
function statusText(){
  // Show percentage while calibrating
  if (APP_STATE==='calibrating'){
    const total = (typeof CAL_OPEN_SEC!=='undefined' ? (CAL_OPEN_SEC||30) : 30) + (typeof CAL_CLOSED_SEC!=='undefined' ? (CAL_CLOSED_SEC||30) : 30);
    const elapsed = (typeof CAL2_T0!=='undefined' && CAL2_T0) ? Math.max(0, (Date.now()-CAL2_T0)/1000) : Math.max(0, (typeof calTime!=='undefined' ? (calTime||0) : 0));
    const pct = Math.max(0, Math.min(100, Math.round(100*elapsed/Math.max(1,total))));
    return `Calibrating: ${pct}%`;
  }
  // Measuring countdown
  if (APP_STATE==='measuring'){
    const t = Date.now() - (typeof MEASURE_START_TS!=='undefined' ? MEASURE_START_TS : Date.now());
    const rem = Math.max(0, (typeof SESSION_MS!=='undefined' ? SESSION_MS : 0) - t);
    const m = Math.floor(rem/60000);
    const s = Math.floor((rem%60000)/1000).toString().padStart(2,'0');
    const dot = ((Math.floor(Date.now()/500)%2)===0 ? (RED+'●'+RESET) : ' ');
    return `Measuring ${m}:${s}${' ' + dot}`;
  }
  // After calibration finished and a score exists
  if (APP_STATE==='post_cal' && typeof FINAL_SCORE!=='undefined' && FINAL_SCORE!=null){
    return `Final ${Math.round(FINAL_SCORE)}`;
  }
  // Idle/ready state
  if (CALIBRATED && APP_STATE!=='measuring' && APP_STATE!=='calibrating' && !INPUT_MODE) return 'Ready';
  return 'Device state';
}
function infoRP(){
  const pDisp = (PLAYER_ID==null || PLAYER_ID==='') ? '--' : pad2(PLAYER_ID);
  const gDisp = (GAME_ID==null || GAME_ID==='') ? '--' : pad2(GAME_ID);
  if (INPUT_MODE==='player') return `P?? G${gDisp} • Enter player: ${INPUT_BUF}`;
  if (INPUT_MODE==='time')   return 'Seconds: ' + String(INPUT_BUF);
  if (INPUT_MODE==='game')   return `P${pDisp} G?? • Enter game: ${INPUT_BUF}`;
  return `P${pDisp} G${gDisp} • ${statusText()}`;
}
const histChars=['▁','▂','▃','▄','█'];
const ANSI_REGEX=/\x1b\[[0-9;]*m/g;
const padCenter=(t,w)=>{const r=String(t||'');const v=r.replace(ANSI_REGEX,'').length;const p=Math.max(0,w-v);const L=Math.floor(p/2),R=p-L;return ' '+' '.repeat(L)+r+' '.repeat(R)+' ';};
const titleRow=(w,t)=>{const b=padCenter(t,w);return GRAY+'║'+RESET+b+GRAY+'║'+RESET;};
const vlen=s=>s.replace(ANSI_REGEX,'').length;

// -------- Layout --------
const LABEL_W = 10;
const VAL_W   = 8;

// Helpers

const sensorArrow = (label)=>{
  const L = (label||'').toUpperCase().trim();
  // tolerant matching: contains substring
  if (L.includes('T3') || L.includes('FP1')) return '◤'; // front-left
  if (L.includes('T4') || L.includes('FP2')) return '◥'; // front-right
  if (L.includes('O1')) return '◣'; // back-left
  if (L.includes('O2')) return '◢'; // back-right
  return ' '; // keep width stable
};

const gline=(s)=> GRAY + s + RESET;
const padAnsi=(s,w)=>{ const inner=Math.max(0,w-2); const raw=(s??''); const vis=vlen(raw); const pad=Math.max(0,inner-vis); return ' '+raw+' '.repeat(pad)+' '; };
const padAnsiRight=(s,w)=>{
  const inner=Math.max(0,w-2);
  const raw=String(s);
  const vis=raw.replace(ANSI_REGEX,'').length;
  const pad=Math.max(0, inner - vis);
  return ' ' + ' '.repeat(pad) + raw + ' ';
};

const barLine=(name,val,w)=>{ const inner=Math.max(0,w-2); const filled=Math.max(0,Math.min(inner,Math.round(val*inner))); const empty=Math.max(0,inner-filled); return ' ' + (COLORS[name].bright + '█'.repeat(filled) + RESET + ' '.repeat(empty)) + ' '; };
const histCell=(name, levels, inner)=>{ let s=' '; for(let i=0;i<inner;i++){ const lvl=levels[i]??0; s += (lvl>=3?COLORS[name].bright:COLORS[name].dark)+histChars[lvl]+RESET; } return s+' '; };

// Borders with proper connectors (compute then color)

const topBorder = (w, connectors) => {
  const a = ('╔' + '═'.repeat(w) + '╗').split('');
  const [A,B,C] = connectors.map(p => 1 + p);
  // A1 stays ╦, swap B1<->C1 so B1=╤, C1=╦
  if (a[A] === '═') a[A] = '╦';
  if (a[B] === '═') a[B] = '╤';  // B1 after swap
  if (a[C] === '═') a[C] = '╦';  // C1 after swap
  return GRAY + a.join('') + RESET;
};


const botBorder = (w, connectors) => {
  const a = ('╚' + '═'.repeat(w) + '╝').split('');
  const [A,B,C] = connectors.map(p => 1 + p);
  // before swap: B4=╩, C4=═; swap -> B4=═, C4=╩
  if (a[A] === '═') a[A] = '╩';   // A4 stays ╩
  // B4 leave '═' (do nothing)
  if (a[C] === '═') a[C] = '╩';   // C4 after swap
  return GRAY + a.join('') + RESET;
};


const detectNoContact = (contactBuf) => {
  // OFF if EITHER:
  //  (a) all channels very low RMS (< 1 µV)  -> likely powered but no skin contact / streaming zeros
  //  (b) all channels very high RMS (> 120 µV) -> floating electrodes / cable noise after removal
  if (!Array.isArray(contactBuf) || !contactBuf.length) return false;
  const LOW = 1.0, HIGH = 120.0; // microvolts
  let allLow = true, allHigh = true;
  for (let i=0; i<contactBuf.length; i++){
    const arr = contactBuf[i];
    if (!arr || !arr.length) return false;
    let mean = 0;
    for (let k=0; k<arr.length; k++) mean += arr[k];
    mean /= arr.length;
    let sq = 0;
    let mn = +Infinity, mx = -Infinity;
    for (let k=0; k<arr.length; k++){
      const v = arr[k];
      const d = v - mean;
      sq += d*d;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const rms_uV = Math.sqrt(sq / arr.length) * 1e6;
    // Treat extreme DC drift / floating (very large peak-to-peak) as high-noise too
    const p2p_uV = (mx - mn) * 1e6;
    const tooHigh = (rms_uV > HIGH) || (p2p_uV > 500); // >500 µV p2p is unphysiological for EEG here
    if (rms_uV >= LOW) allLow = false;
    if (!tooHigh) allHigh = false;
  }
  return allLow || allHigh;
};




const fmtPct = (val)=> (Math.round(val*100).toString().padStart(3)+'%');
function fmtPctDisplay(v){ return fmtPct(v); }
const fmtAbs = (x)=> { let s=(Math.abs(x)<1e-99?0:x).toExponential(1); if (s.length> (VAL_W-2)) s = s.slice(0, VAL_W-2); return s; };

const buildTopRow=(name, val, rightText)=>{
  const labelCell=padAnsi(name,LABEL_W);
  const barCell=barLine(name,val,BAR_W);
  const valCell=padAnsiRight(fmtPctDisplay(val),VAL_W);
  const rpCell=padAnsi(rightText||'',RP_W);
  return GRAY+'║'+RESET+labelCell+GRAY+'║'+RESET+barCell+GRAY+'│'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
};
const buildHistRow=(name, levels, absVal, rightText='')=>{
  const labelCell=padAnsi(name,LABEL_W);
  const inner=Math.max(0,BAR_W-2);
  const barCell=histCell(name,levels,inner);
  const valCell=padAnsi(fmtAbs(absVal),VAL_W);
  const rpCell=padAnsi(rightText||'',RP_W);
  return GRAY+'║'+RESET+labelCell+GRAY+'║'+RESET+barCell+GRAY+'│'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
};




const flatScoreCell=(levels, inner)=>{
  // Flat bar with half-height glyph; color reflects score
  const glyph = '█';
  let s=' ';
  const start = Math.max(0, levels.length - inner);
  const pad = Math.max(0, inner - (levels.length - start));
  s += ' '.repeat(pad);
  for (let i=start; i<levels.length; i++){
    const sc = levels[i] ?? 0; // 0..100
    const color = (sc>=65) ? GRN : (sc>=45 ? ORN : RED);
    s += color + glyph + RESET;
  }
  return s + ' ';
};


const buildScoreHistRow=(levels, currentScore, rightText='')=>{
  const labelCell=padAnsi('Score', LABEL_W);
  const inner=Math.max(0, BAR_W-2);
  const barCell=flatScoreCell(levels, inner);
  const valStr=(currentScore!=null?Number(currentScore).toFixed(0):'--')+' pts';
  const valCell=padAnsiRight(valStr, VAL_W);
  const rpCell=padAnsi(rightText||'',RP_W);
  return GRAY+'║'+RESET+labelCell+GRAY+'║'+RESET+barCell+GRAY+'║'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
};

const buildSensorsRow=(sensorsText, rightText)=>{
  const labelCell=padAnsi('Sensors',LABEL_W);
  const mergedWidth=BAR_W+1+VAL_W;
  const sensorsCell=padAnsi(sensorsText,mergedWidth);
  const rpCell=padAnsi(rightText||'',RP_W);
  return GRAY+'║'+RESET+labelCell+GRAY+'║'+RESET+sensorsCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
};

const enterAltBuffer=()=>{ process.stdout.write('\x1b[?1049h'); process.stdout.write('\x1b[?25l'); };
const leaveAltBuffer=()=>{ process.stdout.write('\x1b[?25h'); process.stdout.write('\x1b[?1049l'); };

let prevLines = [];
const printlnFixed=(s)=>{ process.stdout.write(s + '\r\n'); };
const render=(lines)=>{
  process.stdout.write('\x1b[H');
  printlnFixed(APP_LABEL);
  printlnFixed('');
  for (let i=0;i<lines.length;i++){
    const curr = lines[i], prev = prevLines[i];
    if (curr !== prev) printlnFixed(curr); else process.stdout.write('\x1b[B');
  }
  process.stdout.write('\x1b[J');
  prevLines = lines;
};


async function main(){
  console.log('BBit Reader v.8.1');
  console.log('Connecting (15s)');

  const params=new BrainFlowInputParams();
  let boardId;
  let noData=false;
  if (cfg.mode==='native'){ boardId=BoardIds.BRAINBIT_BOARD; if (cfg.serial) params.serial_number=cfg.serial; }
  else { boardId=BoardIds.BRAINBIT_BLED_BOARD; params.serial_port=cfg.bled_port; }
  const board=new BoardShim(boardId, params);

  (async()=>{
  try { await board.prepareSession(); await board.startStream(); }
  catch(e){ console.error('Device connect failed, NO DATA:', (e && (e.message||e)) || e); noData=true; }
})();

  enterAltBuffer();

  try {
    const fsr=BoardShim.getSamplingRate(boardId);
    const eegCh=BoardShim.getEegChannels(boardId);
    const ch=eegCh[Math.max(0,Math.min(Number(cfg.channel_index)||0, eegCh.length-1))];

    const sensorsSample = eegCh.map((_,i)=>`${(CH_LABELS[i]||('T'+(i+1)))}:${(0).toFixed(3)}`).join('  ');
    let BAR_Wcfg = BAR_W;
    BAR_W = Math.max(BAR_Wcfg, vlen(sensorsSample)+2);
    HIST_W = BAR_W;
    const LEFT_W = LABEL_W + 1 + BAR_W + 1 + VAL_W;
    const TOTAL_W = LEFT_W + 1 + RP_W;
    const CONNECTORS = [LABEL_W, LABEL_W+1+BAR_W, LEFT_W];

    const est=new BandPowerEstimator({ fs:fsr, overlap:0.5, minHz:1, maxHz:30, notchHz:Number(cfg.mains)||50, notchWidth:1 });
    const rel={}, absVals={Delta:0,Theta:0,Alpha:0,Beta:0,Gamma:0};
    const levels={Delta:[],Theta:[],Alpha:[],Beta:[],Gamma:[]};
    const scoreLevels=[];
    let latestV=new Array(eegCh.length).fill(0);

    const contactBuf = eegCh.map(()=>[]);
    const qualityColor=(rms_uV)=> rms_uV < 1.0 ? ORN : (rms_uV > 120 ? RED : GRN);

    let calTime=0, calibrated=false; CALIBRATED = calibrated;
    const calBuf=[]; const baseline={mu:{},sigma:{}};
    const smooth={ EI:null, SC:null, DR:null, HB:null, score:null };
    const session={ total:0, green:0, artifacts:0, longestGreen:0, currentGreen:0, last15:[] };

    process.stdin.setRawMode && process.stdin.setRawMode(true);
    process.stdin.resume();
    let paused=false;
    process.stdin.on('data', (buf) => {

  const s = String(buf);
  const c = s.toLowerCase();

  if (typeof INPUT_MODE !== 'undefined' && INPUT_MODE){
    if (c === '\r' || c === '\n'){
      if (INPUT_MODE==='player'){ PLAYER_ID = INPUT_BUF || PLAYER_ID || ''; APP_STATE='idle'; }
      else if (INPUT_MODE==='game'){ GAME_ID = INPUT_BUF || GAME_ID || ''; APP_STATE='idle'; }
      else if (INPUT_MODE==='time'){
        var sec = parseInt(String(INPUT_BUF||'').trim(),10);
        if (isFinite(sec) && sec>0) { SESSION_MS = sec*1000; }
        APP_STATE='idle';
      }
      INPUT_MODE=''; INPUT_BUF=''; return;
    }
    if (c === '\x08' || c === '\x7f'){ INPUT_BUF = INPUT_BUF.slice(0,-1); return; }
    if (/^[A-Za-z0-9_-]$/.test(c)){ INPUT_BUF += c; return; }
    return;
  }

  if (c==='p'){ startPrompt('player'); return; }
  if (c==='s'){ startPrompt('game'); return; }
  if (c==='m'){ startMeasurement(); return; }
  if (c==='t'){ startPrompt('time'); return; }
  if (c==='r'){
    if (!CALIBRATED){ return; }
    if (!PLAYER_ID){ startPrompt('player'); return; }
    if (!GAME_ID){ startPrompt('game'); return; }
    if (APP_STATE!=='measuring'){ startMeasurement(); return; }
    endSession('key'); return;
  }
  if (c==='c'){
    calibrated=false; CALIBRATED=calibrated; calTime=0;
    if(Array.isArray(calBuf)) calBuf.length=0;
    if (baseline && baseline.mu) baseline.mu = {};
    if (baseline && baseline.sigma) baseline.sigma = {};
    CAL2_PHASE=0; CAL2_T0=Date.now();
    CAL2_BEEPED_START=false; CAL2_BEEPED_SWITCH=false; CAL2_BEEPED_END=false;
    beep(); CAL2_BEEPED_START=true;
    APP_STATE='calibrating';
    return;
  }
  if (c==='q'){ if(APP_STATE==='measuring'){ endSession('key'); return;} leaveAltBuffer(); process.exit(0); }
  if (c===' '){ paused = !paused; return; }
  if (c==='\t'){ muted = !muted; return; }
});


    const topPanelLines=()=>{
      if (!calibrated){
        const remain=Math.max(0, CAL_SECS - Math.floor(calTime));
        const blink = (Math.floor(Date.now()/500)%2)===0;
        const title = blink ? (YEL+'Calibration'+RESET) : 'Calibration';
        return [title,'Stay calm with','open eyes and','listen to audio']; // 4 lines only
      } else {
        const score=Math.round(smooth.score??0);
        const dot = score>=65 ? (GRN+'●'+RESET) : score>=45 ? (ORN+'●'+RESET) : (RED+'●'+RESET);
        const trend = (()=>{ const a=session.last15[0]??0, b=session.last15[session.last15.length-1]??0; const d=b-a; return d>0.15?'↑':d<-0.15?'↓':'→'; })();
        const gPct = session.total? Math.round(100*session.green/session.total) : 0;
        return [`Score ${score}`, `Light ${dot}`, `Trend ${trend}`, `Green ${gPct}%`];
      }
    };
    ;

const midPanelLines=()=>{const raw=(k)=>{const v=(typeof smooth==='object'&&smooth&&smooth[k]!=null)?smooth[k]:((typeof last==='object'&&last&&last[k]!=null)?last[k]:null);return v==null?'####':(isFinite(Number(v))?Number(v).toExponential(1):'####');}; const z=(k)=>{const mu=(baseline&&baseline.mu&&baseline.mu[k])??0; const sd=(baseline&&baseline.sd&&baseline.sd[k])??1e-9;const v=(((typeof smooth==='object'&&smooth)&&smooth[k])??0)-mu; const zv=v/sd; return (zv>=0?'+':'')+zv.toFixed(1);}; if(!CALIBRATED)return['EI: '+raw('EI'),'SC: '+raw('SC'),'DR: '+raw('DR'),'OA: '+raw('HB')];return ['EI: '+z('EI'),'SC: '+z('SC'),'DR: '+z('DR'),'OA: '+z('HB')];};
function sensorsFooter(){const arr=['T3','T4','O1','O2'];const val=(k)=>{const v=(last&&last[k]!=null)?last[k]:((smooth&&smooth[k]!=null)?smooth[k]:null);return v;};const fmt=(x)=> (x==null?'---':(x>=0?'+':'')+Number(x).toFixed(3));const arrow=(x)=> (x==null?'':' '+(x<0?'\u25BC':'\u25B2'));return arr.map(k=>RED+k+RESET+arrow(val(k))+' '+fmt(val(k))).join('  ');}
const bottomPanelLine = () => {
  
  // __BLINK_UNDERSCORE_PROMPT__
  if (typeof INPUT_MODE!=='undefined' && INPUT_MODE==='player'){ const bl=(Math.floor(Date.now()/500)%2)===0; return 'Player: ' + (INPUT_BUF||'') + (bl?'_':' '); }
  if (typeof INPUT_MODE!=='undefined' && INPUT_MODE==='game'){ const bl=(Math.floor(Date.now()/500)%2)===0; return 'Session: ' + (INPUT_BUF||'') + (bl?'_':' '); }
  // __BLINK_UNDERSCORE_PROMPT__
  if (APP_STATE==='await_player'){ const bl=(Math.floor(Date.now()/500)%2)===0; return 'Player: ' + (INPUT_BUF||'') + (bl?'_':' '); }
  if (APP_STATE==='await_game'){ const bl=(Math.floor(Date.now()/500)%2)===0; return 'Session: ' + (INPUT_BUF||'') + (bl?'_':' '); }
if (APP_STATE==='calibrating'){
    const remain=Math.max(0, Math.ceil(CAL_SECS - Math.floor(calTime)));
    const elapsed = CAL2_T0 ? Math.max(0, (Date.now()-CAL2_T0)/1000) : calTime;
    const pct = Math.max(0, Math.min(100, Math.round(100*elapsed/Math.max(1,CAL_SECS))));
    const phase = elapsed<(CAL_OPEN_SEC||30) ? 'Open' : (elapsed<((CAL_OPEN_SEC||30)+(CAL_CLOSED_SEC||30)) ? 'Closed' : 'Done');
    return `Calibrating ${phase}: ${Math.max(0, Math.ceil(CAL_SECS - elapsed))}s (${pct}%)`;
  }
  if (APP_STATE==='measuring'){
    const t=Date.now()-MEASURE_START_TS; const rem=Math.max(0, SESSION_MS - t);
    const m=Math.floor(rem/60000), s=Math.floor((rem%60000)/1000).toString().padStart(2,'0');
    return `Measuring ${m}:${s} ${blinkDot()}`;
  }
  if (APP_STATE==='post_cal' && FINAL_SCORE!=null){ return `Final ${Math.round(FINAL_SCORE)}`; }
  if (CALIBRATED && APP_STATE!=='measuring' && APP_STATE!=='calibrating' && !INPUT_MODE) return 'Ready';
  return 'Ready • Press C to calibrate';
};

function composeFrame(){
  const topR = topPanelLines();
  const midR = midPanelLines();
  const botR = bottomPanelLine();

  // Build sensor voltage text and compute contact RMS
  const sensorsText = latestV.map((v,i)=>{
  const label = (CH_LABELS[i]||('T'+(i+1)));
  const arr = contactBuf[i]||[];
  // compute RMS for color
  let mean=0; for (const x of arr) mean+=x;
  mean = arr.length ? mean/arr.length : 0;
  let sq=0; for (const x of arr){ const d=x-mean; sq+=d*d; }
  const rms_uV = arr.length ? Math.sqrt(sq/arr.length)*1e6 : 0;
  const color  = qualityColor(rms_uV);
  const arrow  = sensorArrow(label);               // arrow (or ' ')
  const num    = (v??0);
  const signPad = (num>=0 ? ' ' : '');             // space for positive
  const text   = `${label}${arrow}${signPad}${num.toFixed(3)}`; // no colon
  return color + text + RESET;
}).join('  ');
// No-contact detection (robust: all-low OR all-high for ~2s)
  const offNow = detectNoContact(contactBuf);
  noContactTicks = offNow ? (noContactTicks + 1) : 0;
  NO_CONTACT     = noContactTicks >= NO_CONTACT_THRESHOLD_TICKS;
  
// --- HARD GATE: freeze everything while off ---
if (NO_CONTACT){
  if (Array.isArray(latestV)) latestV = latestV.map(() => 0);
  if (typeof smooth === 'object' && smooth){ for (const k of Object.keys(smooth)) smooth[k] = 0; }
  if (typeof rel === 'object'    && rel){    for (const k of Object.keys(rel))    rel[k]    = 0; }
  if (typeof absVals === 'object'&& absVals){ for (const k of Object.keys(absVals)) absVals[k] = 0; }
  if (Array.isArray(scoreLevels)) { scoreLevels.length = 0; }
}
const sensorsOut = NO_CONTACT ? (RED+'NOT BRAINING'+RESET) : sensorsText;

  const lines = [];
  lines.push(topBorder(TOTAL_W, CONNECTORS));
  lines.push(titleRow(TOTAL_W, APP_LABEL));
  lines.push(midBorderUpper(TOTAL_W, CONNECTORS));
  {
  const inner = Math.max(0, BAR_W-2);
  const fmin = 1, fmax = Number(cfg.spectrum_max_hz)||45;
  const stackRows = specPowerStack(est, inner, fmin, fmax);
  const blank = padAnsi('', LABEL_W);
  const valCell = padAnsiRight('', VAL_W);
  const rpIdx = [0,1,2,3]; // menu items on top 4 rows
  for (let idx=stackRows.length-1; idx>=0; idx--){
    const barCell = stackRows[idx];
    const rpLineIdx = rpIdx[stackRows.length-1 - idx]; // map top->0, next->1, ...
    const rpCell = padAnsi((rpLineIdx!=null ? (rpLine(rpLineIdx)||'') : ''), RP_W);
    lines.push(GRAY+'║'+RESET+blank+GRAY+'║'+RESET+barCell+GRAY+'│'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET);
  }
}{ const inner = Math.max(0, BAR_W-2);
  const fmin = 1, fmax = Number(cfg.spectrum_max_hz)||30;
  lines.push(buildFreqLegendRow(fmin, fmax, inner));
  lines.push(buildBandLegendRow(fmin, fmax, inner));
}
lines.push(midBorderUpper(TOTAL_W, CONNECTORS, [1]));
  for (let i=0;i<5;i++){
    const name = BANDS[i]; const r = midR[i] || '';
    lines.push(buildHistRow(name, levels[name], absVals[name]||0, r));
  }
  // single Score history row under the band histories
  const currentScore = (smooth && typeof smooth.score==='number') ? smooth.score : 0;
  lines.push(midBorderUpper(TOTAL_W, CONNECTORS));
  const pDisp = (PLAYER_ID==null || PLAYER_ID==='') ? '--' : pad2(PLAYER_ID);
  const gDisp = (GAME_ID==null || GAME_ID==='') ? '--' : pad2(GAME_ID);
  lines.push(buildScoreHistRow(scoreLevels,currentScore,'Green '+String(Math.round(G_PCT||0))+'% of time'));
  lines.push(midBorderLower(TOTAL_W, CONNECTORS, [1]));
  lines.push(buildSensorsRow(sensorsOut, botR));
  lines.push(botBorder(TOTAL_W, CONNECTORS));
  return lines;
}


    

    setInterval(()=>{ if(!paused) render(composeFrame()); }, REFMS);

    // History update
    setInterval(()=>{
  const inner = Math.max(0, BAR_W-2);
  if (calibrated){
    for (const name of BANDS) {
      let vEff;
      const v = rel[name] ?? 0;
      vEff = NO_CONTACT ? 0 : v;
      const lvl=Math.min(4, Math.max(0, Math.floor(vEff*5)));
      const arr=levels[name];
      if (arr.length < inner) { while (arr.length < inner) arr.push(0); }
      arr.push(lvl);
      if (arr.length > inner) arr.shift();
    }
    // score history
    const sInner = Math.max(0, BAR_W-2);
    const s = (smooth && typeof smooth.score==='number') ? Math.max(0, Math.min(100, smooth.score)) : 0;
    if (scoreLevels.length < sInner) { while (scoreLevels.length < sInner) scoreLevels.push(0); }
    scoreLevels.push(NO_CONTACT ? 0 : s);

    // Update green percentage based on score history (>=65 threshold)
    (function(){
      const inner = Math.max(0, BAR_W-2);
      const win = scoreLevels.slice(-Math.max(1, Math.floor(inner/2))); // recent half-width
      const green = win.filter(v=>v>=65).length;
      G_PCT = win.length ? (100*green/win.length) : 0;
    })();
    if (scoreLevels.length > sInner) scoreLevels.shift();
            if (APP_STATE==='measuring') {
              const now = Date.now();
              const t = now - MEASURE_START_TS;
              const row = [
                t,
                (rel.Delta??0).toFixed(6),(rel.Theta??0).toFixed(6),(rel.Alpha??0).toFixed(6),(rel.Beta??0).toFixed(6),(rel.Gamma??0).toFixed(6),
                (absVals.Delta??0).toExponential(6),(absVals.Theta??0).toExponential(6),(absVals.Alpha??0).toExponential(6),(absVals.Beta??0).toExponential(6),(absVals.Gamma??0).toExponential(6),
                (smooth?.EI??0).toFixed(6),(smooth?.SC??0).toFixed(6),(smooth?.DR??0).toFixed(6),(smooth?.HB??0).toFixed(6),
                (smooth?.score??0).toFixed(3),
                NO_CONTACT?1:0
              ].join(',');
              LOG_ROWS.push(row);
            }
  }
}, 1000);

    // Data loop
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const computeMetrics=(est)=>{
      const rp={ delta:est.bandRel(1,4), theta:est.bandRel(4,7), alpha:est.bandRel(8,12), smr:est.bandRel(12,15), lowB:est.bandRel(15,20), highB:est.bandRel(20,30), betaLow:est.bandRel(12,20) };
      const EI = rp.betaLow / Math.max(1e-9, rp.alpha + rp.theta);
      const SC = rp.smr / Math.max(1e-9, rp.highB);
      const DR = rp.theta / Math.max(1e-9, rp.alpha);
      const HB = rp.highB;
      return { rp, EI, SC, DR, HB };
    };
    const isArtifact=(rp, zHB)=> (zHB!=null && zHB>2.5) || !isFinite(rp.alpha+rp.theta+rp.smr+rp.lowB+rp.highB);
    const EMA_A = 1 - Math.exp(-2/15);

    // demo generator
    /* demo removed */

    while(true){
      await sleep(REFMS);

      let rowSel=null, data=null;
      
          globalThis.__lastRowSel = rowSel; globalThis.__lastFs = (typeof fsr!=='undefined'&&fsr)||globalThis.__lastFs||250;
if (!noData){
        try {
          data=await board.getCurrentBoardData(128);
        } catch(e) {
          noData=true;
        }
      }
      if (noData){ /* no data path: skip generating data */ } else if (false){
        rowSel = genDemo(128);
        // fake sensors
        for (let i=0;i<eegCh.length;i++){
          const v = (Math.random()*2-1)*0.001;
          const buf = contactBuf[i];
          buf.push(v);
          while (buf.length>128) buf.shift();
          latestV[i]=v;
        }
      } else {
        const eegCh=BoardShim.getEegChannels(boardId);
        // Composite selection
const __sel = (Array.isArray(cfg.channel_indices) && cfg.channel_indices.length) ? cfg.channel_indices.map(idx => eegCh[Math.max(0, Math.min(Number(idx)||0, eegCh.length-1))]) : eegCh;
rowSel = combineChannels(data, __sel, (cfg.channel_mode||'mean')) || data[eegCh[0]];
        for (let i=0;i<eegCh.length;i++){
          const row=data[eegCh[i]];
          if (row && row.length){
            latestV[i]=row[row.length-1]/1e6;
            const buf = contactBuf[i];
            for (let j=Math.max(0,row.length-64); j<row.length; j++){ buf.push(row[j]/1e6); }
            while (buf.length > 128) buf.shift();
          }
        }
      }
      if(!rowSel||!rowSel.length) continue;
      const res=est.addSamples(rowSel); if(!res) continue;

      rel.Delta=est.bandRel(1,4); rel.Theta=est.bandRel(4,7); rel.Alpha=est.bandRel(8,12); rel.Beta=est.bandRel(12,30); rel.Gamma=est.bandRel(30,45,1,30);
      const b=res.bands; absVals.Delta=b.delta.abs; absVals.Theta=b.theta.abs; absVals.Alpha=b.alpha.abs; absVals.Beta=b.beta.abs; absVals.Gamma=b.gamma.abs;

      const m=computeMetrics(est);
      for (const k of ['EI','SC','DR','HB']) { const prev=smooth[k]; smooth[k]=prev==null? m[k] : (prev + EMA_A*(m[k]-prev)); }
      if (!calibrated){
        calTime += REFMS/1000;
        calBuf.push({EI:smooth.EI,SC:smooth.SC,DR:smooth.DR,HB:smooth.HB});
        
        if (APP_STATE==='calibrating' && CAL2_T0){
          const elapsed = (Date.now()-CAL2_T0)/1000;
          if (!CAL2_BEEPED_SWITCH && elapsed >= CAL_OPEN_SEC){ beep(); CAL2_PHASE=1; CAL2_BEEPED_SWITCH=true; }
          if (!CAL2_BEEPED_END && elapsed >= (CAL_OPEN_SEC + CAL_CLOSED_SEC)) { beep(); CAL2_BEEPED_END = true; }
        }
if (calTime>=CAL_SECS){
          for (const key of ['EI','SC','DR','HB']){ const arr=calBuf.map(o=>o[key]).filter(Number.isFinite); const mu=arr.reduce((a,c)=>a+c,0)/Math.max(1,arr.length); const sd=Math.sqrt(arr.reduce((a,c)=>a+(c-mu)*(c-mu),0)/Math.max(1,arr.length-1))||1e-6; baseline.mu[key]=mu; baseline.sigma[key]=sd; }
          calibrated=true; CALIBRATED=calibrated; APP_STATE='post_cal'; scoreLevels.length=0; for (const k of Object.keys(levels)) levels[k]=[]; CAL2_PHASE=-1; CAL2_T0=0; CAL2_BEEPED_START=false; CAL2_BEEPED_SWITCH=false; if(!CAL2_BEEPED_END) beep();
        }
        continue;
      }
      const zHB=(smooth.HB - (baseline.mu.HB||0))/((baseline.sigma.HB||1e-6));
      const artifact = isArtifact(m.rp, zHB);
      if (artifact) { session.artifacts++; continue; }
      const zEI=(smooth.EI - baseline.mu.EI)/baseline.sigma.EI;
      const zSC=(smooth.SC - baseline.mu.SC)/baseline.sigma.SC;
      const zDR=(smooth.DR - baseline.mu.DR)/baseline.sigma.DR;
      const score_raw = 0.45*Math.max(-2,Math.min(2,zEI)) + 0.25*Math.max(-2,Math.min(2,zSC)) - 0.20*Math.max(-2,Math.min(2,zDR)) - 0.10*Math.max(-2,Math.min(2,zHB));
      const score = Math.round( Math.max(0, Math.min(100, 50 + 12.5*score_raw )) );
      smooth.score = smooth.score==null? score : (smooth.score + 0.2*(score - smooth.score));

      // --- Realtime JSON payload for frontend ---
      const payload = {
        t: Date.now(),
        metrics: {
          EI: smooth.EI,
          SC: smooth.SC,
          DR: smooth.DR,
          HB: smooth.HB
        },
        score: smooth.score,
        bands: {
          rel: {
            delta: levels.Delta || 0,
            theta: levels.Theta || 0,
            alpha: levels.Alpha || 0,
            beta:  levels.Beta  || 0,
            gamma: levels.Gamma || 0
          },
          abs: {
            delta: absVals.Delta || 0,
            theta: absVals.Theta || 0,
            alpha: absVals.Alpha || 0,
            beta:  absVals.Beta  || 0,
            gamma: absVals.Gamma || 0
          }
        },
        flags: {
          artifact: !!artifact,
          no_contact: !!NO_CONTACT
        }
      };
      sseBroadcast(payload);

      session.last15.push(smooth.score); if (session.last15.length>15) session.last15.shift();
      const green = (zEI>=+0.5 && zSC>=+0.5 && zDR<=0 && zHB<=+0.5);
      session.total++; if (green){ session.green++; session.currentGreen++; session.longestGreen=Math.max(session.longestGreen, session.currentGreen); } else { session.currentGreen=0; }
    }
  } catch (e) {
    console.error('Error:', e?.message || e);
  } finally {
    leaveAltBuffer();
  }
}

process.on('SIGINT', ()=>{ leaveAltBuffer(); process.exit(0); });
main();


// === Thin vertical spectrum (top current-state block) ===

function __goertzelBins(row, fs, bins, fmin, fmax){
  const N = Math.min(row.length|0, Math.max(128, Math.min(1024, Math.floor(2*fs))));
  const start = row.length - N;
  if (start < 0) return new Array(bins).fill(0);
  const twoPi = Math.PI*2;
  const out = new Array(bins).fill(0);
  for (let k=0; k<bins; k++){
    const f = fmin + (k+0.5)*(fmax-fmin)/bins;
    const w = twoPi*f/fs;
    const cw = Math.cos(w), sw = Math.sin(w);
    const coeff = 2*cw;
    let s0=0, s1=0, s2=0;
    for (let n=0; n<N; n++){
      s0 = row[start+n] + coeff*s1 - s2;
      s2 = s1; s1 = s0;
    }
    const re = s1 - s2*cw;
    const im = s2*sw;
    out[k] = re*re + im*im;
  }
  return out;
}

function spectrumBinsFromEstimator(est, bins, fmin, fmax){
  const out = new Array(Math.max(1,bins|0)).fill(0), cnt = new Array(Math.max(1,bins|0)).fill(0);
  const freqs = est && est.freqs ? Array.from(est.freqs) : [];
  const spec  = est && est.spectrum ? Array.from(est.spectrum) : [];
  if (freqs.length && spec.length && freqs.length===spec.length){
    const span = Math.max(1e-6, (fmax - fmin));
    for (let k=0;k<freqs.length;k++){
      const f = freqs[k]; if (f < fmin || f > fmax) continue;
      const x = Math.min(out.length-1, Math.max(0, Math.floor((out.length) * (f - fmin)/span )));
      out[x] += spec[k]; cnt[x] += 1;
    }
    for (let i=0;i<out.length;i++){ out[i] = cnt[i] ? (out[i]/cnt[i]) : 0; }
    return out;
  }
  // __SPECTRUM_FALLBACK__: compute quick spectrum from recent samples
  const row = globalThis.__lastRowSel;
  const fs  = globalThis.__lastFs || 250;
  if (Array.isArray(row) && row.length>64){
    return __goertzelBins(row, fs, Math.max(1,bins|0), fmin, fmax);
  }
  return out;
}
function specCell(name, est, inner, fmin, fmax){
  const labelCell = padAnsi(name||'', LABEL_W);
  const innerW = Math.max(0, inner);
  const vals = spectrumBinsFromEstimator(est, innerW, fmin, fmax);
  const maxv = vals.reduce((a,b)=>b>a?b:a, 0) || 1;

  const bf = {Delta:[1,4],Theta:[4,7],Alpha:[8,12],Beta:[12,30],Gamma:[30,45]}[name] || [fmin, fmax];
  const bf1 = bf[0], bf2 = bf[1];

  const ESC = '\x1b[';
  const RESET256 = ESC + '0m';
  const FG256 = (n)=> ESC + '38;5;' + n + 'm';
  const ramps = {
    Delta: [24, 26, 33, 39, 45],
    Theta: [58, 64, 70, 106, 148],
    Alpha: [30, 37, 44, 51, 123],
    Beta:  [90, 126, 162, 198, 201],
    Gamma: [88, 124, 160, 196, 202]
  };

  let s = '';
  for (let i=0;i<innerW;i++){
    const v = vals[i]/maxv;
    const f = fmin + (i+0.5)*(fmax-fmin)/Math.max(1,innerW);
    let binBand='Beta';
    if (f<4) binBand='Delta'; else if (f<7) binBand='Theta'; else if (f<12) binBand='Alpha'; else if (f<30) binBand='Beta'; else binBand='Gamma';
    const inRowBand = ( (name==='Delta'&&f>=1&&f<=4) || (name==='Theta'&&f>=4&&f<=7) || (name==='Alpha'&&f>=8&&f<=12) || (name==='Beta'&&f>=12&&f<=30) || (name==='Gamma'&&f>=30&&f<=45) );
    const base = COLORS[binBand]||{};
    const col  = inRowBand ? (base.bright||base.mid||GRN) : (base.dim||base.dark||GRAY);
    s += col + (cfg.spectrum_char||'|') + RESET;
  }
  const barCell = ' ' + s + ' ';
  return [labelCell, barCell];
}
function buildTopSpecRow(name, est, inner, fmin, fmax, rightText){
  const pair = specCell(name, est, inner, fmin, fmax);
  const blankLabel = padAnsi('', LABEL_W);
  const barCell = pair[1];
  const valCell = padAnsiRight('', VAL_W);
  const rpCell  = padAnsi(rightText||'', RP_W);
  return GRAY+'║'+RESET+blankLabel+GRAY+'║'+RESET+barCell+GRAY+'│'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
}


function specPowerStack(est, inner, fmin, fmax){
  const innerW = Math.max(0, inner);
  const vals = spectrumBinsFromEstimator(est, innerW, fmin, fmax);
  const bandOfF = (f)=> (f<4?'Delta': f<7?'Theta': f<12?'Alpha': f<30?'Beta':'Gamma');
  const bounds = {Delta:[1,4],Theta:[4,7],Alpha:[8,12],Beta:[12,30],Gamma:[30,45]};
  const bmin = {Delta:Infinity,Theta:Infinity,Alpha:Infinity,Beta:Infinity,Gamma:Infinity};
  const bmax = {Delta:0,       Theta:0,       Alpha:0,       Beta:0,       Gamma:0      };
  // band-local min/max
  for (let i=0;i<innerW;i++){
    const f = fmin + (i+0.5)*(fmax-fmin)/Math.max(1,innerW);
    const band = bandOfF(f);
    const v = vals[i];
    const [lo,hi] = bounds[band];
    if (f>=lo && f<=hi){ if (v<bmin[band]) bmin[band]=v; if (v>bmax[band]) bmax[band]=v; }
  }
  for (const k in bmin){ if (!isFinite(bmin[k])) bmin[k]=0; if (bmax[k]<=bmin[k]) bmax[k]=bmin[k]+1e-9; }
  const rows = Array.from({length:5}, ()=> ' ');
  const EPS=1e-9; const wearing = !NO_CONTACT;
  for (let i=0;i<innerW;i++){
    const f = fmin + (i+0.5)*(fmax-fmin)/Math.max(1,innerW);
    const band = bandOfF(f);
    const tint = (COLORS && COLORS[band]) ? COLORS[band] : {dark:GRAY, bright:GRN};
    const span = Math.max(EPS, bmax[band]-bmin[band]);
    const absFloor = bmin[band] + 0.02*span;
    const vNorm = Math.max(0, Math.min(1, (vals[i]-bmin[band])/(span)));
    const relPass = (vNorm >= 0.12);
    const canLight = wearing && span > 5*EPS && vals[i] >= absFloor && relPass;
    const lvl = canLight ? Math.max(0, Math.min(5, Math.ceil(5*vNorm))) : 0;
    const baseline = (tint.dark||GRAY) + (cfg.spectrum_char||'|') + RESET;
    const lit      = (tint.bright||GRN) + (cfg.spectrum_char||'|') + RESET;
    for (let r=0;r<5;r++){ rows[r] += (lvl >= (r+1)) ? lit : baseline; }
  }
  for (let r=0;r<5;r++) rows[r] += ' ';
  return rows; // bottom..top
}



function buildFreqLegendRow(fmin, fmax, inner, rightText=''){
  const labelCell = padAnsi('Freq', LABEL_W);
  const innerW = Math.max(0, inner);
  let sArr = new Array(innerW).fill(' ');
  const fStart = Math.ceil(fmin/5)*5;
  for (let f=fStart; f<=fmax; f+=5){
    const x = Math.min(innerW-1, Math.max(0, Math.round((innerW-1) * (f - fmin) / Math.max(1e-6, (fmax-fmin)) )));
    sArr[x] = '|';
    const lab = String(f);
    for (let i=0;i<lab.length && (x+i)<innerW;i++) sArr[x+i] = lab[i];
  }
  const barCell = ' ' + sArr.join('') + ' ';
  const valCell = padAnsiRight('', VAL_W);
  const rpCell  = padAnsi(rightText||'', RP_W);
  return GRAY+'║'+RESET+labelCell+GRAY+'║'+RESET+barCell+GRAY+'│'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
}
function buildBandLegendRow(fmin, fmax, inner, rightText=''){
  const labelCell = padAnsi('Bands', LABEL_W);
  const innerW = Math.max(0, inner);
  let sArr = new Array(innerW).fill(' ');
  const bands = [{name:'Δ',f1:1,f2:4},{name:'θ',f1:4,f2:7},{name:'α',f1:8,f2:12},{name:'β',f1:12,f2:30},{name:'γ',f1:30,f2:45}];
  for (const b of bands){
    const a = Math.max(fmin, b.f1), z = Math.min(fmax, b.f2);
    if (z <= fmin || a >= fmax) continue;
    const x1 = Math.round((innerW-1) * (a - fmin) / Math.max(1e-6, (fmax-fmin)));
    const x2 = Math.round((innerW-1) * (z - fmin) / Math.max(1e-6, (fmax-fmin)));
    const mid = Math.floor((x1 + x2)/2);
    if (mid >= 0 && mid < innerW) sArr[mid] = b.name;
  }
    if (innerW>0){ sArr[innerW-1] = 'γ'; }
  const barCell = ' ' + sArr.join('') + ' ';
  const valCell = padAnsiRight('', VAL_W);
  const rpCell  = padAnsi(rightText||'', RP_W);
  return GRAY+'║'+RESET+labelCell+GRAY+'║'+RESET+barCell+GRAY+'│'+RESET+valCell+GRAY+'║'+RESET+rpCell+GRAY+'║'+RESET;
}