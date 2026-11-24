'use strict';

/* My Archive — feed UI, Smart Feed, and Instagram embed lifecycle.
 *
 * Notes on the two tricky parts:
 *
 * 1. Smart Feed — learns in-session only (nothing is persisted to the
 *    profile beyond the /api/events log). Lingering = like, fast
 *    swipe-past = skip, opening a post = the strongest signal, tapping
 *    a genre tab = interest. After every swipe, everything ahead of the
 *    current card is re-scored and re-ranked; cards already seen stay
 *    where they are.
 *
 * 2. Instagram embeds — built as direct iframes on
 *    instagram.com/<post>/embed/ (no embed.js). The moment a reel stops
 *    being the on-screen card its iframe is removed entirely: that is
 *    the only reliable way to silence a cross-origin player. Swiping
 *    back shows a "Play again" placeholder that rebuilds the embed.
 *    LOOPING: Instagram embeds loop only if Instagram's own player
 *    loops them. There is no loop parameter and no end-of-video event
 *    exposed to us, so this app does not claim looping for Instagram
 *    embeds. Uploaded videos loop natively (see the `loop` attribute
 *    on the <video> element).
 */

const GENRES = ['Tech', 'Design', 'Girls', 'Military', 'Cars', 'Animals', 'Flora & Fauna', 'More'];
const LINGER_MS = 2500; // dwell >= this counts as a like
const SKIP_MS = 800;    // dwell < this, on a swipe-past, counts as a skip

const feedEl = document.getElementById('feed');
const emptyEl = document.getElementById('emptyState');
const tabsEl = document.getElementById('genreTabs');
const counterEl = document.getElementById('counter');
const pillEl = document.getElementById('smartPill');

const state = {
  items: [],        // all items for the current source filter (from the API)
  source: 'all',
  genre: 'All',
  order: [],        // item ids in current display order
  smartOn: true,
  currentId: null,
  seenIds: new Set(),
  activeSince: null,
};

// In-session taste profile. Keys are genres / creators / topics.
const profile = { genre: {}, creator: {}, topic: {}, skipTopic: {} };

// Embed lifecycle per item id: 'fresh' | 'loaded' | 'torn-down' | 'failed'
const cardStates = new Map();
const embedTimers = new Map(); // item id -> load-timeout handle
const itemsById = new Map();

let observer = null;
let rendering = false;

// Archive settings, including the visibility preference. Loaded from the
// server at startup; every visibility decision in the UI reads this
// variable — the preference is never hardcoded.
let settings = {
  visibility: 'private',
  display_name: 'My Archive',
  share_id: '',
  slug: '',
  public_url: '',
  profile_url: '',
};

async function loadSettings() {
  settings = await api('/api/settings');
}

// ---- API helpers ---------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Fire-and-forget: the feed never waits on event logging.
function postEvent(payload) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// ---- loading -------------------------------------------------------------

async function loadItems() {
  const q = state.source === 'all' ? '' : `?source=${state.source}`;
  state.items = await api(`/api/items${q}`);
  itemsById.clear();
  state.items.forEach((it) => itemsById.set(it.id, it));
  state.seenIds.clear();
  state.currentId = null;
  applyOrder();
  renderTabs();
  renderFeed();
}

// ---- ordering: chronological vs Smart Feed -------------------------------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function filteredItems() {
  return state.genre === 'All'
    ? [...state.items]
    : state.items.filter((it) => it.genre === state.genre);
}

// Cold start: no signals yet — interleave genres (round-robin across genre
// groups, shuffled within each group) so no single genre floods the feed.
function coldStartOrder(list) {
  const byGenre = {};
  list.forEach((it) => (byGenre[it.genre] ||= []).push(it));
  Object.values(byGenre).forEach(shuffle);
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const g of Object.keys(byGenre)) {
      if (byGenre[g].length) {
        out.push(byGenre[g].shift());
        added = true;
      }
    }
  }
  return out;
}

