'use strict';

/**
 * My Archive — server.
 *
 * A small Express app: serves the static frontend from public/, stores
 * items in SQLite (src/db.js), classifies them into genres (src/classifier.js)
 * and imports Instagram data exports (src/importer.js).
 *
 * Run:  npm install && npm start   ->  http://localhost:3000
 *
 * API:
 *   GET    /api/health                 { ok: true }
 *   GET    /api/stats                  totals by genre and source
 *   GET    /api/settings               visibility, display name, share id
 *   PATCH  /api/settings               { visibility, display_name }
 *   GET    /api/items?genre=&source=   list items (newest first)
 *   GET    /api/items/:id              one item
 *   POST   /api/items                  multipart upload (file + caption + genre)
 *   PATCH  /api/items/:id              { genre } — move an item to a genre
 *   DELETE /api/items/:id              delete an item (+ its uploaded file)
 *   POST   /api/events                 { item_id, event_type, genre, topic }
 *   POST   /api/import                 Instagram export JSON, as a multipart
 *                                      `file` upload or a raw JSON body
 *   GET    /uploads/<file>             serve an uploaded photo/video
 *
 * Public pages (only when the visibility preference is Public; a Private
 * archive answers these routes with a generic 404):
 *   GET    /p/:share_id                public archive feed
 *   GET    /p/:share_id/item/:id       one public item
 *   GET    /u/:username                same feed, by display-name slug
 *   GET    /u/:username/item/:id       same item page, by slug
 */

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const store = require('./src/db');
const { GENRES, classify } = require('./src/classifier');
const { parseInstagramExport } = require('./src/importer');
const pages = require('./src/publicPages');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' })); // exports can be large
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---- uploads -------------------------------------------------------------

const IMAGE_VIDEO = /^(image|video)\//;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const safe = file.originalname
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80);
      // Random token in every filename: upload URLs are unguessable, so
      // a private archive's files can't be found by guessing URLs.
      const token = crypto.randomBytes(6).toString('hex');
      cb(null, `${Date.now()}-${token}-${safe}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (IMAGE_VIDEO.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image and video files can be uploaded.'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

// Import files are small JSON; keep them in memory, never on disk.
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ---- helpers -------------------------------------------------------------

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// ---- health & stats ------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/stats', (_req, res) => res.json(store.stats()));

// ---- settings (incl. the visibility preference) --------------------------
// The visibility preference is a real stored variable, read fresh on every
// request that depends on it. Default: Private.

function settingsResponse(req) {
  const s = store.getSettings();
  const base = `${req.protocol}://${req.get('host')}`;
  return {
    ...s,
    public_url: `${base}/p/${s.share_id}`,
    profile_url: `${base}/u/${s.slug}`,
  };
}

app.get('/api/settings', (req, res) => res.json(settingsResponse(req)));

app.patch('/api/settings', (req, res) => {
  const { visibility, display_name } = req.body || {};
  if (visibility !== undefined) {
    if (!['private', 'public'].includes(visibility)) {
      return sendError(res, 400, "visibility must be 'private' or 'public'.");
    }
    store.setSetting('visibility', visibility);
  }
  if (display_name !== undefined) {
    const name = String(display_name).trim();
    if (name.length < 1 || name.length > 40) {
      return sendError(res, 400, 'Display name must be 1–40 characters.');
    }
    store.setSetting('display_name', name);
  }
  res.json(settingsResponse(req));
});

// ---- items ---------------------------------------------------------------

app.get('/api/items', (req, res) => {
  const { genre, source } = req.query;
  if (genre && genre !== 'All' && !GENRES.includes(genre)) {
    return sendError(res, 400, `Unknown genre: ${genre}`);
  }
  if (source && !['all', 'instagram', 'upload'].includes(source)) {
    return sendError(res, 400, `Unknown source: ${source}`);
  }
  res.json(store.listItems({ genre, source }));
});

app.get('/api/items/:id', (req, res) => {
  const item = store.getItem(req.params.id);
  if (!item) return sendError(res, 404, 'Item not found.');
  res.json(item);
});

// Upload a device photo/video. Form fields: file, caption (optional),
// genre (optional — "Auto" runs the classifier on the caption).
app.post('/api/items', upload.single('file'), (req, res) => {
  if (!req.file) return sendError(res, 400, 'No file uploaded.');
  const caption = (req.body.caption || '').trim();
  const requestedGenre = (req.body.genre || 'Auto').trim();
  const { genre, topics } =
    requestedGenre !== 'Auto' && GENRES.includes(requestedGenre)
      ? { genre: requestedGenre, topics: classify(caption).topics }
      : classify(caption);
  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';

  const id = store.insertItem({
    source: 'upload',
    shortcode: null,
    permalink: null,
    author: 'You',
    caption,
    media_type: mediaType,
    genre,
    topics,
    file_path: `uploads/${req.file.filename}`,
    mime_type: req.file.mimetype,
    saved_at: new Date().toISOString(),
  });
  res.status(201).json(store.getItem(id));
});

