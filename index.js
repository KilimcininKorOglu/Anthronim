import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { initDb, getNextKey, logRequest, hasKeys, validateToken, hasTokens, toggleKey, cleanupOldLogs, getPublicStats, listBenchmarkModels, upsertBenchmark, addToken, addRegistration, findRegistration, incrementRegistrationAttempts, deleteRegistration, cleanupExpiredRegistrations, hasRecentRegistration, deactivateTokenByEmail, hashToken, invalidateTokenCache } from './db.js';
import { handleAdmin, ADMIN_PATH, getClientIp } from './admin.js';
import { renderTemplate, getLang, translations } from './lang.js';

loadDotEnv();
initDb();
cleanupOldLogs();
cleanupExpiredRegistrations();
const LOG_CLEANUP_MS = parseInt(process.env.LOG_CLEANUP_HOURS || '6', 10) * 60 * 60 * 1000;
setInterval(() => {
  cleanupOldLogs();
  cleanupExpiredRegistrations();
  const now = Date.now();
  for (const [ip, rec] of regIpCounter) { if (now >= rec.resetAt) regIpCounter.delete(ip); }
}, LOG_CLEANUP_MS);

const API_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const BENCH_SHORT_PROMPT = 'Say hi in one word.';
const BENCH_LONG_PROMPT = 'Write a Python binary search tree implementation with insert, delete, search, and traversal. Include docstrings.';
const BENCH_INTERVAL = parseInt(process.env.BENCH_INTERVAL_MINUTES || '60', 10) * 60 * 1000;
let indexHtmlRaw = fs.readFileSync(new URL('index.html', import.meta.url), 'utf8');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const AUTH_TOKEN_ENV = process.env.AUTH_TOKEN;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Anthronim';
const REG_MAX_PER_IP = parseInt(process.env.REG_MAX_PER_IP || '10', 10);
const REG_IP_WINDOW_MS = parseInt(process.env.REG_IP_WINDOW_MINUTES || '60', 10) * 60 * 1000;
const regIpCounter = new Map();

if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
  indexHtmlRaw = indexHtmlRaw.replace(/<!-- REGISTRATION_START -->[\s\S]*?<!-- REGISTRATION_END -->/, '<p>{{no_brevo}}</p>');
}
const indexHtml = { tr: renderTemplate(indexHtmlRaw, 'tr'), en: renderTemplate(indexHtmlRaw, 'en') };
const indexEtag = {
  tr: W(indexHtml.tr),
  en: W(indexHtml.en),
};

const MODEL_CACHE_TTL = parseInt(process.env.MODEL_CACHE_TTL || '3600000', 10);
let modelCache = null;
let modelCacheTime = 0;

const ROBOTS_TXT = `User-agent: *\nAllow: /\nSitemap: https://nvidia.srv.hermestech.uk/sitemap.xml\n`;
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://nvidia.srv.hermestech.uk/</loc><changefreq>daily</changefreq></url>\n</urlset>`;
const LLMS_TXT = `# Anthronim\n\n> High-performance proxy server providing access to NVIDIA NIM models via the Anthropic Messages API.\n\n## What It Does\n\nAnthronim translates Anthropic Messages API requests into NVIDIA NIM OpenAI-compatible format. Clients like Claude Code can use NVIDIA-hosted open-source models (Llama, Mistral, Gemma, Qwen, DeepSeek, etc.) through this proxy.\n\n## API Endpoint\n\n- POST /v1/messages — Anthropic Messages API (streaming + non-streaming)\n- GET /v1/models — List available NVIDIA NIM models\n- GET /stats — Public usage statistics and benchmarks\n- POST /register — Self-service email registration for access tokens\n- POST /verify — Email verification to receive access token\n\n## Key Facts\n\n- Runtime: Node.js 20+\n- Dependency: better-sqlite3 (single dependency)\n- Auth: Bearer token or x-api-key header\n- Streaming: SSE (Server-Sent Events)\n- Models: 130+ NVIDIA NIM models including vision-capable ones\n- Source: https://github.com/KilimcininKorOglu/Anthronim\n- License: Open source\n`;

