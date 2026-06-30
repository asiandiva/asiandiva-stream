const https = require('https');
const http  = require('http');
const tls   = require('tls');
const crypto = require('crypto');

const CLIENT_ID      = process.env.CLIENT_ID      || 'phzjmjiuw45a3z5dx56gaoo6ug4fsn';
const CLIENT_SECRET  = process.env.CLIENT_SECRET  || 'isz32c8saws75v4f29p7vk2i4p70vx';
const USER_TOKEN     = process.env.USER_TOKEN      || '';
const BROADCASTER_ID = '716266770';
const PORT           = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'asiandiva-secret-2024';
const CHANNEL_NAME   = (process.env.CHANNEL_NAME || 'asiandiva__').toLowerCase();
const BLERP_BOT      = (process.env.BLERP_BOT    || 'blerp').toLowerCase();

// ── USER OAUTH (for chat/widgets, auto-refresh) ──────────────────
const USER_CLIENT_ID     = process.env.USER_CLIENT_ID     || '';
const USER_CLIENT_SECRET = process.env.USER_CLIENT_SECRET || '';
let   USER_REFRESH_TOKEN = process.env.USER_REFRESH_TOKEN || '';
const AUTH_REDIRECT_URI  = (process.env.RENDER_EXTERNAL_URL || 'https://asiandiva-bits-tracker.onrender.com') + '/auth/callback';
const USER_SCOPES        = 'chat:read chat:edit channel:read:hype_train';

