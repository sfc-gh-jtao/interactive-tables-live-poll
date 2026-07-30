/**
 * Snowflake Interactive Tables — Live Poll Cloudflare Worker
 *
 * Public endpoints (no auth required):
 *   GET /             → vote.html
 *   GET /api/question → active question + options from Snowflake
 *   POST /api/vote    → write vote via Snowpipe Streaming REST API
 *
 * Secrets required (wrangler secret put <NAME>):
 *   SNOWFLAKE_ACCOUNT       sfsenorthamerica-demo98
 *   SNOWFLAKE_USER          DEMO_SERVICE_USER
 *   SNOWFLAKE_PRIVATE_KEY   full RSA PEM (from rsa_key.p8)
 *   SNOWFLAKE_DATABASE      DEMO_PREDICTIONS_DB
 *   SNOWFLAKE_SCHEMA        PUBLIC
 *   SNOWFLAKE_ROLE          DEMO_SERVICE_ROLE
 */

// ---------------------------------------------------------------------------
// JWT Utilities — Snowflake RS256 JWT using Web Crypto API
// ---------------------------------------------------------------------------

/** Convert PEM string to raw DER bytes */
function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN.*-----/, '')
    .replace(/-----END.*-----/, '')
    .replace(/\s/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Base64-URL encode an ArrayBuffer */
function bufToB64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Base64-URL encode a plain JS object (as JSON) */
function objToB64Url(obj) {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a Snowflake RS256 JWT.
 * The `iss` claim format: ACCOUNT.USER.SHA256:<public-key-fingerprint>
 * Result is cached for 55 minutes (JWT expires at 60min; 5-min safety buffer).
 */
let _cachedJwt    = null;
let _cachedJwtExp = 0;   // epoch ms when the cached token expires

async function generateSnowflakeJWT(env) {
  const nowMs = Date.now();
  if (_cachedJwt && nowMs < _cachedJwtExp) return _cachedJwt;
  const account = env.SNOWFLAKE_ACCOUNT.toUpperCase();
  const user    = env.SNOWFLAKE_USER.toUpperCase();
  const pem     = env.SNOWFLAKE_PRIVATE_KEY.replace(/\\n/g, '\n');

  // Import private key (PKCS#8)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  );

  // Export public key (SPKI) and compute SHA-256 fingerprint
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKeyJwk  = { kty: privateKeyJwk.kty, n: privateKeyJwk.n, e: privateKeyJwk.e };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
  const pubSpki = await crypto.subtle.exportKey('spki', publicKey);
  const digest  = await crypto.subtle.digest('SHA-256', pubSpki);
  // Snowflake expects STANDARD base64 (with +, /, =) for the key fingerprint
  const fingerprint = btoa(String.fromCharCode(...new Uint8Array(digest)));

  const iss = `${account}.${user}.SHA256:${fingerprint}`;
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss, sub: `${account}.${user}`, iat: now, exp: now + 3600 };
  const sigInput = `${objToB64Url(header)}.${objToB64Url(payload)}`;

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(sigInput)
  );

  const token = `${sigInput}.${bufToB64Url(sig)}`;
  _cachedJwt    = token;
  _cachedJwtExp = nowMs + 55 * 60 * 1000; // cache for 55 min
  return token;
}

// ---------------------------------------------------------------------------
// Snowpipe Streaming REST API
// ---------------------------------------------------------------------------

/**
 * Channel cache for Snowpipe Streaming.
 * Stores { channel: string, token: string } per pipe so we can skip open_channel
 * on subsequent appends (saves one round-trip per vote).
 * On a stale/consumed token the append will fail and we fall back to open+append.
 */
const _channelCache = {}; // pipe -> { channel, token } | null
let _cachedIngestHost = null;
let _cachedAllowMultipleVotes = false; // mirrors current question setting

// Tracks sessions that have already written voter metadata (first-vote only)
const _voterWritten = new Set();

