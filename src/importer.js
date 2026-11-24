'use strict';

/**
 * Instagram "Download Your Information" parser.
 *
 * There is no official Meta API that exposes a user's saved posts to a
 * third-party app, so the standalone version of My Archive syncs the way
 * every honest tool does: the user exports their own data from Instagram
 * (Settings -> Accounts Centre -> Your information and permissions ->
 * Download your information -> JSON format) and imports the
 * `saved_posts.json` file here. Nothing leaves the user's machine.
 *
 * Formats handled:
 *   1. The real export shape:
 *        { "saved_saved_media": [
 *            { "title": "<author or collection>",
 *              "string_list_data": [
 *                { "href": "https://www.instagram.com/p/<shortcode>/",
 *                  "value": "<caption or emoji>", "timestamp": 1700000000 } ] } ] }
 *   2. A plain array of entries: [{ "href" | "permalink" | "url",
 *        "caption", "author", "timestamp" | "saved_at" }]
 *   3. An object wrapping such an array under `saved_posts`, `items`
 *      or `saved_saved_media`.
 *
 * Timestamps may be in seconds or milliseconds since epoch; both are
 * normalised to ISO strings. Entries without a parseable Instagram
 * permalink are skipped and counted, never imported as junk.
 */

const { classify } = require('./classifier');

// Matches /p/<code>/, /reel/<code>/, /reels/<code>/, /tv/<code>/, /reel/<code>
const PERMALINK_RE =
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/;

function extractShortcode(permalink) {
  if (typeof permalink !== 'string') return null;
  const m = permalink.trim().match(PERMALINK_RE);
  return m ? m[1] : null;
}

function normaliseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Seconds (< 1e12) vs milliseconds.
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Flatten the many shapes of an Instagram export into raw entries.
 * Each raw entry is { href, caption, author, timestamp } (fields optional).
 */
function flattenExport(json) {
  const entries = [];

  const pushStringList = (node, fallbackAuthor) => {
    const list = node && node.string_list_data;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      entries.push({
        href: item.href || item.permalink || item.url || null,
        caption: item.value || item.caption || '',
        author: node.title || fallbackAuthor || null,
        timestamp: item.timestamp ?? item.saved_at ?? null,
      });
    }
  };

  const pushEntry = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.string_list_data)) {
      pushStringList(node, null);
      return;
    }
    entries.push({
      href: node.href || node.permalink || node.url || null,
      caption: node.caption || node.value || node.title || '',
      author: node.author || node.username || null,
      timestamp: node.timestamp ?? node.saved_at ?? node.creation_timestamp ?? null,
    });
  };

  if (Array.isArray(json)) {
    json.forEach(pushEntry);
    return entries;
  }

  if (json && typeof json === 'object') {
    for (const key of ['saved_saved_media', 'saved_posts', 'items', 'saved']) {
      if (Array.isArray(json[key])) {
        json[key].forEach(pushEntry);
      }
    }
    // A single bare entry object.
    if (entries.length === 0 && (json.href || json.permalink || json.url)) {
      pushEntry(json);
    }
  }

  return entries;
}

/**
 * Parse a parsed-JSON Instagram export into importable items.
 * @param {any} json — the parsed contents of saved_posts.json
 * @returns {{ items: Array, skipped: number }}
 *   Each item: { source, shortcode, permalink, author, caption,
 *                media_type, genre, topics, saved_at }
 */
function parseInstagramExport(json) {
  const raw = flattenExport(json);
  const items = [];
  let skipped = 0;

  for (const entry of raw) {
    const shortcode = extractShortcode(entry.href);
    if (!shortcode) {
      skipped += 1;
      continue;
    }

    const caption = (entry.caption || '').trim();
    const author = (entry.author || '').trim() || null;
    const { genre, topics } = classify(`${caption} ${author || ''}`);
    const savedAt = normaliseTimestamp(entry.timestamp);

    items.push({
      source: 'instagram',
      shortcode,
      permalink: `https://www.instagram.com/p/${shortcode}/`,
      author,
      caption,
      // The export does not say reel vs photo reliably; the embed player
      // handles either. Recorded as 'reel' only when the URL says so.
      media_type:
        typeof entry.href === 'string' && /\/reels?\//.test(entry.href)
          ? 'reel'
          : 'post',
      genre,
      topics,
      saved_at: savedAt,
    });
  }

  return { items, skipped };
}

module.exports = { parseInstagramExport, extractShortcode };