if (!NVIDIA_API_KEY && !hasKeys()) {
  console.error('Hata: NVIDIA_API_KEY ortam değişkeni ayarlanmamış ve veritabanında API anahtarı yok.');
  process.exit(1);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
};

const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS_HEADERS };
const PREFLIGHT_HEADERS = CORS_HEADERS;
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
  ...CORS_HEADERS,
};

const server = http.createServer({ noDelay: true, keepAlive: true }, async (req, res) => {
  try {
    const rawUrl = req.url || '/';
    const q = rawUrl.indexOf('?');
    const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);

    if (req.method === 'OPTIONS') {
      if (rawUrl.startsWith(ADMIN_PATH)) {
        res.writeHead(204);
      } else {
        res.writeHead(204, PREFLIGHT_HEADERS);
      }
      res.end();
      return;
    }

    if (pathname === '/') {
      const lang = getLang(req);
      const etag = indexEtag[lang];
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'public, max-age=300', 'ETag': etag, 'Vary': 'Cookie' };
      if (matchETag(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(indexHtml[lang]);
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { ...JSON_HEADERS, 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
      res.end(ROBOTS_TXT);
      return;
    }
    if (pathname === '/llms.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' });
      res.end(LLMS_TXT);
      return;
    }
    if (pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(SITEMAP_XML);
      return;
    }
    if (pathname.startsWith('/set-lang/')) {
      const lang = pathname.split('/')[2];
      if (lang === 'tr' || lang === 'en') {
        res.writeHead(302, { 'Location': req.headers.referer || '/', 'Set-Cookie': `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax` });
        res.end();
        return;
      }
    }
    if (pathname === '/v1/models' && req.method === 'GET') {
      const data = await getModels();
      const etag = W(data);
      if (matchETag(req.headers['if-none-match'], etag)) {
        res.writeHead(304, { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300', 'ETag': etag });
        res.end();
        return;
      }
      res.writeHead(200, { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300', 'ETag': etag });
      res.end(JSON.stringify(data));
      return;
    }
    if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
      const modelId = pathname.slice(11);
      const models = await getModels();
      const model = models.data.find(m => m.id === modelId);
      if (model) {
        sendJson(res, 200, model);
      } else {
        sendJson(res, 404, { error: { type: 'not_found', message: '[Proxy] Model not found' } });
      }
      return;
    }

    if (pathname === '/stats' && req.method === 'GET') {
      res.writeHead(200, { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=30' });
      res.end(JSON.stringify(getPublicStats()));
      return;
    }

    if ((pathname === '/register' || pathname === '/verify') && req.method === 'POST') {
      if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
        sendJson(res, 404, { error: { type: 'not_found', message: '[Proxy] Registration system is not active' } });
        return;
      }
      const ip = getClientIp(req);
      const now = Date.now();
      const ipRecord = regIpCounter.get(ip);
      if (ipRecord && now < ipRecord.resetAt) {
        if (ipRecord.count >= REG_MAX_PER_IP) {
          sendJson(res, 429, { error: { type: 'rate_limit_error', message: '[Proxy] Too many requests. Please try again later.' } });
          return;
        }
        ipRecord.count++;
      } else {
        regIpCounter.set(ip, { count: 1, resetAt: now + REG_IP_WINDOW_MS });
      }
    }

    if (pathname === '/register' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !EMAIL_REGEX.test(email)) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: '[Proxy] A valid email address is required' } });
        return;
      }
      if (hasRecentRegistration(email)) {
        sendJson(res, 429, { error: { type: 'rate_limit_error', message: '[Proxy] A verification code has already been sent to this email. Please wait 5 minutes.' } });
        return;
      }
      const code = generateVerificationCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const regId = addRegistration(email, hashToken(code), expiresAt);
      try {
        await sendVerificationEmail(email, code, getLang(req));
      } catch (err) {
        deleteRegistration(regId);
        console.error('Email send failed:', err.message);
        sendJson(res, 500, { error: { type: 'api_error', message: '[Proxy] Failed to send verification email' } });
        return;
      }
      sendJson(res, 200, { message: 'Verification code sent' });
      return;
    }

    if (pathname === '/verify' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = (body.email || '').trim().toLowerCase();
      const code = (body.code || '').trim();
      if (!email || !code) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: '[Proxy] Email and verification code are required' } });
        return;
      }
      const reg = findRegistration(email);
      if (!reg) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: '[Proxy] No active registration found. Please register again.' } });
        return;
      }
      if (reg.attempts >= 3) {
        sendJson(res, 429, { error: { type: 'rate_limit_error', message: '[Proxy] Attempt limit exceeded. Please wait 5 minutes and register again.' } });
        return;
      }
      if (hashToken(code) !== reg.code) {
        incrementRegistrationAttempts(reg.id);
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: `[Proxy] Invalid verification code. ${2 - reg.attempts} attempts remaining.` } });
        return;
      }
      deactivateTokenByEmail(email);
      const token = generateAuthToken();
      addToken(token, email);
      invalidateTokenCache();
      deleteRegistration(reg.id);
      sendJson(res, 200, { token, message: 'Access token created' });
      return;
    }

    if (pathname.startsWith(ADMIN_PATH)) {
      await handleAdmin(req, res, pathname);
      return;
    }

    let authTokenId = null;
    if (AUTH_TOKEN_ENV || hasTokens()) {
      const bearer = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
      const auth = req.headers['x-api-key'] || bearer;
      if (!auth) {
        sendJson(res, 401, { error: { type: 'authentication_error', message: '[Proxy] Invalid access token' } });
        return;
      }
      const result = validateToken(auth, AUTH_TOKEN_ENV);
      if (!result.valid) {
        sendJson(res, 401, { error: { type: 'authentication_error', message: '[Proxy] Invalid access token' } });
        return;
      }
      authTokenId = result.id;
    }

    if (pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res, authTokenId);
      return;
    }

    if (authTokenId !== null) logRequest(null, `${req.method} ${pathname}`, false, 404, authTokenId);
    sendJson(res, 404, { error: { type: 'not_found', message: '[Proxy] Not found' } });
  } catch (err) {
    if (!res.headersSent) {
      if (err.statusCode === 413) {
        sendJson(res, 413, { error: { type: 'invalid_request_error', message: '[Proxy] Request body too large' } });
      } else if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: '[Proxy] Invalid JSON body' } });
      } else {
        console.error('Request processing error:', err.message || err);
        sendJson(res, 500, { error: { type: 'internal_error', message: '[Proxy] Internal server error' } });
      }
    } else {
      res.end();
    }
  }
});