/** Parse User-Agent string into device_type, os, browser */
function parseUserAgent(ua) {
  const device_type = /iPad|Tablet/i.test(ua) ? 'tablet'
                    : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  const os = /iPhone|iPad/i.test(ua) ? 'iOS'
           : /Android/i.test(ua) ? 'Android'
           : /Windows/i.test(ua) ? 'Windows'
           : /Mac OS/i.test(ua) ? 'macOS'
           : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//i.test(ua) ? 'Edge'
                : /Chrome/i.test(ua) ? 'Chrome'
                : /Firefox/i.test(ua) ? 'Firefox'
                : /Safari/i.test(ua) ? 'Safari' : 'Unknown';
  return { device_type, os, browser };
}

async function getIngestHostname(jwt, account) {
  if (_cachedIngestHost) return _cachedIngestHost;

  const url = `https://${account}.snowflakecomputing.com/v2/streaming/hostname`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Accept': 'application/json',
      'User-Agent': 'demo-predictions-worker/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`get_hostname failed ${res.status}: ${body}`);
  }
  // The hostname endpoint returns a plain text hostname string, not JSON
  const hostname = (await res.text()).trim();
  _cachedIngestHost = hostname;
  return _cachedIngestHost;
}

/**
 * Write one vote row via Snowpipe Streaming REST API (correct 2-step flow).
 * Step 1: Open Channel  → PUT  /v2/streaming/databases/.../channels/{name}
 * Step 2: Append Rows   → POST /v2/streaming/DATA/databases/.../rows?continuationToken=...
 */