function primaryTopic(item) {
  return (item.topics && item.topics[0]) || item.genre;
}

function scoreItem(item) {
  let s = 0;
  s += 2 * (profile.genre[item.genre] || 0);
  if (item.author) s += 1.5 * (profile.creator[item.author] || 0);
  let unseenTopic = false;
  for (const t of item.topics || []) {
    s += profile.topic[t] || 0;
    s -= 1.5 * (profile.skipTopic[t] || 0);
    if (!(t in profile.topic) && !(t in profile.skipTopic)) unseenTopic = true;
  }
  if (unseenTopic) s += 0.35; // exploration bonus for unseen topics
  return s;
}

// Diversity rule: never let the same topic (or creator) run more than two
// cards in a row. Deferred cards go to the back, in score order.
function diversify(sorted) {
  const placed = [];
  const deferred = [];
  for (const item of sorted) {
    const prev = placed.slice(-2);
    const topicClash =
      prev.length === 2 &&
      prev.every((p) => primaryTopic(p) === primaryTopic(item));
    const creatorClash =
      item.author &&
      prev.length === 2 &&
      prev.every((p) => p.author === item.author);
    if (topicClash || creatorClash) deferred.push(item);
    else placed.push(item);
  }
  return placed.concat(deferred);
}

function hasSignals() {
  return (
    Object.keys(profile.genre).length > 0 ||
    Object.keys(profile.creator).length > 0 ||
    Object.keys(profile.topic).length > 0
  );
}

// Re-rank everything ahead of the current card. Seen cards (and the current
// one) keep their positions — the feed never reshuffles under your thumb.
function applyOrder() {
  const list = filteredItems();
  if (!state.smartOn || !hasSignals()) {
    const ordered = state.smartOn ? coldStartOrder(list) : list;
    state.order = ordered.map((it) => it.id);
    return;
  }
  const seen = [];
  const unseen = [];
  for (const it of list) {
    (state.seenIds.has(it.id) || it.id === state.currentId ? seen : unseen).push(it);
  }
  // Seen cards keep their previous relative order.
  seen.sort(
    (a, b) => state.order.indexOf(a.id) - state.order.indexOf(b.id)
  );
  unseen.sort((a, b) => scoreItem(b) - scoreItem(a));
  state.order = [...seen, ...diversify(unseen)].map((it) => it.id);
}

// Why was this card picked next? Strongest live signal wins.
function reasonFor(item) {
  let bestTopic = null;
  let bestTopicScore = 0;
  for (const t of item.topics || []) {
    const s = profile.topic[t] || 0;
    if (s > bestTopicScore) {
      bestTopicScore = s;
      bestTopic = t;
    }
  }
  if (bestTopic) return `Picked next — more on ${bestTopic}`;
  if (item.author && (profile.creator[item.author] || 0) > 0) {
    return `Picked next — more from @${item.author}`;
  }
  if ((profile.genre[item.genre] || 0) > 0) {
    return `Picked next — more ${item.genre}`;
  }
  return null;
}

function topSignal(map) {
  let best = null;
  let bestScore = 0;
  for (const [k, v] of Object.entries(map)) {
    if (v > bestScore) {
      bestScore = v;
      best = k;
    }
  }
  return best;
}

function updatePill() {
  if (!state.smartOn) {
    pillEl.textContent = 'Smart feed off';
    pillEl.classList.remove('pill-on');
    return;
  }
  pillEl.classList.add('pill-on');
  const genre = topSignal(profile.genre);
  const topic = topSignal(profile.topic);
  if (genre && topic) pillEl.textContent = `Smart feed · tuned to ${genre} + ${topic}`;
  else if (genre) pillEl.textContent = `Smart feed · tuned to ${genre}`;
  else pillEl.textContent = 'Smart feed · learning your taste';
}

// ---- rendering -----------------------------------------------------------