app.patch('/api/items/:id', (req, res) => {
  const { genre } = req.body || {};
  if (!GENRES.includes(genre)) {
    return sendError(res, 400, `Unknown genre: ${genre}`);
  }
  if (!store.updateGenre(req.params.id, genre)) {
    return sendError(res, 404, 'Item not found.');
  }
  res.json(store.getItem(req.params.id));
});

app.delete('/api/items/:id', (req, res) => {
  const item = store.deleteItem(req.params.id);
  if (!item) return sendError(res, 404, 'Item not found.');
  // Remove the uploaded file too, if this item had one.
  if (item.file_path) {
    const full = path.join(__dirname, item.file_path);
    fs.unlink(full, () => {}); // best-effort; a missing file is fine
  }
  res.json({ deleted: true, id: Number(req.params.id) });
});

// ---- Smart Feed events ---------------------------------------------------
// The frontend posts in-session signals here (linger / skip / open /
// genre_tap). They are stored so the feed can learn across sessions later;
// the live feed keeps its own in-memory copy and does not wait on this.

app.post('/api/events', (req, res) => {
  const { item_id, event_type, genre, topic } = req.body || {};
  const valid = ['linger', 'skip', 'open', 'genre_tap'];
  if (!valid.includes(event_type)) {
    return sendError(res, 400, `Unknown event_type: ${event_type}`);
  }
  if (item_id != null && !store.getItem(item_id)) {
    return sendError(res, 404, 'Item not found.');
  }
  store.recordEvent({ item_id, event_type, genre, topic });
  res.status(201).json({ recorded: true });
});

// ---- Instagram export import ---------------------------------------------
// Accepts either:
//   * multipart/form-data with a `file` field (the import page), or
//   * a raw JSON body that IS the export (curl / programmatic use).

app.post('/api/import', importUpload.single('file'), (req, res) => {
  let json;
  try {
    if (req.file) {
      json = JSON.parse(req.file.buffer.toString('utf8'));
    } else if (req.body && Object.keys(req.body).length > 0) {
      json = req.body;
    } else {
      return sendError(
        res,
        400,
        'Upload your Instagram saved_posts.json file, or POST the export JSON.'
      );
    }
  } catch {
    return sendError(res, 400, 'That file is not valid JSON.');
  }

  const { items, skipped } = parseInstagramExport(json);
  let imported = 0;
  let duplicates = 0;
  const importedGenres = {};
  for (const item of items) {
    const id = store.insertItem(item);
    if (id == null) {
      duplicates += 1; // already in the archive (same permalink)
    } else {
      imported += 1;
      importedGenres[item.genre] = (importedGenres[item.genre] || 0) + 1;
    }
  }

  res.json({
    imported,
    duplicates,
    skipped, // entries with no parseable Instagram permalink
    found: items.length,
    genres: importedGenres,
  });
});

// ---- public pages --------------------------------------------------------
// Every public route re-reads the visibility preference from the database.
// Private (or a wrong share id / username / item id) always answers with
// the same generic 404 — a private archive is indistinguishable from one
// that doesn't exist.

function publicBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function publicNotFound(req, res) {
  res.status(404).send(pages.renderNotFound(publicBaseUrl(req)));
}

// Resolves the archive for a public request, or null when it must 404.
function resolvePublicArchive(req, kind) {
  if (!store.isPublic()) return null;
  const settings = store.getSettings();
  if (kind === 'share' && req.params.share_id !== settings.share_id) return null;
  if (kind === 'user' && req.params.username !== settings.slug) return null;
  return settings;
}

function publicFeed(req, res, kind) {
  const settings = resolvePublicArchive(req, kind);
  if (!settings) return publicNotFound(req, res);
  const base = publicBaseUrl(req);
  const genre =
    req.query.genre && GENRES.includes(req.query.genre) ? req.query.genre : 'All';
  const items = store.listItems({ genre: genre === 'All' ? undefined : genre });
  // Canonical feed URL is always the /p/:share_id form.
  const feedBase = `${base}/p/${settings.share_id}`;
  res.send(
    pages.renderArchivePage({ settings, items, genre, feedBase, baseUrl: base })
  );
}

function publicItem(req, res, kind) {
  const settings = resolvePublicArchive(req, kind);
  if (!settings) return publicNotFound(req, res);
  const item = store.getItem(req.params.id);
  if (!item) return publicNotFound(req, res);
  const base = publicBaseUrl(req);
  const feedBase = `${base}/p/${settings.share_id}`;
  res.send(
    pages.renderItemPage({
      settings,
      item,
      itemUrl: `${feedBase}/item/${item.id}`,
      feedBase,
      baseUrl: base,
    })
  );
}

app.get('/p/:share_id', (req, res) => publicFeed(req, res, 'share'));
app.get('/p/:share_id/item/:id', (req, res) => publicItem(req, res, 'share'));
app.get('/u/:username', (req, res) => publicFeed(req, res, 'user'));
app.get('/u/:username/item/:id', (req, res) => publicItem(req, res, 'user'));

// ---- errors & startup ----------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return sendError(res, 400, `Upload failed: ${err.message}`);
  }
  if (err) return sendError(res, 400, err.message || 'Bad request.');
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`My Archive running at http://localhost:${PORT}`);
});
