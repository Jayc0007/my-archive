'use strict';

/**
 * Public pages — the shareable face of a Public archive.
 *
 * Routes (all enforced in server.js, which checks the visibility
 * preference before rendering anything here):
 *   /p/:share_id            public archive feed
 *   /p/:share_id/item/:id   one public item
 *   /u/:username            alias for the feed (username = display-name slug)
 *   /u/:username/item/:id   alias for one item
 *
 * Privacy rule: a Private archive is indistinguishable from a missing
 * one. Every denied or unknown public URL renders the same generic
 * 404 — no title, no name, no "this archive is private" hint.
 */

const { GENRES } = require('./classifier');

const PROJECT_URL = 'https://github.com/Jayc0007/my-archive';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Standard share-URL schemes. No SDKs, no tracking — plain links.
function shareLinks(url, text) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return {
    x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    whatsapp: `https://wa.me/?text=${t}%20${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
  };
}

function shareButtons(url, text) {
  const links = shareLinks(url, text);
  return `
    <div class="share-row">
      <button class="btn btn-ghost btn-small" data-copy-link="${escapeHtml(url)}">Copy link</button>
      <a class="btn btn-ghost btn-small" href="${links.x}" target="_blank" rel="noopener">Share on X</a>
      <a class="btn btn-ghost btn-small" href="${links.whatsapp}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="btn btn-ghost btn-small" href="${links.facebook}" target="_blank" rel="noopener">Facebook</a>
    </div>`;
}

function pageShell({ title, description, url, baseUrl, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(url)}" />
  <meta property="og:image" content="${baseUrl}/og-image.svg" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${baseUrl}/og-image.svg" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="public-page">
  ${body}
  <script>
    // Copy-link buttons (no framework needed).
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy-link]');
      if (!btn) return;
      const done = () => {
        const old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = old; }, 1500);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(btn.dataset.copyLink).then(done, done);
      } else {
        const ta = document.createElement('textarea');
        ta.value = btn.dataset.copyLink;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      }
    });
  </script>
</body>
</html>`;
}

function footer() {
  return `
  <footer class="public-footer">
    Made with <a href="${PROJECT_URL}">My Archive</a> — an Instagram for your own memories.
  </footer>`;
}

function embedUrl(item) {
  const base = (item.permalink || `https://www.instagram.com/p/${item.shortcode}/`).replace(/\/$/, '');
  return `${base}/embed/`;
}

function itemMedia(item) {
  if (item.source === 'upload') {
    if (item.media_type === 'video') {
      return `<video src="/${escapeHtml(item.file_path)}" controls loop muted playsinline preload="metadata"></video>`;
    }
    return `<img src="/${escapeHtml(item.file_path)}" alt="${escapeHtml(item.caption || 'Uploaded photo')}" loading="lazy" />`;
  }
  return `<iframe src="${escapeHtml(embedUrl(item))}" allowfullscreen scrolling="no" loading="lazy" title="Instagram post${item.author ? ` by @${escapeHtml(item.author)}` : ''}"></iframe>`;
}