function renderTabs() {
  const counts = { All: state.items.length };
  GENRES.forEach((g) => (counts[g] = 0));
  state.items.forEach((it) => {
    counts[it.genre] = (counts[it.genre] || 0) + 1;
  });
  tabsEl.innerHTML = '';
  ['All', ...GENRES].forEach((g) => {
    const btn = document.createElement('button');
    btn.className = 'genre-tab' + (state.genre === g ? ' genre-tab-active' : '');
    btn.innerHTML = `${g} <span class="count">${counts[g] || 0}</span>`;
    btn.addEventListener('click', () => {
      if (state.genre === g) return;
      teardownAllEmbeds();
      state.genre = g;
      state.seenIds.clear();
      state.currentId = null;
      if (g !== 'All') {
        bump(profile.genre, g, 2); // tapping a genre tab = interest
        postEvent({ event_type: 'genre_tap', genre: g });
        updatePill();
      }
      applyOrder();
      renderTabs();
      renderFeed();
      feedEl.scrollTo({ top: 0, behavior: 'instant' });
    });
    tabsEl.appendChild(btn);
  });
}

function updateCounter() {
  const idx = state.currentId != null ? state.order.indexOf(state.currentId) : -1;
  counterEl.textContent =
    state.order.length === 0
      ? '0 / 0'
      : `${idx >= 0 ? idx + 1 : 1} / ${state.order.length}`;
}

