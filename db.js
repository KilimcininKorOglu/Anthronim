import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'anthronim.db');

let db;
let cachedKeys = null;
let roundRobinIndex = 0;

// Prepared statement cache
let stmtInsertKey;
let stmtDeleteKey;
let stmtToggleKey;
let stmtListKeys;
let stmtInsertLog;
let stmtIncrementRequest;
let stmtIncrementError;
let stmtActiveKeys;
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

  stmtInsertKey = db.prepare('INSERT INTO api_keys (key, label) VALUES (?, ?)');
  stmtDeleteKey = db.prepare('DELETE FROM api_keys WHERE id = ?');
  stmtToggleKey = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?');
  stmtListKeys = db.prepare('SELECT * FROM api_keys ORDER BY id');
  stmtInsertLog = db.prepare('INSERT INTO request_log (api_key_id, model, stream, status_code) VALUES (?, ?, ?, ?)');
  stmtIncrementRequest = db.prepare('UPDATE api_keys SET request_count = request_count + 1, last_used_at = datetime(\'now\') WHERE id = ?');
  stmtIncrementError = db.prepare('UPDATE api_keys SET error_count = error_count + 1 WHERE id = ?');
  stmtActiveKeys = db.prepare('SELECT id, key FROM api_keys WHERE is_active = 1 ORDER BY id');
  stmtGetStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM request_log) AS total_requests,
      (SELECT COUNT(*) FROM request_log WHERE created_at >= datetime('now', '-1 day')) AS today_requests,
      (SELECT COUNT(*) FROM api_keys WHERE is_active = 1) AS active_keys,
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

function invalidateCache() {
  cachedKeys = null;
}

function loadActiveKeys() {
  if (!cachedKeys) {
    cachedKeys = stmtActiveKeys.all();
  }
  return cachedKeys;
}

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

export function logRequest(keyId, model, stream, statusCode) {
  stmtInsertLog.run(keyId, model, stream ? 1 : 0, statusCode);
  stmtIncrementRequest.run(keyId);
  if (statusCode >= 400) {
    stmtIncrementError.run(keyId);
  }
}

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

  return { ...summary, hourly, modelStats };
}

export function hasKeys() {
  const row = db.prepare('SELECT COUNT(*) AS count FROM api_keys').get();
  return row.count > 0;
}
