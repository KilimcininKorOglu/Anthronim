import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'anthronim.db');

let db;
let cachedKeys = null;
let cachedTokens = null;
let roundRobinIndex = 0;

// Prepared statement cache — API keys
let stmtInsertKey;
let stmtDeleteKey;
let stmtToggleKey;
let stmtListKeys;
let stmtActiveKeys;
let stmtIncrementRequest;
let stmtIncrementError;

// Prepared statement cache — Auth tokens
let stmtInsertToken;
let stmtDeleteToken;
let stmtToggleToken;
let stmtListTokens;
let stmtActiveTokens;
let stmtIncrementTokenRequest;
let stmtIncrementTokenError;

// Prepared statement cache — Logging & stats
let stmtInsertLog;
let stmtGetStats;
let stmtGetHourlyStats;

export function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT NOT NULL UNIQUE,
      label         TEXT DEFAULT '',
      is_active     INTEGER DEFAULT 1,
      request_count INTEGER DEFAULT 0,
      error_count   INTEGER DEFAULT 0,
      last_used_at  TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT NOT NULL UNIQUE,
      label         TEXT DEFAULT '',
      is_active     INTEGER DEFAULT 1,
      request_count INTEGER DEFAULT 0,
      error_count   INTEGER DEFAULT 0,
      last_used_at  TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id  INTEGER,
      model       TEXT,
      stream      INTEGER,
      status_code INTEGER,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_log_created_at ON request_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_log_api_key_id ON request_log(api_key_id);
  `);

  // Idempotent column addition for auth_token_id
  try {
    db.exec('ALTER TABLE request_log ADD COLUMN auth_token_id INTEGER');
  } catch (e) { /* column already exists */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_request_log_auth_token_id ON request_log(auth_token_id)');

  // API key statements
  stmtInsertKey = db.prepare('INSERT INTO api_keys (key, label) VALUES (?, ?)');
  stmtDeleteKey = db.prepare('DELETE FROM api_keys WHERE id = ?');
  stmtToggleKey = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?');
  stmtListKeys = db.prepare('SELECT * FROM api_keys ORDER BY id');
  stmtActiveKeys = db.prepare('SELECT id, key FROM api_keys WHERE is_active = 1 ORDER BY id');
  stmtIncrementRequest = db.prepare("UPDATE api_keys SET request_count = request_count + 1, last_used_at = datetime('now') WHERE id = ?");
  stmtIncrementError = db.prepare('UPDATE api_keys SET error_count = error_count + 1 WHERE id = ?');

  // Auth token statements
  stmtInsertToken = db.prepare('INSERT INTO auth_tokens (token, label) VALUES (?, ?)');
  stmtDeleteToken = db.prepare('DELETE FROM auth_tokens WHERE id = ?');
  stmtToggleToken = db.prepare('UPDATE auth_tokens SET is_active = ? WHERE id = ?');
  stmtListTokens = db.prepare('SELECT * FROM auth_tokens ORDER BY id');
  stmtActiveTokens = db.prepare('SELECT id, token FROM auth_tokens WHERE is_active = 1');
  stmtIncrementTokenRequest = db.prepare("UPDATE auth_tokens SET request_count = request_count + 1, last_used_at = datetime('now') WHERE id = ?");
  stmtIncrementTokenError = db.prepare('UPDATE auth_tokens SET error_count = error_count + 1 WHERE id = ?');

  // Logging & stats statements
  stmtInsertLog = db.prepare('INSERT INTO request_log (api_key_id, model, stream, status_code, auth_token_id) VALUES (?, ?, ?, ?, ?)');
  stmtGetStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM request_log) AS total_requests,
      (SELECT COUNT(*) FROM request_log WHERE created_at >= datetime('now', '-1 day')) AS today_requests,
      (SELECT COUNT(*) FROM api_keys WHERE is_active = 1) AS active_keys,
      (SELECT COUNT(*) FROM auth_tokens WHERE is_active = 1) AS active_tokens,
      (SELECT COUNT(*) FROM request_log WHERE status_code >= 400) AS error_requests
  `);
  stmtGetHourlyStats = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour,
      COUNT(*) AS count
    FROM request_log
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY hour
    ORDER BY hour
  `);
}

// --- API Key cache ---

function invalidateCache() {
  cachedKeys = null;
}

function loadActiveKeys() {
  if (!cachedKeys) {
    cachedKeys = stmtActiveKeys.all();
  }
  return cachedKeys;
}

// --- Auth Token cache ---

function invalidateTokenCache() {
  cachedTokens = null;
}

function loadActiveTokens() {
  if (!cachedTokens) {
    cachedTokens = new Map();
    for (const row of stmtActiveTokens.all()) {
      cachedTokens.set(row.token, row.id);
    }
  }
  return cachedTokens;
}

// --- API Key functions ---

export function getNextKey(envFallback) {
  const keys = loadActiveKeys();
  if (keys.length === 0) {
    if (envFallback) {
      return { id: null, key: envFallback };
    }
    return null;
  }
  const entry = keys[roundRobinIndex % keys.length];
  roundRobinIndex = (roundRobinIndex + 1) % keys.length;
  return entry;
}

export function addKey(key, label = '') {
  const result = stmtInsertKey.run(key, label);
  invalidateCache();
  return result.lastInsertRowid;
}

export function removeKey(id) {
  const result = stmtDeleteKey.run(id);
  invalidateCache();
  return result.changes > 0;
}

export function toggleKey(id, isActive) {
  const result = stmtToggleKey.run(isActive ? 1 : 0, id);
  invalidateCache();
  return result.changes > 0;
}

export function listKeys() {
  return stmtListKeys.all();
}

export function hasKeys() {
  const row = db.prepare('SELECT COUNT(*) AS count FROM api_keys').get();
  return row.count > 0;
}

// --- Auth Token functions ---

export function validateToken(token, envFallback) {
  const map = loadActiveTokens();
  if (map.has(token)) {
    return { id: map.get(token), valid: true };
  }
  if (envFallback && token === envFallback) {
    return { id: null, valid: true };
  }
  return { id: null, valid: false };
}

export function addToken(token, label = '') {
  const result = stmtInsertToken.run(token, label);
  invalidateTokenCache();
  return result.lastInsertRowid;
}

export function removeToken(id) {
  const result = stmtDeleteToken.run(id);
  invalidateTokenCache();
  return result.changes > 0;
}

export function toggleToken(id, isActive) {
  const result = stmtToggleToken.run(isActive ? 1 : 0, id);
  invalidateTokenCache();
  return result.changes > 0;
}

export function listTokens() {
  return stmtListTokens.all();
}

export function hasTokens() {
  const row = db.prepare('SELECT COUNT(*) AS count FROM auth_tokens').get();
  return row.count > 0;
}

// --- Logging ---

export function logRequest(keyId, model, stream, statusCode, authTokenId = null) {
  stmtInsertLog.run(keyId, model, stream ? 1 : 0, statusCode, authTokenId);
  if (keyId !== null) {
    stmtIncrementRequest.run(keyId);
    if (statusCode >= 400) {
      stmtIncrementError.run(keyId);
    }
  }
  if (authTokenId !== null) {
    stmtIncrementTokenRequest.run(authTokenId);
    if (statusCode >= 400) {
      stmtIncrementTokenError.run(authTokenId);
    }
  }
}

// --- Stats ---

export function getStats() {
  const summary = stmtGetStats.get();
  const hourly = stmtGetHourlyStats.all();

  const modelStats = db.prepare(`
    SELECT model, COUNT(*) AS count
    FROM request_log
    GROUP BY model
    ORDER BY count DESC
    LIMIT 10
  `).all();

  const tokenStats = db.prepare(`
    SELECT id, label, request_count, error_count, last_used_at, is_active
    FROM auth_tokens
    ORDER BY request_count DESC
  `).all();

  return { ...summary, hourly, modelStats, tokenStats };
}
