import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addKey, removeKey, toggleKey, listKeys, getStats } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const adminEnabled = !!(ADMIN_USER && ADMIN_PASS);

let cachedHtml = null;

function loadHtml() {
  if (!cachedHtml) {
    cachedHtml = fs.readFileSync(join(__dirname, 'admin.html'), 'utf8');
  }
  return cachedHtml;
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
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

function requireAuth(req, res) {
  if (!checkBasicAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Anthronim Admin"', 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return false;
  }
  return true;
}

function maskKey(key) {
  if (key.length <= 12) return '****' + key.slice(-4);
  return key.slice(0, 8) + '****...' + key.slice(-4);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // GET /admin/api/stats
  if (pathname === '/admin/api/stats' && req.method === 'GET') {
    sendJson(res, 200, getStats());
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

  sendJson(res, 404, { error: { type: 'not_found', message: 'Bulunamadı' } });
}