server.timeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  console.log(`Anthronim http://${HOST}:${PORT} adresinde dinliyor.`);
});

const UNSUPPORTED = { supported: false };
const SUPPORTED = { supported: true };
const DEFAULT_CAPABILITIES = {
  batch: UNSUPPORTED,
  citations: UNSUPPORTED,
  code_execution: UNSUPPORTED,
  context_management: { supported: false, clear_thinking_20251015: UNSUPPORTED, clear_tool_uses_20250919: UNSUPPORTED, compact_20260112: UNSUPPORTED },
  effort: { supported: false, high: UNSUPPORTED, low: UNSUPPORTED, max: UNSUPPORTED, medium: UNSUPPORTED },
  image_input: UNSUPPORTED,
  pdf_input: UNSUPPORTED,
  structured_outputs: SUPPORTED,
  thinking: { supported: true, types: { adaptive: UNSUPPORTED, enabled: SUPPORTED } },
};

function toAnthropicModel(m) {
  const created = m.created ? new Date(m.created * 1000).toISOString() : '1970-01-01T00:00:00Z';
  const parts = m.id.split('/');
  const name = parts.length > 1 ? parts[1] : m.id;
  return {
    id: m.id,
    type: 'model',
    display_name: name,
    created_at: created,
    max_input_tokens: 131072,
    max_tokens: 16384,
    capabilities: DEFAULT_CAPABILITIES,
  };
}

async function getModels() {
  const now = Date.now();
  if (modelCache && (now - modelCacheTime) < MODEL_CACHE_TTL) {
    return modelCache;
  }
  try {
    const res = await fetch(`${API_BASE}/models`);
    if (res.ok) {
      const nvidia = await res.json();
      const data = (nvidia.data || []).map(toAnthropicModel);
      modelCache = {
        data,
        has_more: false,
        first_id: data.length > 0 ? data[0].id : null,
        last_id: data.length > 0 ? data[data.length - 1].id : null,
      };
      modelCacheTime = now;
    }
  } catch (e) {
    // Fetch failed; return stale cache or empty
  }
  return modelCache || { data: [], has_more: false, first_id: null, last_id: null };
}

function generateVerificationCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function generateAuthToken() {
  return 'hermes-' + crypto.randomBytes(32).toString('hex');
}

async function sendVerificationEmail(email, code, lang) {
  const t = translations[lang] || translations.en;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: t.email_subject,
      textContent: t.email_body.replace('{{CODE}}', code),
    }),
  });
  if (!res.ok) throw new Error(`Brevo API error: ${res.status}`);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function W(data) {
  return 'W/"' + crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex').slice(0, 16) + '"';
}

function matchETag(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = s => s.trim().replace(/^W\//, '');
  return header.split(',').some(t => strip(t) === strip(etag));
}

function sendJson(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

function buildContent(message) {
  const content = [];
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }
  if (message.content) {
    const text = message.content;
    if (text.startsWith('<think>')) {
      const endIdx = text.indexOf('</think>');
      if (endIdx !== -1) {
        const thinking = text.slice(7, endIdx);
        const rest = text.slice(endIdx + 8).trim();
        if (thinking) content.push({ type: 'thinking', thinking });
        if (rest) content.push({ type: 'text', text: rest });
      } else {
        content.push({ type: 'thinking', thinking: text.slice(7) });
      }
    } else {
      content.push({ type: 'text', text });
    }
  }
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      let parsedInput;
      try { parsedInput = JSON.parse(tc.function.arguments); } catch { parsedInput = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsedInput });
    }
  }
  return content;
}

function sanitizeErrorBody(raw) {
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message || parsed?.message || parsed?.detail || '';
    const type = parsed?.error?.type || parsed?.error?.code || '';
    return JSON.stringify({ type, message: msg }).slice(0, 4096);
  } catch {
    return raw.slice(0, 256);
  }
}

// --- Benchmark runner ---

async function runSingleBench(model, prompt, maxTokens) {
  const keyEntry = getNextKey(NVIDIA_API_KEY);
  if (!keyEntry) return { ttfb: null, total: null, error: 'no_key' };

  const start = performance.now();
  let ttfb = null;

  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyEntry.key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: true }),
      signal: AbortSignal.timeout(300000),
    });

    if (!res.ok) return { ttfb: null, total: null, error: `http_${res.status}` };

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = performance.now() - start;
    }

    const total = performance.now() - start;
    return { ttfb: Math.round(ttfb) / 1000, total: Math.round(total) / 1000, error: null };
  } catch (e) {
    return { ttfb: null, total: null, error: e.message?.slice(0, 100) || 'unknown' };
  }
}

async function runBenchmarks() {
  const models = listBenchmarkModels().filter(m => m.is_active);
  if (models.length === 0) return;

  console.log(`Benchmark başlatılıyor (${models.length} model, paralel)...`);
  await Promise.allSettled(models.map(async ({ model }) => {
    try {
      const short = await runSingleBench(model, BENCH_SHORT_PROMPT, 100);
      const long = await runSingleBench(model, BENCH_LONG_PROMPT, 2048);
      const error = short.error || long.error || null;
      upsertBenchmark(model, short.ttfb, short.total, long.ttfb, long.total, error);
      console.log(`Benchmark: ${model} — kısa ${short.total}s, uzun ${long.total}s${error ? ' (' + error + ')' : ''}`);
    } catch (e) {
      upsertBenchmark(model, null, null, null, null, e.message?.slice(0, 100));
    }
  }));
}

setTimeout(runBenchmarks, 30000);
setInterval(runBenchmarks, BENCH_INTERVAL);

function loadDotEnv() {
  try {
    const envPath = new URL('.env', import.meta.url);
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('.env yükleme hatası:', err.message);
    }
  }
}

const MAX_BODY = parseInt(process.env.PROXY_MAX_BODY_MB || '10', 10) * 1024 * 1024;

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

