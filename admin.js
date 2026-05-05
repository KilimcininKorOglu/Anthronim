import fs from 'node:fs';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addKey, removeKey, toggleKey, listKeys, getStats, getLogs, addToken, removeToken, toggleToken, updateToken, listTokens, listBenchmarkModels, addBenchmarkModel, removeBenchmarkModel, toggleBenchmarkModel } from './db.js';
import { renderTemplate, getLang } from './lang.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const AUTH_TOKEN_ENV = process.env.AUTH_TOKEN;
const adminEnabled = !!(ADMIN_USER && ADMIN_PASS);

const rawAdminPath = process.env.ADMIN_PATH || '/admin';
export const ADMIN_PATH = (rawAdminPath.startsWith('/') ? rawAdminPath : '/' + rawAdminPath).replace(/\/+$/, '');

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const NVIDIA_MODELS_URL = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1') + '/models';
const MODEL_CACHE_TTL = parseInt(process.env.MODEL_CACHE_TTL || '3600000', 10);
let modelCache = null;
let modelCacheTime = 0;

export const authFailures = new Map();
const AUTH_FAILURES_MAP_MAX = 10000;
export const MAX_FAILURES = parseInt(process.env.MAX_AUTH_FAILURES || '5', 10);
export const LOCKOUT_MS = parseInt(process.env.LOCKOUT_MINUTES || '15', 10) * 60 * 1000;

const JWT_SECRET = process.env.ADMIN_JWT_SECRET || randomBytes(32).toString('hex');
const JWT_EXPIRY_SEC = parseInt(process.env.ADMIN_JWT_HOURS || '168', 10) * 3600;
if (!process.env.ADMIN_JWT_SECRET) console.warn('ADMIN_JWT_SECRET not set — sessions invalidated on every restart');

function base64url(buf) { return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64url'); }

function signJwt(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + JWT_EXPIRY_SEC }));
  const sig = base64url(createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const sigBuf = Buffer.from(base64url(createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest()));
  const candBuf = Buffer.from(parts[2]);
  if (sigBuf.length !== candBuf.length || !timingSafeEqual(sigBuf, candBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of authFailures) {
    if (now >= record.resetAt) authFailures.delete(ip);
  }
}, parseInt(process.env.LOCKOUT_CLEANUP_MINUTES || '5', 10) * 60 * 1000);

function preRender(filePath) {
  let raw = fs.readFileSync(join(__dirname, filePath), 'utf8');
  if (ADMIN_PATH !== '/admin') raw = raw.replaceAll('/admin', ADMIN_PATH);
  return { tr: renderTemplate(raw, 'tr'), en: renderTemplate(raw, 'en') };
}
const adminHtml = preRender('admin.html');
const logsHtml = preRender('logs.html');

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function sendJson(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

function checkBasicAuth(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  return safeEqual(user, ADMIN_USER) && safeEqual(pass, ADMIN_PASS);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function getClientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',').pop().trim();
  }
  return req.socket.remoteAddress;
}

function requireAuth(req, res) {
  const jwt = parseCookie(req, 'admin_token');
  if (verifyJwt(jwt)) return true;
  const ip = getClientIp(req);
  const record = authFailures.get(ip);
  if (record && record.count >= MAX_FAILURES && Date.now() < record.resetAt) {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.writeHead(302, { 'Location': ADMIN_PATH + '/login?error=lockout' });
      res.end();
    } else {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(Math.ceil((record.resetAt - Date.now()) / 1000)) });
      res.end('Too Many Requests');
    }
    return false;
  }
  if (checkBasicAuth(req)) {
    authFailures.delete(ip);
    return true;
  }
  const now = Date.now();
  if (!record || now >= record.resetAt) {
    const prev = record ? record.lockoutCount || 0 : 0;
    if (authFailures.size >= AUTH_FAILURES_MAP_MAX) authFailures.delete(authFailures.keys().next().value);
    authFailures.set(ip, { count: 1, resetAt: now + LOCKOUT_MS, lockoutCount: prev });
  } else {
    record.count++;
    if (record.count >= MAX_FAILURES) {
      record.lockoutCount = (record.lockoutCount || 0) + 1;
      const backoff = LOCKOUT_MS * Math.pow(2, Math.min(record.lockoutCount, 4));
      record.resetAt = Date.now() + backoff;
    }
  }
  const accept = req.headers['accept'] || '';
  if (accept.includes('text/html')) {
    res.writeHead(302, { 'Location': ADMIN_PATH + '/login' });
    res.end();
  } else {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
  }
  return false;
}