function renderFeed() {
  rendering = true;
  if (observer) observer.disconnect();
  feedEl.innerHTML = '';

  const isEmptyOverall = state.items.length === 0;
  emptyEl.classList.toggle('hidden', !isEmptyOverall);
  feedEl.classList.toggle('hidden', isEmptyOverall);
  if (isEmptyOverall) {
    updateCounter();
    rendering = false;
    return;
  }

  if (state.order.length === 0) {
    feedEl.innerHTML = `<div class="empty"><h1>Nothing in ${state.genre} yet.</h1><p>Import more saves or move an item into this genre from its card menu.</p></div>`;
    updateCounter();
    rendering = false;
    return;
  }

  const currentIdx = state.order.indexOf(state.currentId);
  state.order.forEach((id, idx) => {
    const item = itemsById.get(id);
    if (!item) return;
    const card = buildCard(item);
    // Only the card right after the current one carries a reason line.
    if (state.smartOn && hasSignals() && idx === currentIdx + 1) {
      const reason = reasonFor(item);
      if (reason) {
        const el = document.createElement('p');
        el.className = 'reason';
        el.textContent = reason;
        card.querySelector('.info').prepend(el);
      }
    }
    feedEl.appendChild(card);
  });

  observeCards();
  // Restore the scroll position to the current card after a re-render.
  if (state.currentId != null) {
    const el = feedEl.querySelector(`[data-id="${state.currentId}"]`);
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    // A re-render destroys the DOM, including the current card's iframe.
    // If it had a working embed, rebuild it so playback continues.
    const item = itemsById.get(state.currentId);
    if (el && item && item.source === 'instagram' && cardStates.get(item.id) === 'loaded') {
      buildEmbed(el, item);
    }
  }
  updateCounter();
  rendering = false;
}

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = item.id;

  const media = document.createElement('div');
  media.className = 'media';

  if (item.source === 'upload') {
    if (item.media_type === 'video') {
      const video = document.createElement('video');
      video.src = `/${item.file_path}`;
      video.controls = true;
      video.loop = true; // uploaded videos loop natively
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      media.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = `/${item.file_path}`;
      img.alt = item.caption || 'Uploaded photo';
      media.appendChild(img);
    }
  } else {
    // Instagram: embeds are built only when the card becomes active.
    // Until then, a lightweight placeholder (no iframe = no stray audio).
    const st = cardStates.get(item.id) || 'fresh';
    if (st === 'torn-down') {
      media.appendChild(playAgainPlaceholder(item));
    } else if (st === 'failed') {
      media.appendChild(failedPlaceholder(item));
    } else {
      media.appendChild(instagramPlaceholder(item));
    }
  }

  const info = document.createElement('div');
  info.className = 'info';
  const saved = item.saved_at ? new Date(item.saved_at).toLocaleDateString() : '';
  info.innerHTML = `
    <div class="meta">
      <span class="author">${escapeHtml(item.author ? '@' + item.author : 'Saved post')}</span>
      <span class="genre-chip">${escapeHtml(item.genre)}</span>
      <span class="source-tag">${item.source === 'upload' ? 'Upload' : 'Instagram'}${saved ? ' · ' + escapeHtml(saved) : ''}</span>
    </div>
    ${item.caption ? `<p class="caption">${escapeHtml(item.caption)}</p>` : ''}
    <div class="actions"></div>
  `;

  const actions = info.querySelector('.actions');
  if (item.source === 'instagram' && item.permalink) {
    const open = document.createElement('a');
    open.className = 'btn btn-ghost';
    open.href = item.permalink;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open on Instagram';
    open.addEventListener('click', () => {
      // Opening a post is the strongest interest signal there is.
      bump(profile.genre, item.genre, 3);
      if (item.author) bump(profile.creator, item.author, 3);
      (item.topics || []).forEach((t) => bump(profile.topic, t, 2));
      postEvent({ item_id: item.id, event_type: 'open', genre: item.genre });
      updatePill();
      rerankAhead();
    });
    actions.appendChild(open);
  }

  // Share — the public item link. Works only while the archive is Public;
  // while Private the menu explains that and offers to open Settings.
  const shareBtn = document.createElement('button');
  shareBtn.className = 'btn btn-ghost';
  shareBtn.textContent = 'Share';
  shareBtn.addEventListener('click', () => toggleShareMenu(card, item));
  actions.appendChild(shareBtn);

  const genreSelect = document.createElement('select');
  genreSelect.setAttribute('aria-label', 'Move to genre');
  GENRES.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    if (g === item.genre) opt.selected = true;
    genreSelect.appendChild(opt);
  });
  genreSelect.addEventListener('change', async () => {
    try {
      await api(`/api/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genre: genreSelect.value }),
      });
      await loadItems();
    } catch (err) {
      alert(err.message);
      genreSelect.value = item.genre;
    }
  });
  actions.appendChild(genreSelect);

  const del = document.createElement('button');
  del.className = 'btn btn-danger';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!confirm('Delete this item from your archive?')) return;
    try {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      cardStates.delete(item.id);
      await loadItems();
    } catch (err) {
      alert(err.message);
    }
  });
  actions.appendChild(del);

  card.appendChild(media);
  card.appendChild(info);
  return card;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bump(map, key, amount) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

// ---- Instagram embed lifecycle -------------------------------------------

// Derive the embed URL from the permalink: instagram.com/<p|reel>/<code>/
// becomes instagram.com/<p|reel>/<code>/embed/. No embed.js involved.
function embedUrl(item) {
  const base = (item.permalink || `https://www.instagram.com/p/${item.shortcode}/`).replace(/\/$/, '');
  return `${base}/embed/`;
}

function instagramPlaceholder(item) {
  const div = document.createElement('div');
  div.className = 'media-state';
  div.innerHTML = `
    <div class="spinner"></div>
    <p>Loading post${item.author ? ` by @${escapeHtml(item.author)}` : ''}…</p>`;
  return div;
}

function playAgainPlaceholder(item) {
  const div = document.createElement('div');
  div.className = 'media-state';
  div.innerHTML = `<p>Paused when you swiped away.</p>`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = 'Play again';
  btn.addEventListener('click', () => {
    const card = div.closest('.card');
    buildEmbed(card, item);
  });
  div.appendChild(btn);
  return div;
}

function failedPlaceholder(item) {
  const div = document.createElement('div');
  div.className = 'media-state';
  div.innerHTML = `<p>This post didn't load.<br />Instagram may be slow, or the post may be gone.</p>`;
  const row = document.createElement('div');
  row.className = 'row';
  const retry = document.createElement('button');
  retry.className = 'btn btn-primary';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => {
    const card = div.closest('.card');
    buildEmbed(card, item);
  });
  const open = document.createElement('a');
  open.className = 'btn btn-ghost';
  open.href = item.permalink;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open on Instagram';
  row.append(retry, open);
  div.appendChild(row);
  return div;
}

function buildEmbed(card, item) {
  const media = card.querySelector('.media');
  clearEmbedTimer(item.id);
  media.innerHTML = '';
  media.appendChild(instagramPlaceholder(item));

  const iframe = document.createElement('iframe');
  iframe.src = embedUrl(item);
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('scrolling', 'no');
  // NOTE: no loop parameter exists for Instagram embeds, and the player
  // exposes no end-of-video event — looping is entirely up to Instagram.
  let settled = false;
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    clearEmbedTimer(item.id);
    if (ok) {
      cardStates.set(item.id, 'loaded');
      media.innerHTML = '';
      media.appendChild(iframe);
    } else {
      cardStates.set(item.id, 'failed');
      media.innerHTML = '';
      media.appendChild(failedPlaceholder(item));
    }
  };
  iframe.addEventListener('load', () => settle(true));
  iframe.addEventListener('error', () => settle(false));
  // 10s timeout: a half-loaded Instagram player must not hang the card.
  embedTimers.set(item.id, setTimeout(() => settle(false), 10000));
  // The iframe only joins the DOM once it has loaded, so a stalled embed
  // never shows a dead black frame. Attach it hidden to start the load.
  iframe.style.display = 'none';
  media.appendChild(iframe);
}

function clearEmbedTimer(id) {
  const t = embedTimers.get(id);
  if (t) {
    clearTimeout(t);
    embedTimers.delete(id);
  }
}

// Tear the player down completely — removing the iframe is the only
// reliable way to stop a cross-origin embed's audio.
function teardownEmbed(card, item) {
  clearEmbedTimer(item.id);
  const media = card.querySelector('.media');
  const iframe = media.querySelector('iframe');
  if (iframe) {
    iframe.remove();
    cardStates.set(item.id, 'torn-down');
    media.innerHTML = '';
    media.appendChild(playAgainPlaceholder(item));
  }
  const video = media.querySelector('video');
  if (video) video.pause();
}

function teardownAllEmbeds() {
  document.querySelectorAll('.card').forEach((card) => {
    const item = itemsById.get(Number(card.dataset.id));
    if (item) teardownEmbed(card, item);
  });
}

// ---- activation, dwell tracking, re-ranking ------------------------------

function observeCards() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (rendering) return;
      for (const entry of entries) {
        const id = Number(entry.target.dataset.id);
        if (entry.intersectionRatio >= 0.6) activateCard(id);
        else if (id === state.currentId) deactivateCard(id);
      }
    },
    { root: feedEl, threshold: [0, 0.6, 1] }
  );
  document.querySelectorAll('.card').forEach((card) => observer.observe(card));
}

