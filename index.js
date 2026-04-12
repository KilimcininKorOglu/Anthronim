import http from 'node:http';
import fs from 'node:fs';
import { initDb, getNextKey, logRequest, hasKeys, validateToken, hasTokens } from './db.js';
import { handleAdmin } from './admin.js';

loadDotEnv();
initDb();

const API_BASE = 'https://integrate.api.nvidia.com/v1';
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
      res.writeHead(204, PREFLIGHT_HEADERS);
      res.end();
      return;
    }

    if (pathname.startsWith('/admin')) {
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
    if (pathname === '/v1/models' && req.method === 'GET') {
      sendJson(res, 200, await getModels());
      return;
    }
    if (pathname === '/health' || pathname === '/') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    sendJson(res, 404, { error: { type: 'not_found', message: 'Bulunamadı' } });
  } catch (err) {
    console.error('İstek işleme hatası:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { type: 'internal_error', message: 'Sunucu hatası' } });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Anthronim http://${HOST}:${PORT} adresinde dinliyor.`);
});

async function getModels() {
  const now = Date.now();
  if (modelCache && (now - modelCacheTime) < MODEL_CACHE_TTL) {
    return modelCache;
  }
  try {
    const res = await fetch(`${API_BASE}/models`);
    if (res.ok) {
      modelCache = await res.json();
      modelCacheTime = now;
    }
  } catch (e) {
    // Fetch failed; return stale cache or empty
  }
  return modelCache || { object: 'list', data: [] };
}

function sendJson(res, status, data) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(data));
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleMessages(req, res, authTokenId) {
  const body = await readJsonBody(req);

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

  if (keyEntry.id !== null || authTokenId !== null) {
    logRequest(keyEntry.id, body.model, !!body.stream, upstream.status, authTokenId);
  }

  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: { type: 'api_error', message: await upstream.text() } });
    return;
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
    content.push({ type: 'text', text: message.content });
  }

  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
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
          console.error('JSON çözümleme hatası:', data);
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
    if (!clientGone) {
      console.error('Akış işleme hatası:', err);
    }
    if (!res.writableEnded) res.end();
  }
}