async function streamVote(jwt, ingestHost, env, row) {
  const db     = env.SNOWFLAKE_DATABASE;
  const schema = env.SNOWFLAKE_SCHEMA;
  const pipe   = 'FACT_PREDICTIONS-STREAMING';
  const channel = 'CF_VOTE_MAIN'; // fixed name — reused across requests

  const authHeaders = {
    Authorization: `Bearer ${jwt}`,
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    'User-Agent': 'demo-predictions-worker/1.0',
    'Accept': 'application/json',
  };

  /** Append rows using a known continuation token; returns next token on success. */
  async function appendRows(token) {
    const appendUrl = `https://${ingestHost}/v2/streaming/data/databases/${db}/schemas/${schema}/pipes/${pipe}/channels/${channel}/rows?continuationToken=${encodeURIComponent(token)}`;
    const res = await fetch(appendUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(row) + '\n',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`append_rows failed ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.next_continuation_token;
  }

  // Fast path: reuse cached channel token (1 round-trip)
  const cached = _channelCache[pipe];
  if (cached) {
    try {
      const nextToken = await appendRows(cached.token);
      _channelCache[pipe] = { channel, token: nextToken };
      return true;
    } catch {
      // Stale token or race condition — fall through to open+append
      _channelCache[pipe] = null;
    }
  }

  // Slow path: open channel to get a fresh token, then append (2 round-trips)
  const openUrl = `https://${ingestHost}/v2/streaming/databases/${db}/schemas/${schema}/pipes/${pipe}/channels/${channel}`;
  const openRes = await fetch(openUrl, {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!openRes.ok) {
    const text = await openRes.text();
    throw new Error(`open_channel failed ${openRes.status}: ${text}`);
  }
  const { next_continuation_token } = await openRes.json();
  const nextToken = await appendRows(next_continuation_token);
  _channelCache[pipe] = { channel, token: nextToken };
  return true;
}

/** Write voter metadata row to dim_voters (first vote per session only) */
async function streamVoterMetadata(jwt, ingestHost, env, row) {
  const db     = env.SNOWFLAKE_DATABASE;
  const schema = env.SNOWFLAKE_SCHEMA;
  const pipe   = 'DIM_VOTERS-STREAMING';
  const channel = 'CF_VOTER_MAIN'; // fixed name — reused across requests

  const authHeaders = {
    Authorization: `Bearer ${jwt}`,
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    'User-Agent': 'demo-predictions-worker/1.0',
    'Accept': 'application/json',
  };

  async function appendRows(token) {
    const appendUrl = `https://${ingestHost}/v2/streaming/data/databases/${db}/schemas/${schema}/pipes/${pipe}/channels/${channel}/rows?continuationToken=${encodeURIComponent(token)}`;
    const res = await fetch(appendUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(row) + '\n',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`append_rows failed ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.next_continuation_token;
  }

  // Fast path: reuse cached token
  const cached = _channelCache[pipe];
  if (cached) {
    try {
      const nextToken = await appendRows(cached.token);
      _channelCache[pipe] = { channel, token: nextToken };
      return;
    } catch {
      _channelCache[pipe] = null;
    }
  }

  // Slow path: open channel
  const openUrl = `https://${ingestHost}/v2/streaming/databases/${db}/schemas/${schema}/pipes/${pipe}/channels/${channel}`;
  const openRes = await fetch(openUrl, {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!openRes.ok) {
    const errText = await openRes.text();
    console.warn(`streamVoterMetadata open_channel failed ${openRes.status}:`, errText);
    return; // Non-fatal
  }
  const { next_continuation_token } = await openRes.json();
  try {
    const nextToken = await appendRows(next_continuation_token);
    _channelCache[pipe] = { channel, token: nextToken };
  } catch (e) {
    console.warn('streamVoterMetadata append_rows failed (non-fatal):', e.message);
  }
}

// ---------------------------------------------------------------------------
// Snowflake SQL REST API — query active question
// ---------------------------------------------------------------------------

async function getActiveQuestion(jwt, env) {
  const url = `https://${env.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/statements`;

  const sql = `
    SELECT q.question_id, q.question_text, q.context_text, q.allow_multiple_votes,
           q.require_email,
           a.option_id, a.option_text, a.display_order
    FROM ${env.SNOWFLAKE_DATABASE}.${env.SNOWFLAKE_SCHEMA}.dim_questions q
    JOIN ${env.SNOWFLAKE_DATABASE}.${env.SNOWFLAKE_SCHEMA}.dim_answer_options a
      ON q.question_id = a.question_id
    WHERE q.is_active = TRUE
    ORDER BY a.display_order`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'demo-predictions-worker/1.0',
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    },
    body: JSON.stringify({
      statement: sql,
      warehouse: 'DEMO_STD_WH',
      role: env.SNOWFLAKE_ROLE,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SQL API failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;

  // Rows: [question_id, question_text, context_text, allow_multiple_votes, require_email, option_id, option_text, display_order]
  const first = data.data[0];
  const allowMultiple  = String(first[3]).toLowerCase() === 'true';
  const requireEmail   = String(first[4]).toLowerCase() === 'true';
  _cachedAllowMultipleVotes = allowMultiple;
  const question = {
    question_id:          first[0],
    question_text:        first[1],
    context_text:         first[2],
    allow_multiple_votes: allowMultiple,
    require_email:        requireEmail,
    options: [],
  };
  for (const row of data.data) {
    question.options.push({
      option_id:     row[5],
      option_text:   row[6],
      display_order: parseInt(row[7], 10),
    });
  }
  return question;
}

// ---------------------------------------------------------------------------
// In-memory dedup: (session_id, question_id) → true
// Resets when Worker instance is recycled (fine for a demo)
// ---------------------------------------------------------------------------
const _voted = new Set();

// In-memory rate limiter: ip -> [timestamps]
const _rateMap = new Map();
function checkRate(ip) {
  const now   = Date.now();
  const times = (_rateMap.get(ip) || []).filter(t => now - t < 60_000);
  if (times.length >= 15) return false;
  times.push(now);
  _rateMap.set(ip, times);
  return true;
}

// ---------------------------------------------------------------------------
// vote.html — served at GET /
// ---------------------------------------------------------------------------
const VOTE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Live Poll</title>
<style>
  :root { --bg:#0f1117;--surface:#1a1d27;--border:#2e3347;--text:#e8ecf4;--muted:#8892a4;--r:14px; }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column; }
  .header { padding:20px 20px 0; text-align:center; }
  .logo { font-size:.7rem; font-weight:700; letter-spacing:.14em; color:#29b5e8; text-transform:uppercase; }
  .main { flex:1; padding:16px 20px 24px; display:flex; flex-direction:column; }
  .state { display:none; flex-direction:column; flex:1; }
  .state.active { display:flex; }
  #state-loading { align-items:center; justify-content:center; }
  .spinner { width:36px;height:36px;border:3px solid var(--border);border-top-color:#29b5e8;border-radius:50%;animation:spin .8s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
  #state-empty { align-items:center;justify-content:center;text-align:center; }
  #state-empty p { color:var(--muted);font-size:.95rem; }
  #state-vote { justify-content:flex-start; }
  .question-text { font-size:1.25rem;font-weight:700;line-height:1.45;margin-bottom:8px; }
  .question-context { font-size:.9rem;color:var(--muted);margin-bottom:24px;line-height:1.5; }
  .options-list { display:flex;flex-direction:column;gap:12px;flex:1; }
  .option-btn { width:100%;min-height:60px;border:2px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:1rem;font-weight:600;cursor:pointer;display:flex;align-items:center;padding:14px 16px;gap:14px;text-align:left;transition:border-color .15s,transform .08s;-webkit-user-select:none;user-select:none; }
  .option-btn:active { transform:scale(.97); }
  .option-btn.selected { background:color-mix(in srgb,var(--opt-color) 18%,var(--surface));border-color:var(--opt-color); }
  .option-badge { width:30px;height:30px;border-radius:50%;background:var(--opt-color);color:#0f1117;font-size:.8rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0; }
  #state-voted { justify-content:flex-start; }
  .voted-question { font-size:1.15rem;font-weight:700;margin-bottom:20px;line-height:1.45; }
  .your-pick { display:flex;align-items:center;gap:14px;padding:16px;border:2px solid;border-radius:14px;background:color-mix(in srgb,var(--opt-color,#29b5e8) 12%,var(--surface));font-size:1rem;font-weight:600;margin-bottom:16px; }
  .voted-note { color:var(--muted);font-size:.85rem;text-align:center;margin-top:8px; }
  .opt-0{--opt-color:#29b5e8}.opt-1{--opt-color:#56d483}.opt-2{--opt-color:#e8a229}.opt-3{--opt-color:#9b59b6}.opt-4{--opt-color:#e85d4a}.opt-5{--opt-color:#1abc9c}
  /* Vote toast (multi-vote mode) */
  #vote-toast { position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-80px);background:#29b5e8;color:#0f1117;padding:10px 22px;border-radius:30px;font-weight:700;font-size:.9rem;letter-spacing:.04em;transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .25s;opacity:0;pointer-events:none;white-space:nowrap;z-index:100; }
  #vote-toast.show { transform:translateX(-50%) translateY(0);opacity:1; }
  /* Email capture state */
  #state-email { justify-content:flex-start; }
  .email-prompt { font-size:1.1rem;font-weight:700;line-height:1.45;margin-bottom:6px; }
  .email-sub { font-size:.9rem;color:var(--muted);margin-bottom:24px;line-height:1.5; }
  .email-input { width:100%;background:var(--surface);border:2px solid var(--border);border-radius:var(--r);color:var(--text);font-size:1rem;padding:14px 16px;outline:none;transition:border-color .15s;margin-bottom:12px; }
  .email-input:focus { border-color:#29b5e8; }
  .email-input.invalid { border-color:#e85d4a; }
  .email-note { font-size:.75rem;color:var(--muted);text-align:center;margin-top:16px; }
</style>
</head>
<body>
<div id="vote-toast">Vote recorded!</div>
<div class="header"><div class="logo">Live Poll · Powered by Snowflake</div></div>
<div class="main">
  <div class="state active" id="state-loading"><div class="spinner"></div></div>
  <div class="state" id="state-empty"><p>No active question right now.<br>Check back in a moment.</p></div>
  <div class="state" id="state-email">
    <div class="email-prompt" id="email-q-text"></div>
    <div class="email-sub">Enter your email to participate</div>
    <input class="email-input" type="email" id="email-input" placeholder="your@email.com" autocomplete="email" inputmode="email">
    <button class="option-btn" id="btn-email-submit" onclick="submitEmail()" style="justify-content:center;font-size:1rem;">→&nbsp; Continue to Vote</button>
    <p class="email-note">Your email is collected for event follow-up only.</p>
  </div>
  <div class="state" id="state-vote">
    <div class="question-text" id="q-text"></div>
    <div class="question-context" id="q-context"></div>
    <div class="options-list" id="options-list"></div>
  </div>
  <div class="state" id="state-voted">
    <div class="voted-question" id="voted-q-text"></div>
    <div class="voted-confirm" id="voted-confirm"></div>
  </div>
</div>
<script>
const SESSION_KEY='demo_poll_session';const VOTE_KEY='demo_poll_vote';const EMAIL_KEY='demo_poll_email';
let sessionId=localStorage.getItem(SESSION_KEY);
if(!sessionId){sessionId=crypto.randomUUID();localStorage.setItem(SESSION_KEY,sessionId);}
let currentQuestionId=null,myVoteOptionId=null,pollInterval=null,currentQuestion=null;
let toastTimer=null;
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function isMobile(){return/Mobi|Android/i.test(navigator.userAgent)?'mobile':'desktop';}
function showState(id){document.querySelectorAll('.state').forEach(el=>el.classList.remove('active'));document.getElementById(id).classList.add('active');}
function showToast(msg){
  const t=document.getElementById('vote-toast');
  t.textContent=msg||'Vote recorded!';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),1800);
}
function submitEmail(){
  const input=document.getElementById('email-input');
  const email=input.value.trim();
  if(!email||!/^[^@]+@[^@]+\.[^@]+$/.test(email)){input.classList.add('invalid');return;}
  input.classList.remove('invalid');
  localStorage.setItem(EMAIL_KEY+':'+currentQuestionId, email);
  loadQuestion();
}
async function loadQuestion(){
  try{
    const resp=await fetch('/api/question');
    const data=await resp.json();
    if(!data.active){showState('state-empty');clearInterval(pollInterval);pollInterval=setInterval(loadQuestion,4000);return;}
    // Email gate: show email capture if required and not yet provided
    if(data.require_email){
      const savedEmail=localStorage.getItem(EMAIL_KEY+':'+data.question_id);
      if(!savedEmail){
        currentQuestionId=data.question_id;currentQuestion=data;
        document.getElementById('email-q-text').textContent=data.question_text;
        showState('state-email');
        clearInterval(pollInterval);pollInterval=setInterval(loadQuestion,4000);return;
      }
    }
    // If already voted for this question and single-vote mode, show voted state
    const savedVote=JSON.parse(localStorage.getItem(VOTE_KEY)||'null');
    if(!data.allow_multiple_votes&&savedVote&&savedVote.question_id===data.question_id){
      currentQuestionId=data.question_id;myVoteOptionId=savedVote.option_id;currentQuestion=data;
      const votedOpt=(data.options||[]).find(o=>o.option_id===savedVote.option_id);
      document.getElementById('voted-q-text').textContent=data.question_text;
      document.getElementById('voted-confirm').innerHTML=votedOpt?'<div class="your-pick opt-'+(data.options.indexOf(votedOpt))+'" style="border-color:var(--opt-color)"><span class="option-badge" style="background:var(--opt-color);color:#0f1117">'+String.fromCharCode(65+data.options.indexOf(votedOpt))+'</span> '+esc(votedOpt.option_text)+'</div><p class="voted-note">Your vote was recorded.</p>':'';
      showState('state-voted');clearInterval(pollInterval);pollInterval=setInterval(loadQuestion,4000);return;
    }
    currentQuestionId=data.question_id;myVoteOptionId=null;currentQuestion=data;
    document.getElementById('q-text').textContent=data.question_text;
    const ctx=document.getElementById('q-context');ctx.textContent=data.context_text||'';ctx.style.display=data.context_text?'block':'none';
    const list=document.getElementById('options-list');list.innerHTML='';
    (data.options||[]).sort((a,b)=>a.display_order-b.display_order).forEach((opt,i)=>{
      const btn=document.createElement('button');
      btn.className='option-btn opt-'+i;btn.dataset.optionId=opt.option_id;
      btn.innerHTML='<span class="option-badge">'+String.fromCharCode(65+i)+'</span><span>'+esc(opt.option_text)+'</span>';
      btn.addEventListener('click',()=>castVote(opt.option_id));
      list.appendChild(btn);
    });
    showState('state-vote');clearInterval(pollInterval);pollInterval=setInterval(loadQuestion,4000);
  }catch(e){console.error(e);showState('state-empty');}
}
async function castVote(optionId){
  document.querySelectorAll('.option-btn').forEach(b=>{b.disabled=true;if(b.dataset.optionId===optionId)b.classList.add('selected');});
  try{
    const votedAtMs=Date.now();
    const voterEmail=currentQuestion&&currentQuestion.require_email
      ?(localStorage.getItem(EMAIL_KEY+':'+currentQuestionId)||null)
      :null;
    const resp=await fetch('/api/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question_id:currentQuestionId,option_id:optionId,session_id:sessionId,platform:isMobile(),voted_at_ms:votedAtMs,voter_email:voterEmail})});
    if(resp.ok||resp.status===409){
      if(currentQuestion&&currentQuestion.allow_multiple_votes){
        // Multi-vote mode: flash toast and stay on voting screen
        showToast('Vote recorded!');
        setTimeout(()=>{
          document.querySelectorAll('.option-btn').forEach(b=>{b.disabled=false;b.classList.remove('selected');});
        },400);
      }else{
        // Single-vote mode: save and navigate to confirmation
        localStorage.setItem(VOTE_KEY,JSON.stringify({question_id:currentQuestionId,option_id:optionId}));
        myVoteOptionId=optionId;
        document.getElementById('voted-q-text').textContent=document.getElementById('q-text').textContent;
        const idx=(currentQuestion&&currentQuestion.options||[]).findIndex(o=>o.option_id===optionId);
        const pickedOpt=(currentQuestion&&currentQuestion.options||[]).find(o=>o.option_id===optionId);
        document.getElementById('voted-confirm').innerHTML=pickedOpt?'<div class="your-pick opt-'+idx+'" style="border-color:var(--opt-color)"><span class="option-badge" style="background:var(--opt-color);color:#0f1117">'+String.fromCharCode(65+idx)+'</span> '+esc(pickedOpt.option_text)+'</div><p class="voted-note">Your vote was recorded.</p>':'';
        showState('state-voted');clearInterval(pollInterval);pollInterval=setInterval(loadQuestion,4000);
      }
    }else{document.querySelectorAll('.option-btn').forEach(b=>{b.disabled=false;b.classList.remove('selected');});}
  }catch(e){document.querySelectorAll('.option-btn').forEach(b=>{b.disabled=false;b.classList.remove('selected');});}
}
loadQuestion();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Main Worker handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ---- GET / → vote.html ----
    if (method === 'GET' && (path === '/' || path === '/vote')) {
      return new Response(VOTE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // ---- GET /api/debug-ingest ----
    if (method === 'GET' && path === '/api/debug-ingest') {
      try {
        const jwt  = await generateSnowflakeJWT(env);
        const host = await getIngestHostname(jwt, env.SNOWFLAKE_ACCOUNT);
        const db     = env.SNOWFLAKE_DATABASE;
        const schema = env.SNOWFLAKE_SCHEMA;
        const pipe   = 'FACT_PREDICTIONS-STREAMING';
        const url = `https://${host}/v2/streaming/databases/${encodeURIComponent(db)}/schemas/${encodeURIComponent(schema)}/pipes/${encodeURIComponent(pipe)}/events`;
        return Response.json({ host, url }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /api/debug-jwt  (remove before production) ----
    if (method === 'GET' && path === '/api/debug-jwt') {
      try {
        const jwt = await generateSnowflakeJWT(env);
        const parts = jwt.split('.');
        const header  = JSON.parse(atob(parts[0].replace(/-/g,'+').replace(/_/g,'/')));
        const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
        return Response.json({ header, payload, full_jwt: jwt }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /api/question ----
    if (method === 'GET' && path === '/api/question') {
      try {
        const jwt      = await generateSnowflakeJWT(env);
        const question = await getActiveQuestion(jwt, env);
        if (!question) {
          return Response.json({ active: false }, { headers: corsHeaders });
        }
        return Response.json({ active: true, ...question }, { headers: corsHeaders });
      } catch (err) {
        console.error('GET /api/question error:', err.message);
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /api/vote ----
    if (method === 'POST' && path === '/api/vote') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!checkRate(ip)) {
        return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: corsHeaders });
      }

      let body;
      try { body = await request.json(); } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
      }

      const { question_id, option_id, session_id, platform, voted_at_ms, voter_email } = body;
      if (!question_id || !option_id || !session_id) {
        return Response.json({ error: 'Missing fields' }, { status: 400, headers: corsHeaders });
      }

      // Dedup — skip if current question allows multiple votes
      const key = `${session_id}:${question_id}`;
      if (!_cachedAllowMultipleVotes && _voted.has(key)) {
        return Response.json({ ok: true, duplicate: true }, { status: 409, headers: corsHeaders });
      }

      try {
        const jwt        = await generateSnowflakeJWT(env);
        const ingestHost = await getIngestHostname(jwt, env.SNOWFLAKE_ACCOUNT);

        const row = {
          prediction_id:      crypto.randomUUID(),
          question_id,
          option_id,
          predicted_at:       new Date(voted_at_ms || Date.now()).toISOString().replace('T', ' ').replace('Z', ''),
          server_received_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
          session_id,
          platform: platform || 'unknown',
        };

        await streamVote(jwt, ingestHost, env, row);
        if (!_cachedAllowMultipleVotes) _voted.add(key);

        // Stream voter metadata once per session (best-effort, non-fatal)
        const voterKey = `${session_id}:${question_id}`;
        if (!_voterWritten.has(voterKey)) {
          try {
            const cf = request.cf || {};
            const ua = request.headers.get('User-Agent') || '';
            const lang = (request.headers.get('Accept-Language') || '').split(',')[0] || null;
            const { device_type, os, browser } = parseUserAgent(ua);
            const voterRow = {
              session_id, question_id,
              voter_email: body.voter_email || null,
              country:     cf.country     || null,
              region:      cf.region      || null,
              city:        cf.city        || null,
              latitude:    cf.latitude    ? parseFloat(cf.latitude)  : null,
              longitude:   cf.longitude   ? parseFloat(cf.longitude) : null,
              timezone:    cf.timezone    || null,
              device_type, os, browser,
              language:    lang,
              voted_at:    new Date().toISOString().replace('T', ' ').replace('Z', ''),
            };
            await streamVoterMetadata(jwt, ingestHost, env, voterRow);
            _voterWritten.add(voterKey);
          } catch (e) {
            console.warn('voter metadata write failed (non-fatal):', e.message);
          }
        }

        return Response.json({ ok: true, allow_multiple_votes: _cachedAllowMultipleVotes }, { headers: corsHeaders });
      } catch (err) {
        console.error('POST /api/vote error:', err.message);
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
