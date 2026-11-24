'use strict';

/**
 * SQLite storage, using Node's built-in node:sqlite (Node >= 22.5) —
 * no native add-ons, no separate database server, nothing to configure.
 *
 * Tables:
 *   items    — one row per saved thing (Instagram post, upload, ...).
 *   events   — Smart Feed interaction signals (linger / skip / open /
 *              genre_tap). Stored so the feed can learn across sessions
 *              later; the in-session feed keeps its own live copy.
 *   settings — key/value app settings, including the visibility
 *              preference ('private' | 'public'), the public display
 *              name, and the stable public share id.
 *
 * The database file lives in data/my-archive.db and is git-ignored —
 * your archive is yours and never ships with the code.
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'my-archive.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,              -- 'instagram' | 'upload' (facebook later)
    shortcode   TEXT,                       -- Instagram shortcode, for the embed URL
    permalink   TEXT UNIQUE,                -- canonical URL; NULL for uploads
    author      TEXT,                       -- Instagram handle, or 'You' for uploads
    caption     TEXT NOT NULL DEFAULT '',
    media_type  TEXT NOT NULL DEFAULT 'post', -- 'post' | 'reel' | 'photo' | 'video'
    genre       TEXT NOT NULL DEFAULT 'More',
    topics      TEXT NOT NULL DEFAULT '[]', -- JSON array of classifier topics
    file_path   TEXT,                       -- uploads/<file> for device uploads
    mime_type   TEXT,
    saved_at    TEXT,                       -- ISO timestamp from the export / upload time
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_items_genre  ON items (genre);
  CREATE INDEX IF NOT EXISTS idx_items_source ON items (source);
  CREATE INDEX IF NOT EXISTS idx_items_saved  ON items (saved_at);

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER REFERENCES items (id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,              -- 'linger' | 'skip' | 'open' | 'genre_tap'
    genre       TEXT,
    topic       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_item ON events (item_id);

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  );
`);

// ---- settings ------------------------------------------------------------
// The visibility preference lives here as a real variable, read by the
// server on every public request — never hardcoded, never cached across
// a change. Default is Private: nothing is publicly reachable until the
// user explicitly turns it on.

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT (key) DO UPDATE SET value = excluded.value'
);

function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

// First-run defaults. The share id is random and stable: it is the key in
// the public URL (/p/:share_id), so it must not change or be guessable.
if (getSetting('visibility') == null) setSetting('visibility', 'private');
if (getSetting('display_name') == null) setSetting('display_name', 'My Archive');
if (getSetting('share_id') == null) {
  setSetting('share_id', crypto.randomBytes(9).toString('base64url'));
}

/** URL slug derived from the display name, for /u/:username. */
function displaySlug() {
  const name = getSetting('display_name') || 'my-archive';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'my-archive';
}

function getSettings() {
  return {
    visibility: getSetting('visibility') || 'private',
    display_name: getSetting('display_name') || 'My Archive',
    share_id: getSetting('share_id'),
    slug: displaySlug(),
  };
}

function isPublic() {
  return getSetting('visibility') === 'public';
}

// ---- prepared statements -------------------------------------------------

const insertItemStmt = db.prepare(`
  INSERT INTO items
    (source, shortcode, permalink, author, caption, media_type, genre,
     topics, file_path, mime_type, saved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
const updateGenreStmt = db.prepare('UPDATE items SET genre = ? WHERE id = ?');
const deleteItemStmt = db.prepare('DELETE FROM items WHERE id = ?');
const insertEventStmt = db.prepare(
  'INSERT INTO events (item_id, event_type, genre, topic) VALUES (?, ?, ?, ?)'
);
const countByGenreStmt = db.prepare(
  'SELECT genre, COUNT(*) AS n FROM items GROUP BY genre'
);
const countBySourceStmt = db.prepare(
  'SELECT source, COUNT(*) AS n FROM items GROUP BY source'
);
const totalCountStmt = db.prepare('SELECT COUNT(*) AS n FROM items');

function rowToItem(row) {
  if (!row) return null;
  let topics = [];
  try {
    topics = JSON.parse(row.topics || '[]');
  } catch {
    topics = [];
  }
  return { ...row, topics };
}

/** Insert one item. Returns the new row id, or null if the permalink already exists. */
function insertItem(item) {
  try {
    const info = insertItemStmt.run(
      item.source,
      item.shortcode || null,
      item.permalink || null,
      item.author || null,
      item.caption || '',
      item.media_type || 'post',
      item.genre || 'More',
      JSON.stringify(item.topics || []),
      item.file_path || null,
      item.mime_type || null,
      item.saved_at || new Date().toISOString()
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    // UNIQUE permalink — the item is already in the archive. Not an error.
    if (/UNIQUE constraint failed/.test(err.message)) return null;
    throw err;
  }
}

/** List items, newest-saved first, with optional genre / source filters. */
function listItems({ genre, source } = {}) {
  const where = [];
  const params = [];
  if (genre && genre !== 'All') {
    where.push('genre = ?');
    params.push(genre);
  }
  if (source && source !== 'all') {
    where.push('source = ?');
    params.push(source);
  }
  const sql =
    'SELECT * FROM items' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY COALESCE(saved_at, created_at) DESC, id DESC';
  return db.prepare(sql).all(...params).map(rowToItem);
}

function getItem(id) {
  return rowToItem(getItemStmt.get(Number(id)));
}

/** Returns true if a row was actually updated. */
function updateGenre(id, genre) {
  return updateGenreStmt.run(genre, Number(id)).changes > 0;
}

/** Deletes the row; returns the deleted item (so the caller can remove its file). */
function deleteItem(id) {
  const item = getItem(id);
  if (!item) return null;
  deleteItemStmt.run(Number(id));
  return item;
}

function recordEvent({ item_id, event_type, genre, topic }) {
  insertEventStmt.run(
    item_id != null ? Number(item_id) : null,
    event_type,
    genre || null,
    topic || null
  );
}

function stats() {
  const byGenre = {};
  for (const row of countByGenreStmt.all()) byGenre[row.genre] = row.n;
  const bySource = {};
  for (const row of countBySourceStmt.all()) bySource[row.source] = row.n;
  return { total: totalCountStmt.get().n, byGenre, bySource };
}

module.exports = {
  db,
  insertItem,
  listItems,
  getItem,
  updateGenre,
  deleteItem,
  recordEvent,
  stats,
  getSetting,
  setSetting,
  getSettings,
  displaySlug,
  isPublic,
};
