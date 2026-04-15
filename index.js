import http from 'node:http';
import fs from 'node:fs';
import { initDb, getNextKey, logRequest, hasKeys, validateToken, hasTokens, toggleKey, cleanupOldLogs, getPublicStats } from './db.js';
import { handleAdmin, ADMIN_PATH } from './admin.js';

loadDotEnv();
initDb();
cleanupOldLogs();
setInterval(cleanupOldLogs, parseInt(process.env.LOG_CLEANUP_HOURS || '6', 10) * 60 * 60 * 1000);

const API_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const indexHtml = fs.readFileSync(new URL('index.html', import.meta.url), 'utf8');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const AUTH_TOKEN_ENV = process.env.AUTH_TOKEN;

const MODEL_CACHE_TTL = parseInt(process.env.MODEL_CACHE_TTL || '3600000', 10);
let modelCache = null;
let modelCacheTime = 0;

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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
      res.end(indexHtml);
      return;
    }
    if (pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (pathname === '/v1/models' && req.method === 'GET') {
      sendJson(res, 200, await getModels());
      return;
    }
    if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
      const modelId = pathname.slice(11);
      const models = await getModels();
      const model = models.data.find(m => m.id === modelId);
      if (model) {
        sendJson(res, 200, model);
      } else {
        sendJson(res, 404, { error: { type: 'not_found', message: 'Model bulunamadı' } });
      }
      return;
    }

    if (pathname === '/stats' && req.method === 'GET') {
      sendJson(res, 200, getPublicStats());
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
        sendJson(res, 401, { error: { type: 'authentication_error', message: 'Geçersiz erişim anahtarı' } });
        return;
      }
      const result = validateToken(auth, AUTH_TOKEN_ENV);
      if (!result.valid) {
        sendJson(res, 401, { error: { type: 'authentication_error', message: 'Geçersiz erişim anahtarı' } });
        return;
      }
      authTokenId = result.id;
    }

    if (pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res, authTokenId);
      return;
    }

    sendJson(res, 404, { error: { type: 'not_found', message: 'Bulunamadı' } });
  } catch (err) {
    if (!res.headersSent) {
      if (err.statusCode === 413) {
        sendJson(res, 413, { error: { type: 'invalid_request_error', message: 'İstek gövdesi çok büyük' } });
      } else if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'Geçersiz JSON gövdesi' } });
      } else {
        console.error('İstek işleme hatası:', err.message || err);
        sendJson(res, 500, { error: { type: 'internal_error', message: 'Sunucu hatası' } });
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

function sendJson(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
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
    sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'messages alanı zorunlu' } });
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
    sendJson(res, 503, { error: { type: 'service_error', message: 'Kullanılabilir API anahtarı yok' } });
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
    // Model not found on NVIDIA
    if (upstream.status === 404) {
      sendJson(res, 404, { error: { type: 'not_found', message: `${body.model} NVIDIA sisteminde bulunmamaktadır` } });
      return;
    }
    sendJson(res, upstream.status, { error: { type: 'api_error', message: 'Upstream API hatası' } });
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
        // No closing tag (max_tokens truncation) — all content is thinking
        content.push({ type: 'thinking', thinking: text.slice(7) });
      }
    } else {
      content.push({ type: 'text', text });
    }
  }

  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      let parsedInput;
      try { parsedInput = JSON.parse(tc.function.arguments); } catch (e) { parsedInput = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }
  }

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
    reader.cancel().catch(() => {});
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