function maskKey(key) {
  if (key.length <= 12) return '****' + key.slice(-4);
  return key.slice(0, 8) + '****...' + key.slice(-4);
}

const MAX_BODY = parseInt(process.env.ADMIN_MAX_BODY_MB || '1', 10) * 1024 * 1024;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy();
      throw Object.assign(new Error('Body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function extractIdFromPath(pathname) {
  // /admin/api/keys/123 → 123
  const parts = pathname.split('/');
  return parseInt(parts[parts.length - 1], 10);
}

async function readFormBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); return null; }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

const LOGIN_HTML_RAW = `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>{{login_title}}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='4' fill='%23000'/%3E%3Ctext x='4' y='23' font-family='monospace' font-size='22' font-weight='700' fill='%2300ff41'%3E%3E_%3C/text%3E%3C/svg%3E">
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono',monospace;background:#000;color:#00ff41;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.login{width:100%;max-width:360px}
h1{font-size:14px;font-weight:700;letter-spacing:2px;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid #1a1a1a}
.field{margin-bottom:16px}
.field label{display:block;font-size:10px;letter-spacing:1.5px;margin-bottom:6px}
.field input{width:100%;background:#0a0a0a;border:1px solid #1a1a1a;color:#00ff41;padding:10px 12px;font-family:inherit;font-size:12px;outline:none}
.field input:focus{border-color:#006b1d}
button{width:100%;background:#002a0a;border:1px solid #006b1d;color:#00ff41;padding:10px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;margin-top:8px}
.error{color:#ff2d2d;font-size:11px;margin-bottom:16px}
</style></head><body>
<div class="login">
<h1>{{login_heading}}</h1>
<div class="error" id="err"></div>
<form method="POST" action="/admin/login">
<div class="field"><label>{{username}}</label><input name="username" autocomplete="username" required autofocus></div>
<div class="field"><label>{{password}}</label><input name="password" type="password" autocomplete="current-password" required></div>
<button type="submit">{{login_btn}}</button>
</form></div>
<script>
const p=new URLSearchParams(location.search);
const e=document.getElementById('err');
if(p.get('error')==='invalid')e.textContent='{{login_invalid}}';
if(p.get('error')==='lockout')e.textContent='{{login_lockout}}';
</script></body></html>`;
function preRenderLogin() {
  let raw = ADMIN_PATH === '/admin' ? LOGIN_HTML_RAW : LOGIN_HTML_RAW.replaceAll('/admin/login', ADMIN_PATH + '/login');
  return { tr: renderTemplate(raw, 'tr'), en: renderTemplate(raw, 'en') };
}
const loginHtml = preRenderLogin();

