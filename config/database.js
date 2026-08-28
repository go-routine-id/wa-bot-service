'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./index');

let db = null;

function runMigrations(conn) {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    conn.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );
  const migrationsDir = path.join(config.root, 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const apply = conn.transaction((file, sql) => {
    conn.exec(sql);
    conn.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
  });

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    apply(file, sql);
    console.log(`[db] migrasi diterapkan: ${file}`);
  }
}

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

module.exports = { getDb };
