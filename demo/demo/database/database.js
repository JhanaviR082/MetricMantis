const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
const databasePath = process.env.METRICMANTIS_DB_PATH || path.join(dataDir, "metricmantis.db");

let db;

function initDatabase() {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  migrateUsers(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      hypothesis TEXT,
      target_service TEXT NOT NULL,
      fault_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      config_json TEXT NOT NULL,
      evidence_json TEXT,
      error TEXT,
      cleanup_status TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS experiments_user_created
      ON experiments(user_id, created_at);
    CREATE TABLE IF NOT EXISTS sandboxes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      project_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      compose_sha256 TEXT NOT NULL,
      compose_yaml TEXT NOT NULL,
      file_name TEXT,
      services_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      stopped_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS sandboxes_user_status
      ON sandboxes(user_id, status, created_at);
  `);

  return db;
}

function migrateUsers(database) {
  const columns = database.prepare("PRAGMA table_info(users)").all();
  const byName = Object.fromEntries(columns.map((column) => [column.name, column]));
  if (!byName.google_sub && byName.password_hash?.notnull === 1) {
    return;
  }

  database.exec(`
    CREATE TABLE users_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO users_migrated (id, username, email, password_hash, created_at)
    SELECT id, username, email, password_hash, created_at
    FROM users
    WHERE password_hash IS NOT NULL AND password_hash != '';
    DROP TABLE users;
    ALTER TABLE users_migrated RENAME TO users;
  `);
}

function getDatabase() {
  if (!db) {
    throw new Error("Database has not been initialized.");
  }
  return db;
}

module.exports = {
  initDatabase,
  getDatabase,
  migrateUsers,
  databasePath,
};