let userAccessToken   = null;
let userTokenExpires  = 0;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getAppToken() {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials'
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'id.twitch.tv',
      path: '/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data).access_token); } catch(e) { reject(e); } });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function subscribe(token, clientId, type, condition, callbackUrl) {
  const body = JSON.stringify({
    type, version: '1', condition,
    transport: { method: 'webhook', callback: callbackUrl, secret: WEBHOOK_SECRET }
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions',
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log('Subscribe', type, res.statusCode);
        resolve(res.statusCode);
      });
    });
    req.setTimeout(10000, () => { req.destroy(); console.log('Timeout:', type); resolve(0); });
    req.on('error', (e) => { console.log('Error:', type, e.message); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── REFRESH USER OAUTH TOKEN ─────────────────────────────────────
async function refreshUserToken() {
  if(!USER_REFRESH_TOKEN || !USER_CLIENT_ID || !USER_CLIENT_SECRET) {
    throw new Error('User OAuth not configured. Set USER_CLIENT_ID, USER_CLIENT_SECRET env vars and visit /auth to get a refresh token.');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: USER_REFRESH_TOKEN,
    client_id: USER_CLIENT_ID,
    client_secret: USER_CLIENT_SECRET
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'id.twitch.tv',
      path: '/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if(json.access_token) {
            userAccessToken  = json.access_token;
            userTokenExpires = Date.now() + (json.expires_in - 120) * 1000; // 2 min safety buffer
            if(json.refresh_token && json.refresh_token !== USER_REFRESH_TOKEN) {
              USER_REFRESH_TOKEN = json.refresh_token;
              console.warn('⚠️  Refresh token rotated. Update Render env USER_REFRESH_TOKEN to:', json.refresh_token);
            }
            console.log('✅ User token refreshed, expires in', json.expires_in, 'sec');
            resolve(userAccessToken);
          } else {
            reject(new Error('Refresh failed: ' + data));
          }
        } catch(e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getUserToken() {
  if(userAccessToken && Date.now() < userTokenExpires) return userAccessToken;
  return refreshUserToken();
}

const clients = new Set();
let recentEvents = [];

function broadcast(event) {
  event._ts = Date.now();
  recentEvents.push(event);
  if(recentEvents.length > 50) recentEvents.shift();
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  clients.forEach(client => {
    try { client.write(data); } catch(e) { clients.delete(client); }
  });
  console.log('📡 Broadcast:', event.type, event.user);
}

function verifySignature(req, body) {
  const msgId     = req.headers['twitch-eventsub-message-id'] || '';
  const timestamp = req.headers['twitch-eventsub-message-timestamp'] || '';
  const signature = req.headers['twitch-eventsub-message-signature'] || '';
  const hmac = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(msgId + timestamp + body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature)); }
  catch(e) { return false; }
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if(req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: {"type":"connected"}\n\n');
    clients.add(res);
    recentEvents.forEach(e => res.write('data: ' + JSON.stringify(e) + '\n\n'));
    req.on('close', () => clients.delete(res));
    return;
  }

  if(req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      status:'ok',
      clients: clients.size,
      user_oauth_configured: !!(USER_CLIENT_ID && USER_CLIENT_SECRET && USER_REFRESH_TOKEN),
      user_token_valid: !!(userAccessToken && Date.now() < userTokenExpires)
    }));
    return;
  }

  // ── USER TOKEN ENDPOINT (widgets fetch fresh tokens from here) ──
  if(req.url === '/user-token') {
    try {
      const token = await getUserToken();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        access_token: token,
        client_id: USER_CLIENT_ID,
        expires_at: userTokenExpires
      }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── AUTH FLOW (one-time setup) ──────────────────────────────────
  if(req.url === '/auth') {
    if(!USER_CLIENT_ID) {
      res.writeHead(500, {'Content-Type':'text/html'});
      res.end('<h1>Not configured</h1><p>Set USER_CLIENT_ID env var on Render first.</p>');
      return;
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: USER_CLIENT_ID,
      redirect_uri: AUTH_REDIRECT_URI,
      scope: USER_SCOPES,
      force_verify: 'true'
    });
    res.writeHead(302, { Location: 'https://id.twitch.tv/oauth2/authorize?' + params.toString() });
    res.end();
    return;
  }

  if(req.url.startsWith('/auth/callback')) {
    const u = new URL(req.url, 'http://localhost');
    const code = u.searchParams.get('code');
    const err  = u.searchParams.get('error');
    if(err) {
      res.writeHead(400, {'Content-Type':'text/html'});
      res.end('<h1>Authorization Error</h1><p>' + err + ': ' + (u.searchParams.get('error_description')||'') + '</p>');
      return;
    }
    if(!code) {
      res.writeHead(400, {'Content-Type':'text/html'});
      res.end('<h1>No code provided</h1>');
      return;
    }
    const body = new URLSearchParams({
      client_id: USER_CLIENT_ID,
      client_secret: USER_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: AUTH_REDIRECT_URI
    }).toString();
    const tokenReq = https.request({
      hostname: 'id.twitch.tv',
      path: '/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, (tokenRes) => {
      let data = '';
      tokenRes.on('data', d => data += d);
      tokenRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          if(json.refresh_token) {
            USER_REFRESH_TOKEN = json.refresh_token;
            userAccessToken    = json.access_token;
            userTokenExpires   = Date.now() + (json.expires_in - 120) * 1000;
            res.writeHead(200, {'Content-Type':'text/html'});
            res.end(`<!DOCTYPE html><html><head><title>Authorized</title></head>
              <body style="font-family:sans-serif;padding:40px;background:#1a0a2e;color:#fff;max-width:700px;margin:auto;line-height:1.6;">
                <h1 style="background:linear-gradient(90deg,#FFD93D,#FF6B9D);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">✅ Authorized!</h1>
                <p>Copy this refresh token and add it to Render env vars as <code style="background:#000;padding:2px 6px;border-radius:4px;">USER_REFRESH_TOKEN</code>:</p>
                <pre style="background:#000;padding:20px;border-radius:8px;word-break:break-all;color:#6EE7B7;font-size:14px;border:1px solid #FFD93D;">${json.refresh_token}</pre>
                <h3 style="color:#FFD93D;">Next steps:</h3>
                <ol>
                  <li>Go to Render dashboard → <strong>asiandiva-bits-tracker</strong> → Environment</li>
                  <li>Add env var: <code>USER_REFRESH_TOKEN</code> = <em>(paste value above)</em></li>
                  <li>Save (Render will auto-redeploy in ~1 min)</li>
                  <li>After deploy, all your widgets auto-refresh their tokens forever! 🎉</li>
                </ol>
                <p style="color:#9B7BB8;font-size:13px;">⚠️ This page will only show once. If you lose it, just visit /auth again.</p>
              </body></html>`);
          } else {
            res.writeHead(500, {'Content-Type':'text/html'});
            res.end('<h1>Twitch error</h1><pre>' + data + '</pre>');
          }
        } catch(e) { res.writeHead(500); res.end(e.message); }
      });
    });
    tokenReq.on('error', (e) => { res.writeHead(500); res.end(e.message); });
    tokenReq.write(body);
    tokenReq.end();
    return;
  }

  if(req.url === '/blerp' && req.method === 'POST') {
    setCORS(res);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if(data.user && data.bits) {
          broadcast({ type:'bits', user:data.user, bits:parseInt(data.bits), source:'blerp' });
          console.log('⚡ Blerp bits from chat:', data.user, data.bits);
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ status:'ok' }));
      } catch(e) {
        res.writeHead(400); res.end('Bad request');
      }
    });
    return;
  }

  if(req.url === '/reset' && req.method === 'POST') {
    setCORS(res);
    recentEvents = [];
    console.log('🔄 Event buffer cleared via reset');
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'ok', message:'Event buffer cleared' }));
    return;
  }

  if(req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      if(!verifySignature(req, body)) { res.writeHead(403); res.end('Forbidden'); return; }
      const msg     = JSON.parse(body);
      const msgType = req.headers['twitch-eventsub-message-type'];

      if(msgType === 'webhook_callback_verification') {
        console.log('✅ Verified:', msg.subscription.type);
        res.writeHead(200, {'Content-Type':'text/plain'});
        res.end(msg.challenge);
        return;
      }

      if(msgType === 'notification') {
        const type = msg.subscription.type;
        const ev   = msg.event;
        if(type === 'channel.cheer')
          broadcast({ type:'bits', user: ev.user_name||'Anonymous', bits: ev.bits });
        if(type === 'channel.subscribe' && !ev.is_gift)
          broadcast({ type:'sub', user: ev.user_name, tier: ev.tier });
        if(type === 'channel.subscription.message')
          broadcast({ type:'resub', user: ev.user_name, tier: ev.tier, months: ev.cumulative_months });
        if(type === 'channel.subscription.gift')
          broadcast({ type:'giftsub', user: ev.user_name||'Anonymous', tier: ev.tier, count: ev.total });
        res.writeHead(204); res.end();
        return;
      }
      res.writeHead(200); res.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('🚀 Server running on port', PORT);
  setupSubscriptions();
  connectIRC();
  // Pre-warm user token on startup if configured
  if(USER_CLIENT_ID && USER_CLIENT_SECRET && USER_REFRESH_TOKEN) {
    refreshUserToken().catch(e => console.warn('Initial user token refresh failed:', e.message));
  }
});