function activateCard(id) {
  if (state.currentId === id) return;
  if (state.currentId != null) deactivateCard(state.currentId);
  state.currentId = id;
  state.activeSince = Date.now();
  // Re-rank only AFTER the new card is current, so it stays pinned while
  // everything ahead of it is re-scored. renderFeed scrolls back to it.
  rerankAhead();
  const item = itemsById.get(id);
  const card = feedEl.querySelector(`[data-id="${id}"]`);
  if (!item || !card) return;

  if (item.source === 'instagram') {
    const st = cardStates.get(id) || 'fresh';
    // A torn-down card shows "Play again" instead of auto-playing.
    // (A 'loaded' card's embed was already rebuilt by renderFeed.)
    if (st === 'fresh') buildEmbed(card, item);
  } else {
    const video = card.querySelector('video');
    if (video) video.play().catch(() => {});
  }
  updateCounter();
}

function deactivateCard(id) {
  const item = itemsById.get(id);
  const card = feedEl.querySelector(`[data-id="${id}"]`);
  if (!item) return;

  // Dwell signal for the card being left behind.
  if (state.activeSince != null) {
    const dwell = Date.now() - state.activeSince;
    if (dwell >= LINGER_MS) {
      // Lingering = like.
      bump(profile.genre, item.genre, 1);
      if (item.author) bump(profile.creator, item.author, 1);
      (item.topics || []).forEach((t) => bump(profile.topic, t, 1));
      postEvent({ item_id: id, event_type: 'linger', genre: item.genre });
    } else if (dwell < SKIP_MS) {
      // Fast swipe-past = skip. Topics sink; the genre dips slightly.
      (item.topics || []).forEach((t) => bump(profile.skipTopic, t, 1));
      bump(profile.genre, item.genre, -0.5);
      postEvent({ item_id: id, event_type: 'skip', genre: item.genre });
    }
    updatePill();
  }
  state.activeSince = null;

  if (card) teardownEmbed(card, item);
  state.seenIds.add(id);
  if (state.currentId === id) state.currentId = null;
  // No re-rank here: the next card's activation re-ranks, once the new
  // card is current and pinned. Re-ranking here would move the card the
  // user is looking at.
}

