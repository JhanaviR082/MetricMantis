const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
const databasePath = path.join(dataDir, "metricmantis.db");

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

  return db;
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
  databasePath,
};
