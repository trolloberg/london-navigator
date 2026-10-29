// Schedule – Push-Server für Cloudflare Workers (der kostenlose Plan reicht).
// Er speichert nur das Push-Abo deines iPhones und die Uhrzeiten deiner Blocker, keine Namen.
// Ein Cron-Trigger läuft jede Minute und schickt ein Signal, wenn eine Uhrzeit dran ist.
// Den Text der Mitteilung baut dein iPhone selbst aus dem Plan, der nur auf dem Gerät liegt.
// Einrichtung: siehe Vault-Notiz „Schedule – Push-Server einrichten“. Benötigt eine KV-Bindung namens KV.

const APP_ORIGIN = 'https://trolloberg.github.io';
const CONTACT = 'https://trolloberg.github.io/london-navigator/stundenplan/';
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const MAX_SUBS = 5, MAX_TIMES = 600;
const enc = new TextEncoder();

export default {
  async fetch(req, env){
    const cors = { 'Access-Control-Allow-Origin': APP_ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    const out = (body, status = 200) => new Response(body, { status, headers: { ...cors, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.KV) return out('Die KV-Bindung „KV“ fehlt. Siehe Anleitung, Schritt 4.', 500);
    const path = new URL(req.url).pathname;
    try {
      if (req.method === 'GET' && path === '/') return out('Schedule-Push-Server läuft.');
      if (req.method === 'GET' && path === '/key') return out((await vapid(env)).pub);
      if (req.method !== 'POST') return out('Nicht gefunden', 404);
      const origin = req.headers.get('origin');
      if (origin && origin !== APP_ORIGIN) return out('Nicht erlaubt', 403);
      const body = await req.json();
      if (path === '/sync') return out(await sync(env, body));
      if (path === '/test' || path === '/off'){
        const subs = await load(env), id = await hash(String(body && body.endpoint || '')), x = subs[id];
        if (path === '/off'){ if (x){ delete subs[id]; await store(env, subs); } return out('ok'); }
        if (!x) return out('Abo unbekannt, bitte zuerst abgleichen.', 404);
        const r = await send(env, x.sub, { test: 1 });
        if (r.status === 404 || r.status === 410){ delete subs[id]; await store(env, subs); }
        return out('Push-Dienst: ' + r.status, r.ok ? 200 : 502);
      }
      return out('Nicht gefunden', 404);
    } catch (e) { return out('Fehler: ' + (e && e.message || e), 400); }
  },
  // Jede Minute: Wer hat genau jetzt einen Blocker? (scheduledTime ist auf die Minute genau)
  async scheduled(ctrl, env, ctx){ ctx.waitUntil(due(env, ctrl.scheduledTime)); }
};

async function sync(env, b){
  const sub = cleanSub(b && b.sub); if (!sub) throw new Error('Ungültiges Push-Abo');
  const now = Date.now();
  const times = [...new Set((Array.isArray(b.times) ? b.times : []).map(Number).filter(t => Number.isInteger(t) && t > now - 864e5 && t < now + 45 * 864e5))].sort((x, y) => x - y).slice(0, MAX_TIMES);
  const subs = await load(env);
  subs[await hash(sub.endpoint)] = { sub, times, upd: now };
  for (const id of Object.keys(subs).sort((x, y) => subs[y].upd - subs[x].upd).slice(MAX_SUBS)) delete subs[id];
  await store(env, subs);
  return 'ok ' + times.length;
}
async function due(env, st){
  const subs = await load(env), dead = [];
  await Promise.all(Object.entries(subs).map(async ([id, x]) => {
    const t = x.times.find(t => t >= st - 30000 && t < st + 30000);
    if (t === undefined) return;
    try { const r = await send(env, x.sub, { t }); if (r.status === 404 || r.status === 410) dead.push(id); } catch (e) {}
  }));
  if (dead.length){ for (const id of dead) delete subs[id]; await store(env, subs); }
}
const load = async env => (await env.KV.get('subs', 'json')) || {};
const store = (env, subs) => env.KV.put('subs', JSON.stringify(subs));
function cleanSub(s){
  if (!s || typeof s.endpoint !== 'string' || !s.keys) return null;
  let u; try { u = new URL(s.endpoint); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some(r => r.test(u.hostname))) return null;
  const p = String(s.keys.p256dh || ''), a = String(s.keys.auth || '');
  try { if (b64d(p).length !== 65 || b64d(a).length < 16) return null; } catch (e) { return null; }
  return { endpoint: s.endpoint, keys: { p256dh: p, auth: a } };
}

/* ---------- Senden (RFC 8030/8291/8292: verschlüsselt, mit VAPID) ---------- */
async function send(env, sub, data){
  const v = await vapid(env), aud = new URL(sub.endpoint).origin;
  return fetch(sub.endpoint, { method: 'POST', body: await encrypt(sub, JSON.stringify(data)), headers: {
    'TTL': '600', 'Urgency': 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    'Authorization': `vapid t=${await jwt(v, aud)}, k=${v.pub}`
  } });
}
let VAPID = null;
async function vapid(env){
  if (VAPID) return VAPID;
  let v = await env.KV.get('vapid', 'json');
  if (!v){
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.KV.put('vapid', JSON.stringify(v));
  }
  return VAPID = v;
}
const JWT = {};
async function jwt(v, aud){
  const now = Math.floor(Date.now() / 1000), c = JWT[aud];
  if (c && c.exp - now > 3600) return c.t;
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const exp = now + 12 * 3600;
  const data = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(enc.encode(JSON.stringify({ aud, exp, sub: CONTACT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data));
  JWT[aud] = { t: data + '.' + b64u(sig), exp };
  return JWT[aud].t;
}
async function encrypt(sub, text){
  const ua = b64d(sub.keys.p256dh), auth = b64d(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21 + asPub.length);
  head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length; head.set(asPub, 21);
  return cat(head, ct);
}
async function hkdf(salt, ikm, info, len){
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function hash(s){ return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(''); }
function cat(...a){ const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a){ o.set(x, i); i += x.length; } return o; }
function b64u(buf){ let s = ''; for (const c of new Uint8Array(buf)) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64d(s){ s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