// Re-score and re-rank everything ahead after a swipe (Smart Feed on only).
// The current card stays put; the feed is rebuilt and scrolled back to it.
function rerankAhead() {
  if (!state.smartOn || !hasSignals()) return;
  const before = state.order.join(',');
  applyOrder();
  if (state.order.join(',') === before) return;
  renderFeed();
}

// ---- source filter, pill, upload modal -----------------------------------

document.querySelectorAll('.sources .chip[data-source]').forEach((chip) => {
  chip.addEventListener('click', async () => {
    if (chip.dataset.source === state.source) return;
    teardownAllEmbeds();
    state.source = chip.dataset.source;
    document
      .querySelectorAll('.sources .chip')
      .forEach((c) => c.classList.toggle('chip-active', c === chip));
    await loadItems();
    feedEl.scrollTo({ top: 0, behavior: 'instant' });
  });
});

pillEl.addEventListener('click', () => {
  state.smartOn = !state.smartOn;
  updatePill();
  applyOrder();
  renderFeed();
});

const uploadModal = document.getElementById('uploadModal');
const uploadForm = document.getElementById('uploadForm');
const uploadError = document.getElementById('uploadError');

function openUpload() {
  uploadError.classList.add('hidden');
  uploadForm.reset();
  uploadModal.classList.remove('hidden');
}
function closeUpload() {
  uploadModal.classList.add('hidden');
}