async function handleMessages(req, res, authTokenId) {
  req.socket?.setTimeout(0);
  const body = await readJsonBody(req);

  if (!body.messages || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { type: 'invalid_request_error', message: '[Proxy] messages field is required' } });
    return;
  }

  const messages = [];
  if (body.system) {
    const systemContent = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text).join('\n');
    messages.push({ role: 'system', content: systemContent });
  }
  for (const msg of body.messages) {
    const converted = convertMessage(msg);
    if (Array.isArray(converted)) {
      messages.push(...converted);
    } else {
      messages.push(converted);
    }
  }

  const payload = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: !!body.stream,
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.stop_sequences) payload.stop = body.stop_sequences;

  if (body.tools?.length) {
    payload.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    if (body.tool_choice) {
      if (body.tool_choice.type === 'auto') {
        payload.tool_choice = 'auto';
      } else if (body.tool_choice.type === 'any') {
        payload.tool_choice = 'required';
      } else if (body.tool_choice.type === 'tool') {
        payload.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
      }
    }
  }

  const keyEntry = getNextKey(NVIDIA_API_KEY);
  if (!keyEntry) {
    sendJson(res, 503, { error: { type: 'service_error', message: '[Proxy] No available API key' } });
    return;
  }

  const upstream = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${keyEntry.key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errorBody = await upstream.text().catch(() => '');
    if (keyEntry.id !== null || authTokenId !== null) {
      logRequest(keyEntry.id, body.model, !!body.stream, upstream.status, authTokenId, sanitizeErrorBody(errorBody));
    }
    // Auto-deactivate key on 403 auth failure
    if (upstream.status === 403 && keyEntry.id !== null && errorBody.includes('Authorization failed')) {
      toggleKey(keyEntry.id, false);
      console.warn(`API key #${keyEntry.id} deaktive edildi (403 Authorization failed)`);
    }
    // Context/token limit → invalid_request_error (triggers client-side compression)
    const lower = errorBody.toLowerCase();
    if (upstream.status === 400 && (lower.includes('context') || lower.includes('token') || lower.includes('maximum') || lower.includes('too long'))) {
      let msg = 'prompt is too long: request exceeds context window limit';
      try {
        const parsed = JSON.parse(errorBody);
        const detail = parsed?.error?.message || parsed?.message || '';
        if (detail) msg = 'prompt is too long: ' + detail;
      } catch { /* empty */ }
      sendJson(res, 400, { error: { type: 'invalid_request_error', message: msg } });
      return;
    }
    // Non-multimodal model received image
    if (upstream.status === 400 && lower.includes('not a multimodal model')) {
      sendJson(res, 400, { error: { type: 'invalid_request_error', message: `[NVIDIA] ${body.model} does not support image input` } });
      return;
    }
    // Model not found on NVIDIA
    if (upstream.status === 404) {
      sendJson(res, 404, { error: { type: 'not_found', message: `[NVIDIA] ${body.model} is not available on NVIDIA NIM` } });
      return;
    }
    // Rate limit → retry once with a different key, then overloaded_error
    if (upstream.status === 429) {
      const retryKey = getNextKey(NVIDIA_API_KEY);
      if (retryKey && retryKey.key !== keyEntry.key) {
        const retry = await fetch(`${API_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${retryKey.key}` },
          body: JSON.stringify(payload),
        });
        if (retry.ok) {
          if (retryKey.id !== null || authTokenId !== null) {
            logRequest(retryKey.id, body.model, !!body.stream, retry.status, authTokenId);
          }
          if (body.stream) { await handleStream(retry, body.model, res); return; }
          const data = await retry.json();
          const choice = data.choices[0];
          const message = choice.message;
          const content = buildContent(message);
          let stopReason = 'end_turn';
          if (choice.finish_reason === 'length') stopReason = 'max_tokens';
          if (choice.finish_reason === 'tool_calls' || message.tool_calls?.length) stopReason = 'tool_use';
          sendJson(res, 200, {
            id: data.id, type: 'message', role: 'assistant',
            content: content.length ? content : [{ type: 'text', text: '' }],
            model: body.model, stop_reason: stopReason, stop_sequence: null,
            usage: { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens },
          });
          return;
        }
      }
      const retryAfter = upstream.headers.get('retry-after');
      const headers = { ...JSON_HEADERS };
      if (retryAfter) headers['Retry-After'] = retryAfter;
      res.writeHead(529, headers);
      res.end(JSON.stringify({ error: { type: 'overloaded_error', message: '[NVIDIA] Rate limit reached' } }));
      return;
    }
    sendJson(res, upstream.status, { error: { type: 'api_error', message: '[NVIDIA] Upstream API error' } });
    return;
  }

  if (keyEntry.id !== null || authTokenId !== null) {
    logRequest(keyEntry.id, body.model, !!body.stream, upstream.status, authTokenId);
  }

  if (body.stream) {
    await handleStream(upstream, body.model, res);
    return;
  }

  const data = await upstream.json();
  const choice = data.choices[0];
  const message = choice.message;
  const content = buildContent(message);

  let stop_reason = 'end_turn';
  if (choice.finish_reason === 'length') stop_reason = 'max_tokens';
  if (choice.finish_reason === 'tool_calls' || message.tool_calls?.length) stop_reason = 'tool_use';

  sendJson(res, 200, {
    id: data.id,
    type: 'message',
    role: 'assistant',
    content: content.length ? content : [{ type: 'text', text: '' }],
    model: body.model,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage.prompt_tokens,
      output_tokens: data.usage.completion_tokens,
    },
  });
}