export async function handleAdmin(req, res, pathname) {
  if (!adminEnabled) {
    sendJson(res, 404, { error: { type: 'not_found', message: '[Proxy] Not found' } });
    return;
  }

  const sub = pathname.slice(ADMIN_PATH.length);

  if (sub === '/login' && req.method === 'GET') {
    const lang = getLang(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-store' });
    res.end(loginHtml[lang]);
    return;
  }

  if (sub === '/login' && req.method === 'POST') {
    const ip = getClientIp(req);
    const record = authFailures.get(ip);
    if (record && record.count >= MAX_FAILURES && Date.now() < record.resetAt) {
      res.writeHead(302, { 'Location': ADMIN_PATH + '/login?error=lockout' });
      res.end();
      return;
    }
    const body = await readFormBody(req);
    if (!body || !safeEqual(body.username || '', ADMIN_USER) || !safeEqual(body.password || '', ADMIN_PASS)) {
      const now = Date.now();
      if (!record || now >= record.resetAt) {
        const prev = record ? record.lockoutCount || 0 : 0;
        if (authFailures.size >= AUTH_FAILURES_MAP_MAX) authFailures.delete(authFailures.keys().next().value);
        authFailures.set(ip, { count: 1, resetAt: now + LOCKOUT_MS, lockoutCount: prev });
      } else {
        record.count++;
        if (record.count >= MAX_FAILURES) {
          record.lockoutCount = (record.lockoutCount || 0) + 1;
          record.resetAt = Date.now() + LOCKOUT_MS * Math.pow(2, Math.min(record.lockoutCount, 4));
        }
      }
      res.writeHead(302, { 'Location': ADMIN_PATH + '/login?error=invalid' });
      res.end();
      return;
    }
    authFailures.delete(ip);
    const token = signJwt({ user: ADMIN_USER });
    res.writeHead(302, {
      'Location': ADMIN_PATH,
      'Set-Cookie': `admin_token=${token}; Path=${ADMIN_PATH}; HttpOnly; SameSite=Lax; Secure; Max-Age=${JWT_EXPIRY_SEC}`,
    });
    res.end();
    return;
  }

  if (sub === '/logout') {
    res.writeHead(302, {
      'Location': ADMIN_PATH + '/login',
      'Set-Cookie': `admin_token=; Path=${ADMIN_PATH}; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
    });
    res.end();
    return;
  }

  if (!requireAuth(req, res)) return;

  // GET /admin — Dashboard HTML
  if (sub === '' && req.method === 'GET') {
    const lang = getLang(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-store' });
    res.end(adminHtml[lang]);
    return;
  }

  // GET /admin/logs — Logs HTML
  if (sub === '/logs' && req.method === 'GET') {
    const lang = getLang(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-store' });
    res.end(logsHtml[lang]);
    return;
  }

  // GET /admin/api/stats
  if (sub === '/api/stats' && req.method === 'GET') {
    sendJson(res, 200, getStats());
    return;
  }

  // GET /admin/api/logs
  if (sub === '/api/logs' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const status = url.searchParams.get('status');
    const model = url.searchParams.get('model') || null;
    sendJson(res, 200, getLogs({ limit, offset, statusMin: status === 'error' ? 400 : null, model }));
    return;
  }

  // GET /admin/api/models
  if (sub === '/api/models' && req.method === 'GET') {
    const now = Date.now();
    if (!modelCache || (now - modelCacheTime) >= MODEL_CACHE_TTL) {
      try {
        const upstream = await fetch(NVIDIA_MODELS_URL);
        if (upstream.ok) {
          modelCache = await upstream.json();
          modelCacheTime = now;
        }
      } catch (e) { /* use stale cache */ }
    }
    sendJson(res, 200, modelCache || { object: 'list', data: [] });
    return;
  }

  // GET /admin/api/keys
  if (sub === '/api/keys' && req.method === 'GET') {
    const keys = listKeys().map(k => ({
      ...k,
      key: maskKey(k.key),
    }));
    sendJson(res, 200, keys);
    return;
  }

  // POST /admin/api/keys
  if (sub === '/api/keys' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.key || typeof body.key !== 'string') {
        sendJson(res, 400, { error: 'key alanı zorunlu' });
        return;
      }
      const id = addKey(body.key.trim(), (body.label || '').trim());
      sendJson(res, 201, { id });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        sendJson(res, 409, { error: 'Bu API anahtarı zaten mevcut' });
        return;
      }
      throw err;
    }
    return;
  }

  // DELETE /admin/api/keys/:id
  if (sub.startsWith('/api/keys/') && req.method === 'DELETE') {
    const id = extractIdFromPath(pathname);
    if (isNaN(id)) {
      sendJson(res, 400, { error: 'Geçersiz ID' });
      return;
    }
    const removed = removeKey(id);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Anahtar bulunamadı' });
    return;
  }

  // PATCH /admin/api/keys/:id
  if (sub.startsWith('/api/keys/') && req.method === 'PATCH') {
    const id = extractIdFromPath(pathname);
    if (isNaN(id)) {
      sendJson(res, 400, { error: 'Geçersiz ID' });
      return;
    }
    const body = await readJsonBody(req);
    if (typeof body.isActive !== 'boolean') {
      sendJson(res, 400, { error: 'isActive (boolean) alanı zorunlu' });
      return;
    }
    const toggled = toggleKey(id, body.isActive);
    sendJson(res, toggled ? 200 : 404, toggled ? { ok: true } : { error: 'Anahtar bulunamadı' });
    return;
  }

  // GET /admin/api/tokens
  if (sub === '/api/tokens' && req.method === 'GET') {
    const tokens = listTokens().map(t => ({
      ...t,
      token: t.plaintext || t.token.slice(0, 12) + '...',
      plaintext: undefined,
    }));
    sendJson(res, 200, tokens);
    return;
  }

  // POST /admin/api/tokens
  if (sub === '/api/tokens' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.token || typeof body.token !== 'string') {
        sendJson(res, 400, { error: 'token alanı zorunlu' });
        return;
      }
      const id = addToken(body.token.trim(), (body.label || '').trim());
      sendJson(res, 201, { id });
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        sendJson(res, 409, { error: 'Bu erişim anahtarı zaten mevcut' });
        return;
      }
      throw err;
    }
    return;
  }

  // DELETE /admin/api/tokens/:id
  if (sub.startsWith('/api/tokens/') && req.method === 'DELETE') {
    const id = extractIdFromPath(pathname);
    if (isNaN(id)) {
      sendJson(res, 400, { error: 'Geçersiz ID' });
      return;
    }
    const activeCount = listTokens().filter(t => t.is_active && t.id !== id).length;
    if (activeCount === 0 && !AUTH_TOKEN_ENV) {
      sendJson(res, 400, { error: 'Son aktif erişim anahtarı silinemez' });
      return;
    }
    const removed = removeToken(id);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Erişim anahtarı bulunamadı' });
    return;
  }

  // PATCH /admin/api/tokens/:id
  if (sub.startsWith('/api/tokens/') && req.method === 'PATCH') {
    const id = extractIdFromPath(pathname);
    if (isNaN(id)) {
      sendJson(res, 400, { error: 'Geçersiz ID' });
      return;
    }
    const body = await readJsonBody(req);
    // Token and/or label update
    if (typeof body.label === 'string' || typeof body.token === 'string') {
      const updated = updateToken(id, {
        label: typeof body.label === 'string' ? body.label.trim() : undefined,
        token: typeof body.token === 'string' ? body.token.trim() : undefined,
      });
      sendJson(res, updated ? 200 : 404, updated ? { ok: true } : { error: 'Erişim anahtarı bulunamadı' });
      return;
    }
    if (typeof body.isActive !== 'boolean') {
      sendJson(res, 400, { error: 'isActive, label veya token alanı zorunlu' });
      return;
    }
    if (!body.isActive) {
      const activeCount = listTokens().filter(t => t.is_active && t.id !== id).length;
      if (activeCount === 0 && !AUTH_TOKEN_ENV) {
        sendJson(res, 400, { error: 'Son aktif erişim anahtarı devre dışı bırakılamaz' });
        return;
      }
    }
    const toggled = toggleToken(id, body.isActive);
    sendJson(res, toggled ? 200 : 404, toggled ? { ok: true } : { error: 'Erişim anahtarı bulunamadı' });
    return;
  }

  // GET /admin/api/benchmarks
  if (sub === '/api/benchmarks' && req.method === 'GET') {
    sendJson(res, 200, listBenchmarkModels());
    return;
  }

  // POST /admin/api/benchmarks
  if (sub === '/api/benchmarks' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.model || typeof body.model !== 'string') {
      sendJson(res, 400, { error: 'model alanı zorunlu' });
      return;
    }
    addBenchmarkModel(body.model.trim());
    sendJson(res, 201, { ok: true });
    return;
  }

  // DELETE /admin/api/benchmarks/:id
  if (sub.startsWith('/api/benchmarks/') && req.method === 'DELETE') {
    const id = extractIdFromPath(pathname);
    if (isNaN(id)) {
      sendJson(res, 400, { error: 'Geçersiz ID' });
      return;
    }
    const removed = removeBenchmarkModel(id);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Bulunamadı' });
    return;
  }

  // PATCH /admin/api/benchmarks/:id
  if (sub.startsWith('/api/benchmarks/') && req.method === 'PATCH') {
    const id = extractIdFromPath(pathname);
    if (isNaN(id)) {
      sendJson(res, 400, { error: 'Geçersiz ID' });
      return;
    }
    const body = await readJsonBody(req);
    if (typeof body.isActive !== 'boolean') {
      sendJson(res, 400, { error: 'isActive alanı zorunlu' });
      return;
    }
    const toggled = toggleBenchmarkModel(id, body.isActive);
    sendJson(res, toggled ? 200 : 404, toggled ? { ok: true } : { error: 'Bulunamadı' });
    return;
  }

  sendJson(res, 404, { error: { type: 'not_found', message: '[Proxy] Not found' } });
}
