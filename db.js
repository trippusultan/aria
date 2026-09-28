'use strict';
// SQLite schema (PRD §12) + per-user AES-256-GCM encryption at rest for raw source text, connector tokens,
// excerpts, suggestion payloads, notes and assistant threads.
// Production: set ARIA_MASTER_KEY from a secret manager / env outside the data dir. The master.key fallback sits
// next to aria.db, so a copy of the data dir alone can decrypt everything (fine for dev, not for real tenants).
// Per-user key = HKDF(master, users.key_salt): deleting the user row destroys the salt and crypto-shreds leftovers.
// No migrations: schema changes need a fresh data dir until there is data worth migrating.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, key_salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (user_id INTEGER PRIMARY KEY, json TEXT NOT NULL DEFAULT '{}', digest_sent TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, user_agent TEXT, ip TEXT, created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, oauth_state TEXT);
CREATE TABLE IF NOT EXISTS connectors (
  user_id INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'disconnected', mode TEXT NOT NULL DEFAULT 'demo',
  scopes TEXT NOT NULL DEFAULT '[]', last_sync_at TEXT, last_error TEXT, tokens_enc BLOB, data_enc BLOB,
  PRIMARY KEY (user_id, type));
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, display_name TEXT NOT NULL, emails TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]', org_name TEXT, directory_id TEXT, unverified INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, connector TEXT, external_id TEXT, title TEXT NOT NULL,
  started_at TEXT, participants TEXT NOT NULL DEFAULT '[]', processing_status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
  mode TEXT, text_enc BLOB, raw_wiped INTEGER NOT NULL DEFAULT 0, thread_id TEXT, notice TEXT, processed_at TEXT, created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, type, external_id));
CREATE TABLE IF NOT EXISTS excerpts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_id INTEGER, start_offset INTEGER NOT NULL, text TEXT NOT NULL, speaker_person_id INTEGER);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_id INTEGER NOT NULL, payload TEXT NOT NULL, confidence REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', reason TEXT, snooze_until TEXT, excerpt_id INTEGER, task_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  direction TEXT NOT NULL DEFAULT 'unclear', due_at TEXT, owner_user_id INTEGER NOT NULL, priority TEXT, tags TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'private', source_id INTEGER, excerpt_id INTEGER, closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_people (
  user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, person_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'counterparty',
  PRIMARY KEY (task_id, person_id));
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, author_user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, task_id INTEGER NOT NULL, actor TEXT NOT NULL, verb TEXT NOT NULL,
  from_value TEXT, to_value TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, messages TEXT NOT NULL DEFAULT '[]', proposals TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT, created_at TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS app_config (k TEXT PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY, user_id INTEGER, org_id TEXT, actor TEXT, action TEXT NOT NULL, object TEXT, at TEXT NOT NULL, ip TEXT);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_people_user ON people(user_id);
CREATE INDEX IF NOT EXISTS ix_sources_user ON sources(user_id);
CREATE INDEX IF NOT EXISTS ix_excerpts_user ON excerpts(user_id);
CREATE INDEX IF NOT EXISTS ix_suggestions_user ON suggestions(user_id, state);
CREATE INDEX IF NOT EXISTS ix_tasks_user ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS ix_task_people_user ON task_people(user_id, person_id);
CREATE INDEX IF NOT EXISTS ix_notes_task ON notes(user_id, task_id);
CREATE INDEX IF NOT EXISTS ix_activity_task ON activity(user_id, task_id);
CREATE INDEX IF NOT EXISTS ix_threads_user ON chat_threads(user_id);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS ix_audit_user ON audit_events(user_id);
CREATE INDEX IF NOT EXISTS ix_audit_org ON audit_events(org_id);
`;

// Tables holding a user's vault content; account deletion wipes all of them (audit_events is kept).
const VAULT_TABLES = ['settings', 'sessions', 'connectors', 'people', 'sources', 'excerpts', 'suggestions', 'tasks',
  'task_people', 'notes', 'activity', 'chat_threads', 'notifications'];

function masterKey(dataDir) {
  const env = process.env.ARIA_MASTER_KEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error('ARIA_MASTER_KEY must be 64 hex chars (32 bytes)');
    return Buffer.from(env, 'hex');
  }
  const file = path.join(dataDir, 'master.key');
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const hex = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${file} is corrupt`);
  return Buffer.from(hex, 'hex');
}

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'aria.db'));
  db.exec(SCHEMA);
  // Repair (idempotent): before 2026-09-28 processing overwrote sources.mode with the extraction mode, losing demo/oauth.
  db.exec(`UPDATE sources SET mode = (SELECT c.mode FROM connectors c WHERE c.user_id = sources.user_id AND c.type = sources.connector)
    WHERE connector IS NOT NULL AND (mode IS NULL OR mode NOT IN ('demo', 'oauth'))`);
  const master = masterKey(dataDir);
  const keys = new Map();
  const userKey = (uid) => {
    if (uid === 0 && !keys.has(0)) keys.set(0, Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('aria-system'), 'aria-system-key', 32))); // server-level secrets
    if (!keys.has(uid)) {
      const u = db.prepare('SELECT key_salt FROM users WHERE id=?').get(uid);
      if (!u) throw new Error(`no key for user ${uid}`);
      keys.set(uid, Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(u.key_salt, 'hex'), 'aria-user-key', 32)));
    }
    return keys.get(uid);
  };

  const stmts = new Map();
  const st = (sql) => { let s = stmts.get(sql); if (!s) stmts.set(sql, (s = db.prepare(sql))); return s; };
  const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  let depth = 0;

  return {
    db,
    VAULT_TABLES,
    all: (sql, ...p) => st(sql).all(...norm(p)),
    one: (sql, ...p) => st(sql).get(...norm(p)),
    run: (sql, ...p) => st(sql).run(...norm(p)),
    tx(fn) { // reentrant: nested calls join the outer transaction
      if (depth++) { try { return fn(); } finally { depth--; } }
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
    },
    // blob = iv(12) | tag(16) | ciphertext; key = HKDF(master, user_id)
    enc(uid, text) {
      if (text == null) return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', userKey(uid), iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    dec(uid, blob) {
      if (blob == null) return null;
      const b = Buffer.from(blob);
      const d = crypto.createDecipheriv('aes-256-gcm', userKey(uid), b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
    forget(uid) { keys.delete(uid); },
    close() { try { db.close(); } catch {} },
  };
}

module.exports = { open };
