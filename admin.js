import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addKey, removeKey, toggleKey, listKeys, getStats, getLogs, addToken, removeToken, toggleToken, listTokens } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const AUTH_TOKEN_ENV = process.env.AUTH_TOKEN;
const adminEnabled = !!(ADMIN_USER && ADMIN_PASS);

const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
const MODEL_CACHE_TTL = parseInt(process.env.MODEL_CACHE_TTL || '3600000', 10);
let modelCache = null;
let modelCacheTime = 0;

const authFailures = new Map();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of authFailures) {
    if (now >= record.resetAt) authFailures.delete(ip);
  }
}, 5 * 60 * 1000);

let cachedHtml = null;
let cachedLogsHtml = null;

function loadHtml() {
  if (!cachedHtml) {
    cachedHtml = fs.readFileSync(join(__dirname, 'admin.html'), 'utf8');
  }
  return cachedHtml;
}

function loadLogsHtml() {
  if (!cachedLogsHtml) {
    cachedLogsHtml = fs.readFileSync(join(__dirname, 'logs.html'), 'utf8');
  }
  return cachedLogsHtml;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return xff ? xff.split(',').pop().trim() : req.socket.remoteAddress;
}

function requireAuth(req, res) {
  const ip = getClientIp(req);
  const record = authFailures.get(ip);
  if (record && record.count >= MAX_FAILURES && Date.now() < record.resetAt) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(Math.ceil((record.resetAt - Date.now()) / 1000)) });
    res.end('Too Many Requests');
    return false;
  }
  if (!checkBasicAuth(req)) {
    const now = Date.now();
    if (!record || now >= record.resetAt) {
      authFailures.set(ip, { count: 1, resetAt: now + LOCKOUT_MS });
    } else {
      record.count++;
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Anthronim Admin"', 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return false;
  }
  authFailures.delete(ip);
  return true;
}

function maskKey(key) {
  if (key.length <= 12) return '****' + key.slice(-4);
  return key.slice(0, 8) + '****...' + key.slice(-4);
}

const MAX_BODY = 1 * 1024 * 1024;

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

export async function handleAdmin(req, res, pathname) {
  if (!adminEnabled) {
    sendJson(res, 404, { error: { type: 'not_found', message: 'Bulunamadı' } });
    return;
  }

  if (!requireAuth(req, res)) return;

  // GET /admin — Dashboard HTML
  if (pathname === '/admin' && req.method === 'GET') {
    const html = loadHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    res.end(html);
    return;
  }

  // GET /admin/logs — Logs HTML
  if (pathname === '/admin/logs' && req.method === 'GET') {
    const html = loadLogsHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    res.end(html);
    return;
  }

  // GET /admin/api/stats
  if (pathname === '/admin/api/stats' && req.method === 'GET') {
    sendJson(res, 200, getStats());
    return;
  }

  // GET /admin/api/logs
  if (pathname === '/admin/api/logs' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const status = url.searchParams.get('status');
    const model = url.searchParams.get('model') || null;
    sendJson(res, 200, getLogs({ limit, offset, statusMin: status === 'error' ? 400 : null, model }));
    return;
  }

  // GET /admin/api/models
  if (pathname === '/admin/api/models' && req.method === 'GET') {
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
  if (pathname === '/admin/api/keys' && req.method === 'GET') {
    const keys = listKeys().map(k => ({
      ...k,
      key: maskKey(k.key),
    }));
    sendJson(res, 200, keys);
    return;
  }

  // POST /admin/api/keys
  if (pathname === '/admin/api/keys' && req.method === 'POST') {
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
  if (pathname.startsWith('/admin/api/keys/') && req.method === 'DELETE') {
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
  if (pathname.startsWith('/admin/api/keys/') && req.method === 'PATCH') {
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
  if (pathname === '/admin/api/tokens' && req.method === 'GET') {
    const tokens = listTokens().map(t => ({
      ...t,
      token: maskKey(t.token),
    }));
    sendJson(res, 200, tokens);
    return;
  }

  // POST /admin/api/tokens
  if (pathname === '/admin/api/tokens' && req.method === 'POST') {
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
  if (pathname.startsWith('/admin/api/tokens/') && req.method === 'DELETE') {
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
  if (pathname.startsWith('/admin/api/tokens/') && req.method === 'PATCH') {
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

  sendJson(res, 404, { error: { type: 'not_found', message: 'Bulunamadı' } });
}