function convertMessage(msg) {
  const content = msg.content;

  if (typeof content === 'string') {
    return { role: msg.role, content };
  }

  const textParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === 'tool_result') {
      let resultContent = '';
      if (typeof block.content === 'string') {
        resultContent = block.content;
      } else if (Array.isArray(block.content)) {
        resultContent = block.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
      }
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: resultContent,
      });
    } else if (block.type === 'image') {
      textParts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
    }
  }

  if (toolResults.length > 0) {
    return toolResults;
  }

  if (msg.role === 'assistant' && toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: textParts.join('') || null,
      tool_calls: toolCalls,
    };
  }

  if (textParts.every(p => typeof p === 'string')) {
    return { role: msg.role, content: textParts.join('') };
  }

  return { role: msg.role, content: textParts };
}

async function handleStream(upstream, model, res) {
  const id = `msg_${Date.now()}`;
  const dec = new TextDecoder();

  let tokens = 0;
  let contentIndex = 0;
  let hasThinkingBlock = false;
  let hasTextBlock = false;
  let inThinkTag = false;
  let modeDecided = false;
  let contentBuffer = '';
  let clientGone = false;
  let toolCallCount = 0;
  const toolCalls = new Map();

  res.writeHead(200, SSE_HEADERS);

  const reader = upstream.body.getReader();
  res.socket?.once('close', () => {
    clientGone = true;
    reader.cancel().catch(() => { });
  });

  const writeSse = async (chunk) => {
    if (clientGone) return;
    try {
      if (!res.write(chunk)) {
        await new Promise(resolve => res.once('drain', resolve));
      }
    } catch (err) {
      if (err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ECONNRESET') {
        clientGone = true;
        return;
      }
      throw err;
    }
  };

  // SSE keepalive — prevents reverse proxy idle timeout
  const keepaliveTimer = setInterval(() => {
    if (!clientGone) writeSse(': keepalive\n\n');
  }, 15000);

  const send = (event, data) =>
    writeSse(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const sendThinking = async (text) => {
    if (!text) return;
    if (!hasThinkingBlock) {
      await send('content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'thinking', thinking: '' } });
      hasThinkingBlock = true;
    }
    await writeSse(`event: content_block_delta\ndata: {"type":"content_block_delta","index":${contentIndex},"delta":{"type":"thinking_delta","thinking":${JSON.stringify(text)}}}\n\n`);
  };

  const sendText = async (text) => {
    if (!text) return;
    if (hasThinkingBlock && !hasTextBlock) {
      await send('content_block_stop', { type: 'content_block_stop', index: contentIndex++ });
      hasThinkingBlock = false;
    }
    if (!hasTextBlock) {
      await send('content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' } });
      hasTextBlock = true;
    }
    await writeSse(`event: content_block_delta\ndata: {"type":"content_block_delta","index":${contentIndex},"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`);
  };

  const processContent = async (text) => {
    // Mode decided and not inside think tag; send directly.
    if (modeDecided && !inThinkTag) {
      await sendText(text);
      return;
    }

    contentBuffer += text;

    // First decision: does content start with <think>?
    if (!modeDecided && contentBuffer.length >= 7) {
      if (contentBuffer.startsWith('<think>')) {
        inThinkTag = true;
        contentBuffer = contentBuffer.slice(7);
      }
      modeDecided = true;
    }

    // Not enough characters yet to decide.
    if (!modeDecided) return;

    // Inside think tag.
    if (inThinkTag) {
      const endIdx = contentBuffer.indexOf('</think>');
      if (endIdx !== -1) {
        await sendThinking(contentBuffer.slice(0, endIdx));
        const rest = contentBuffer.slice(endIdx + 8);
        contentBuffer = '';
        inThinkTag = false;
        if (rest) await sendText(rest);
      } else if (contentBuffer.length > 8) {
        await sendThinking(contentBuffer.slice(0, -8));
        contentBuffer = contentBuffer.slice(-8);
      }
    } else {
      // Outside think tag; flush entire buffer directly.
      if (contentBuffer) {
        await sendText(contentBuffer);
        contentBuffer = '';
      }
    }
  };

  const flushBuffer = async () => {
    if (contentBuffer) {
      if (inThinkTag) {
        await sendThinking(contentBuffer);
      } else {
        await sendText(contentBuffer);
      }
      contentBuffer = '';
    }
  };

  const closeStream = async (reason = 'end_turn') => {
    clearInterval(keepaliveTimer);
    await flushBuffer();
    if (hasThinkingBlock) await send('content_block_stop', { type: 'content_block_stop', index: contentIndex++ });
    if (hasTextBlock) await send('content_block_stop', { type: 'content_block_stop', index: contentIndex++ });
    for (const idx of toolCalls.keys()) {
      await send('content_block_stop', { type: 'content_block_stop', index: contentIndex + idx });
    }
    await send('message_delta', { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: tokens } });
    await send('message_stop', { type: 'message_stop' });
    if (!res.writableEnded) res.end();
  };

  await send('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

  try {
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientGone) return;

      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (clientGone) return;
        if (!line.startsWith('data: ')) continue;
        const end = line.charCodeAt(line.length - 1) === 13 ? -1 : undefined;
        const data = line.slice(6, end);
        if (!data) continue;

        if (data === '[DONE]') {
          await closeStream(toolCallCount > 0 ? 'tool_use' : 'end_turn');
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          console.error('JSON çözümleme hatası: uzunluk=%d', data.length);
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};
        const finish = choice.finish_reason;

        if (delta.reasoning_content) {
          await sendThinking(delta.reasoning_content);
        }

        if (delta.content) {
          await processContent(delta.content);
        }

        if (delta.tool_calls) {
          await flushBuffer();
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const fn = tc.function;
            let entry = toolCalls.get(idx);
            if (!entry) {
              if (hasTextBlock) {
                await send('content_block_stop', { type: 'content_block_stop', index: contentIndex++ });
                hasTextBlock = false;
              }
              entry = { id: tc.id, name: fn?.name, arguments: '' };
              toolCalls.set(idx, entry);
              toolCallCount++;
              await send('content_block_start', {
                type: 'content_block_start',
                index: contentIndex + idx,
                content_block: { type: 'tool_use', id: tc.id, name: fn?.name, input: {} },
              });
            }
            const fnName = fn?.name;
            const fnArgs = fn?.arguments;
            if (fnName) entry.name = fnName;
            if (fnArgs) {
              entry.arguments += fnArgs;
              await writeSse(`event: content_block_delta\ndata: {"type":"content_block_delta","index":${contentIndex + idx},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(fnArgs)}}}\n\n`);
            }
          }
        }

        if (finish) {
          let reason = 'end_turn';
          if (finish === 'length') reason = 'max_tokens';
          if (finish === 'tool_calls' || toolCallCount > 0) reason = 'tool_use';
          await closeStream(reason);
          return;
        }

        if (parsed.usage) tokens = parsed.usage.completion_tokens;
      }
    }

    await closeStream('end_turn');
  } catch (err) {
    clearInterval(keepaliveTimer);
    if (!clientGone) {
      console.error('Akış işleme hatası:', err.message || err);
    }
    if (!res.writableEnded) res.end();
  }
}