function itemCard(item, itemUrl) {
  const saved = item.saved_at ? new Date(item.saved_at).toLocaleDateString() : '';
  return `
  <article class="public-card">
    <div class="public-media">${itemMedia(item)}</div>
    <div class="info">
      <div class="meta">
        <span class="author">${escapeHtml(item.author ? '@' + item.author : 'Saved post')}</span>
        <span class="genre-chip">${escapeHtml(item.genre)}</span>
        <span class="source-tag">${item.source === 'upload' ? 'Upload' : 'Instagram'}${saved ? ' · ' + escapeHtml(saved) : ''}</span>
      </div>
      ${item.caption ? `<p class="caption">${escapeHtml(item.caption)}</p>` : ''}
      <div class="actions">
        <a class="btn btn-ghost btn-small" href="${escapeHtml(itemUrl)}">View item</a>
        ${item.permalink ? `<a class="btn btn-ghost btn-small" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener">Open on Instagram</a>` : ''}
      </div>
      ${shareButtons(itemUrl, item.caption || `${item.author ? `@${item.author}` : 'A saved post'} — via My Archive`)}
    </div>
  </article>`;
}

/**
 * Public archive feed. `genre` is the active filter ('All' by default);
 * `feedBase` is the canonical feed URL without query params.
 */
function renderArchivePage({ settings, items, genre, feedBase, baseUrl }) {
  const name = settings.display_name;
  const title = `${name} — My Archive`;
  const description =
    `${name}'s public archive on My Archive: saved posts, photos and videos, ` +
    `sorted into genres. An Instagram for your own memories.`;
  const url = genre && genre !== 'All' ? `${feedBase}?genre=${encodeURIComponent(genre)}` : feedBase;

  const chips = ['All', ...GENRES]
    .map((g) => {
      const href = g === 'All' ? feedBase : `${feedBase}?genre=${encodeURIComponent(g)}`;
      const active = (genre || 'All') === g ? ' chip-active' : '';
      return `<a class="chip${active}" href="${escapeHtml(href)}">${escapeHtml(g)}</a>`;
    })
    .join('');

  const cards = items
    .map((item) => itemCard(item, `${feedBase}/item/${item.id}`))
    .join('');

  const body = `
  <header class="topbar">
    <div class="brand">${escapeHtml(name)}</div>
    <div class="top-actions">
      <a class="btn btn-ghost" href="${PROJECT_URL}">Get My Archive</a>
    </div>
  </header>
  <nav class="sources">${chips}</nav>
  <main class="public-feed">
    <p class="public-intro">${items.length} saved ${items.length === 1 ? 'item' : 'items'}${genre && genre !== 'All' ? ` in ${escapeHtml(genre)}` : ''}.</p>
    ${shareButtons(url, `${name}'s archive on My Archive`)}
    ${cards || '<p class="public-empty">Nothing here yet.</p>'}
  </main>
  ${footer()}`;

  return pageShell({ title, description, url, baseUrl, body });
}

/** One public item, large. */
function renderItemPage({ settings, item, itemUrl, feedBase, baseUrl }) {
  const name = settings.display_name;
  const title = item.caption
    ? `${item.caption.slice(0, 80)} — ${name} · My Archive`
    : `Saved post — ${name} · My Archive`;
  const description =
    item.caption ||
    `A saved ${item.genre.toLowerCase()} post from ${name}'s public archive on My Archive.`;

  const body = `
  <header class="topbar">
    <div class="brand"><a class="brand-link" href="${escapeHtml(feedBase)}">${escapeHtml(name)}</a></div>
    <div class="top-actions">
      <a class="btn btn-ghost" href="${PROJECT_URL}">Get My Archive</a>
    </div>
  </header>
  <main class="public-feed">
    <p><a class="back-link" href="${escapeHtml(feedBase)}">← Back to ${escapeHtml(name)}'s archive</a></p>
    ${itemCard(item, itemUrl)}
  </main>
  ${footer()}`;

  return pageShell({ title, description, url: itemUrl, baseUrl, body });
}

/** Generic 404 — identical whether the archive is private, the share id
 *  is wrong, or the item doesn't exist. Deliberately leaks nothing. */
function renderNotFound(baseUrl) {
  const body = `
  <main class="page">
    <h1>Page not found.</h1>
    <p>The link may be wrong, or the archive may not be public.</p>
    <p><a class="btn btn-primary" href="${PROJECT_URL}">Get My Archive</a></p>
  </main>
  ${footer()}`;
  return pageShell({
    title: 'Not found — My Archive',
    description: 'This page does not exist.',
    url: baseUrl,
    baseUrl,
    body,
  });
}

module.exports = {
  PROJECT_URL,
  renderArchivePage,
  renderItemPage,
  renderNotFound,
  shareLinks,
};