document.getElementById('uploadBtn').addEventListener('click', openUpload);
document.getElementById('emptyUploadBtn').addEventListener('click', openUpload);
document.getElementById('uploadCancel').addEventListener('click', closeUpload);
uploadModal.addEventListener('click', (e) => {
  if (e.target === uploadModal) closeUpload();
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  uploadError.classList.add('hidden');
  const form = new FormData(uploadForm);
  try {
    const res = await fetch('/api/items', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    closeUpload();
    // Jump to the Uploads source so the new item is visible immediately.
    if (state.source !== 'upload') {
      state.source = 'upload';
      document.querySelectorAll('.sources .chip').forEach((c) =>
        c.classList.toggle('chip-active', c.dataset.source === 'upload')
      );
    }
    await loadItems();
  } catch (err) {
    uploadError.textContent = err.message;
    uploadError.classList.remove('hidden');
  }
});

// ---- sharing -------------------------------------------------------------
// Standard share-URL schemes (same as the server's public pages).

function shareLinks(url, text) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return {
    x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    whatsapp: `https://wa.me/?text=${t}%20${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
  };
}

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = old;
    }, 1500);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  }
}

function toggleShareMenu(card, item) {
  const existing = card.querySelector('.share-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'share-menu';
  const itemUrl = `${settings.public_url}/item/${item.id}`;

  if (settings.visibility !== 'public') {
    menu.innerHTML =
      '<p>Your archive is Private — public links return a 404. Turn on Public visibility in Settings to share this item.</p>';
    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-primary btn-small';
    openBtn.textContent = 'Open Settings';
    openBtn.addEventListener('click', openSettingsModal);
    menu.appendChild(openBtn);
  } else {
    const text =
      item.caption || `${item.author ? `@${item.author}` : 'A saved post'} — via My Archive`;
    const links = shareLinks(itemUrl, text);
    const urlLine = document.createElement('p');
    urlLine.className = 'share-url';
    urlLine.textContent = itemUrl;
    menu.appendChild(urlLine);
    const row = document.createElement('div');
    row.className = 'share-row';
    const copy = document.createElement('button');
    copy.className = 'btn btn-ghost btn-small';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', () => copyText(itemUrl, copy));
    row.appendChild(copy);
    [
      ['Share on X', links.x],
      ['WhatsApp', links.whatsapp],
      ['Facebook', links.facebook],
    ].forEach(([label, href]) => {
      const a = document.createElement('a');
      a.className = 'btn btn-ghost btn-small';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label;
      row.appendChild(a);
    });
    menu.appendChild(row);
  }
  card.querySelector('.info').appendChild(menu);
}

// ---- settings modal ------------------------------------------------------

const settingsModal = document.getElementById('settingsModal');
const settingsForm = document.getElementById('settingsForm');
const settingsError = document.getElementById('settingsError');
const displayNameInput = document.getElementById('displayNameInput');
const publicLinksEl = document.getElementById('publicLinks');
const publicUrlLink = document.getElementById('publicUrlLink');
const profileUrlLink = document.getElementById('profileUrlLink');

function refreshPublicLinks() {
  const selected = settingsForm.querySelector('input[name="visibility"]:checked');
  const isPublic = selected
    ? selected.value === 'public'
    : settings.visibility === 'public';
  publicLinksEl.classList.toggle('hidden', !isPublic);
  if (isPublic) {
    publicUrlLink.href = settings.public_url;
    publicUrlLink.textContent = settings.public_url;
    profileUrlLink.href = settings.profile_url;
    profileUrlLink.textContent = settings.profile_url;
  }
}

function refreshSettingsModal() {
  displayNameInput.value = settings.display_name;
  const radio = document.querySelector(
    `input[name="visibility"][value="${settings.visibility}"]`
  );
  if (radio) radio.checked = true;
  refreshPublicLinks();
}

function openSettingsModal() {
  settingsError.classList.add('hidden');
  refreshSettingsModal();
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('settingsCancel').addEventListener('click', closeSettingsModal);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettingsModal();
});
settingsForm
  .querySelectorAll('input[name="visibility"]')
  .forEach((r) => r.addEventListener('change', refreshPublicLinks));
document
  .getElementById('copyPublicLink')
  .addEventListener('click', (e) => copyText(settings.public_url, e.currentTarget));

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  settingsError.classList.add('hidden');
  const form = new FormData(settingsForm);
  try {
    settings = await api('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: form.get('display_name'),
        visibility: form.get('visibility'),
      }),
    });
    closeSettingsModal();
    renderFeed(); // share buttons read the new visibility
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.classList.remove('hidden');
  }
});

// ---- init ----------------------------------------------------------------

updatePill();
loadSettings()
  .then(loadItems)
  .catch((err) => {
    feedEl.innerHTML = `<div class="empty"><h1>Couldn't reach the server.</h1><p>${escapeHtml(err.message)}</p><p>Is the server running? <code>npm start</code>, then reload this page.</p></div>`;
  });