async function deleteAllSubs(token, clientId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions',
      method: 'GET',
      headers: { 'Client-Id': clientId, 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          const subs = json.data || [];
          console.log('Deleting', subs.length, 'existing subscriptions');
          for(const s of subs) {
            await deleteSub(token, clientId, s.id);
          }
        } catch(e) {}
        resolve();
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end();
  });
}

async function deleteSub(token, clientId, id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions?id=' + id,
      method: 'DELETE',
      headers: { 'Client-Id': clientId, 'Authorization': 'Bearer ' + token }
    }, (res) => { res.on('data', ()=>{}); res.on('end', resolve); });
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end();
  });
}

async function setupSubscriptions() {
  try {
    const callbackUrl = (process.env.RENDER_EXTERNAL_URL || 'https://asiandiva-bits-tracker.onrender.com') + '/webhook';
    console.log('📌 Callback URL:', callbackUrl);

    const appTok = await getAppToken();
    console.log('✅ App token obtained');

    await deleteAllSubs(appTok, CLIENT_ID);

    await subscribe(appTok, CLIENT_ID, 'channel.cheer',                { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    await subscribe(appTok, CLIENT_ID, 'channel.subscribe',            { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    await subscribe(appTok, CLIENT_ID, 'channel.subscription.message', { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    await subscribe(appTok, CLIENT_ID, 'channel.subscription.gift',    { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    console.log('✅ All subscriptions done');
  } catch(e) {
    console.error('Subscription error:', e.message);
  }
}

let ircClient;
let ircReconnectTimer;
let ircWatchdogTimer;
let ircSelfPingTimer;
let lastIRCData = 0;
let ircState = 'disconnected';

const IRC_SELF_PING_MS = 4 * 60 * 1000;
const IRC_WATCHDOG_MS  = 60 * 1000;
const IRC_STALE_MS     = 6 * 60 * 1000;

function forceReconnectIRC(reason) {
  console.warn(`[IRC] ⚠️  Forcing reconnect: ${reason}`);
  try { ircClient && ircClient.destroy(); } catch(e) {}
  if (ircSelfPingTimer) { clearInterval(ircSelfPingTimer); ircSelfPingTimer = null; }
  if (ircWatchdogTimer) { clearInterval(ircWatchdogTimer); ircWatchdogTimer = null; }
  ircState = 'disconnected';
  if (!ircReconnectTimer) {
    ircReconnectTimer = setTimeout(connectIRC, 3000);
  }
}

function connectIRC() {
  if (ircReconnectTimer) { clearTimeout(ircReconnectTimer); ircReconnectTimer = null; }
  if (ircSelfPingTimer) { clearInterval(ircSelfPingTimer); ircSelfPingTimer = null; }
  if (ircWatchdogTimer) { clearInterval(ircWatchdogTimer); ircWatchdogTimer = null; }
  ircState = 'connecting';
  console.log(`[IRC] Connecting to irc.chat.twitch.tv:6697 (TLS) → #${CHANNEL_NAME}, watching for "${BLERP_BOT}"...`);

  let buffer = '';

  ircClient = tls.connect({ host: 'irc.chat.twitch.tv', port: 6697, checkServerIdentity: () => undefined }, () => {
    ircClient.write('PASS oauth:justinfan12345\r\n');
    ircClient.write('NICK justinfan12345\r\n');
    ircClient.write(`JOIN #${CHANNEL_NAME}\r\n`);
    ircState = 'connected';
    lastIRCData = Date.now();
    console.log(`[IRC] ✅ Connected → #${CHANNEL_NAME}`);

    ircSelfPingTimer = setInterval(() => {
      try {
        ircClient.write('PING :tmi.twitch.tv\r\n');
      } catch(e) {}
    }, IRC_SELF_PING_MS);

    ircWatchdogTimer = setInterval(() => {
      const ageMs = Date.now() - lastIRCData;
      if (ageMs > IRC_STALE_MS) {
        forceReconnectIRC(`no data for ${Math.round(ageMs/1000)}s`);
      }
    }, IRC_WATCHDOG_MS);
  });

  ircClient.on('data', (data) => {
    lastIRCData = Date.now();
    buffer += data.toString();
    const lines = buffer.split('\r\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        ircClient.write('PONG :tmi.twitch.tv\r\n');
        continue;
      }

      const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)$/);
      if (!match) continue;

      const username = match[1].toLowerCase();
      const message  = match[2];

      if (username !== BLERP_BOT) continue;

      console.log(`[Blerp] ${BLERP_BOT}: ${message}`);

      const bitsMatch = message.match(/(?:for|using|with)\s+(\d+)/i) || message.match(/(\d+)\s*bits/i);
      if (!bitsMatch) {
        console.log(`[Blerp] Couldn't parse bits from: "${message}"`);
        continue;
      }
      const bits = parseInt(bitsMatch[1], 10);
      if (bits <= 0) continue;
      const viewerName = message.split(' ')[0];

      broadcast({
        type: 'bits',
        user: viewerName,
        bits,
        source: 'blerp'
      });
    }
  });

  ircClient.on('close', () => {
    ircState = 'disconnected';
    if (ircSelfPingTimer) { clearInterval(ircSelfPingTimer); ircSelfPingTimer = null; }
    if (ircWatchdogTimer) { clearInterval(ircWatchdogTimer); ircWatchdogTimer = null; }
    console.warn('[IRC] Disconnected — reconnecting in 5s');
    if (!ircReconnectTimer) {
      ircReconnectTimer = setTimeout(connectIRC, 5000);
    }
  });

  ircClient.on('error', (err) => {
    console.error('[IRC] Error:', err.message);
  });
}
