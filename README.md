# My Archive

> **An Instagram for your own memories** — archive saved posts, phone photos and videos, and every memory of a lifetime in one genre-sorted feed with a smart recommendation engine.

Instagram, Twitter and TikTok are built for the feed — for what's new, right now. My Archive is built for the opposite: **everything you've ever saved**. It is Instagram for your own profile and your own images. Your saved posts from Instagram or any other place, the photos and videos saved on your phone, every memory a person can have in their entire lifetime — all of it in one place, sorted into genres, in a vertical feed that learns what you actually linger on.

No account. No cloud. No ads. Your archive lives on your machine, and it stays yours — unless you choose to share it.

## What it does

- **One feed for everything saved.** Instagram saves and device uploads live side by side in a dark, Instagram-style vertical scroll-snap feed with a position counter (`3 / 42`).
- **Genre tabs.** Every item is sorted into Tech, Design, Girls, Military, Cars, Animals, Flora & Fauna, or More by a keyword classifier that reads the caption and hashtags. You can move any item to another genre from its card.
- **Smart Feed (TikTok-style, in-session learning).** On by default, with a toggle pill in the top bar. Lingering on a card counts as a like, a fast swipe-past counts as a skip, opening a post on Instagram is the strongest signal, and tapping a genre tab counts as interest. After every swipe, everything ahead of you is re-scored and re-ranked: the same creator, genre and topics rise, skipped topics sink. A diversity rule stops any one topic from flooding the feed, unseen topics get a small exploration bonus, and the next card tells you why it was picked (`Picked next — more on robot`). The pill shows what the feed is currently tuned to. Cold start interleaves genres and creators so the first scroll is varied.
- **Real Instagram playback.** Posts play through Instagram's own embed player (direct iframe, no `embed.js`). The moment a reel leaves the screen its player is torn down completely — the only reliable way to silence a cross-origin embed — and swiping back shows a **Play again** placeholder. A 10-second timeout swaps a stalled embed for a card with **Try again** / **Open on Instagram**.
- **Device uploads.** Upload photos and videos from any device; they're stored locally and loop natively.
- **Private by default, public when you say so.** A visibility preference (Private / Public) in Settings controls a shareable public page for your archive and per-item share links, with copy-link and share-to-X / WhatsApp / Facebook actions. Private archives answer every public URL with a plain 404 — no title, no hint.
- **Source filters.** All / Instagram / Uploads. Facebook saves are coming soon — no fake data anywhere.

## How sync works (the honest version)

There is **no official Meta API that exposes your saved posts** to a third-party app — not to us, not to anyone. So My Archive syncs the way every honest tool does:

1. In Instagram, go to **Settings → Accounts Centre → Your information and permissions → Download your information**, choose **JSON** format, and request the download.
2. Import the `saved_posts.json` file here (Import page, or `POST /api/import`).
3. Every post is imported with its link, author, caption and save date, classified into a genre, and deduplicated by permalink — importing the same export twice is safe.

Your export never leaves your machine.

## Quick start

Requires Node.js **22.5+** (the app uses Node's built-in `node:sqlite` — no native add-ons, no database server).

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

To try it immediately with clearly-marked fictional data, open the Import page and click **Import the fictional sample export** — eight invented posts spanning the genres. Nothing in this repo contains any real person's saved posts, captions, or usernames.

## Visibility & public pages

The visibility preference is a real setting stored in the database (`settings.visibility`), default **Private**, toggled in **Settings** in the top bar. The server reads it fresh on every public request.

| Visibility | Public URLs |
|---|---|
| Private (default) | `/p/:share_id`, `/u/:username` and every item link return a generic **404** — identical to a missing page, so a private archive is indistinguishable from one that doesn't exist. |
| Public | Your archive gets a shareable feed page and per-item pages, viewable without logging in. |

**Public routes**

- `GET /p/:share_id` — your public archive feed (genre filter via `?genre=Tech`).
- `GET /p/:share_id/item/:id` — one public item.
- `GET /u/:username` and `GET /u/:username/item/:id` — the same pages under your display-name slug.

Public pages carry Open Graph / Twitter Card meta tags (title, description, `og:image`) so shared links unfurl nicely, share buttons (copy link, X, WhatsApp, Facebook), and a **Made with My Archive** link back to this project — public archives bring more people to the app.

**Privacy notes.** Uploaded files are saved under random, unguessable filenames, so a private archive's files can't be found by guessing URLs. This build has no accounts or login by design — it is a single-user local app. If you host it on a public server, put it behind your own authentication if you want the private feed itself to be access-controlled; the visibility preference governs the public routes.

## Architecture

```
my-archive/
├── server.js            Express app: static frontend, REST API, public pages
├── src/
│   ├── db.js            SQLite (node:sqlite): items, events, settings
│   ├── classifier.js    Keyword genre classifier (lists documented in code)
│   ├── importer.js      Instagram export parser (saved_posts.json shapes)
│   └── publicPages.js   Server-rendered public feed / item / 404 pages
├── public/
│   ├── index.html       Feed shell
│   ├── app.js           Feed rendering, Smart Feed, embed lifecycle, sharing
│   ├── styles.css       Dark Instagram-style UI
│   ├── import.html      Import page
│   ├── import.js        Import page logic
│   ├── og-image.svg     Open Graph image placeholder
│   └── sample-export.json  Fictional demo export (clearly labelled)
├── data/                SQLite database (git-ignored)
└── uploads/             Uploaded media (git-ignored)
```

- **Backend:** Node.js + Express. Storage is SQLite via Node's built-in `node:sqlite` — zero native dependencies. Uploads via `multer`.
- **Frontend:** plain HTML/CSS/JS, no framework, no build step. The Smart Feed runs entirely in the browser; interaction signals are also logged to `POST /api/events` so the feed can learn across sessions later.
- **Genre classifier:** keyword scoring over caption + hashtags + author (`src/classifier.js`). The matched keywords double as the Smart Feed's topics.

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/stats` | Totals by genre and source |
| `GET` | `/api/settings` | Visibility, display name, share id, public URLs |
| `PATCH` | `/api/settings` | `{ visibility: "private" \| "public", display_name }` |
| `GET` | `/api/items?genre=&source=` | List items, newest first |
| `GET` | `/api/items/:id` | One item |
| `POST` | `/api/items` | Multipart upload: `file` + `caption` + `genre` (`Auto` classifies) |
| `PATCH` | `/api/items/:id` | `{ genre }` — move an item to a genre |
| `DELETE` | `/api/items/:id` | Delete an item (and its uploaded file) |
| `POST` | `/api/events` | Smart Feed signal: `{ item_id, event_type, genre, topic }` (`linger` / `skip` / `open` / `genre_tap`) |
| `POST` | `/api/import` | Instagram export JSON — multipart `file` or raw JSON body |

## A note on looping

Instagram embeds loop **only if Instagram's own player loops them**. There is no loop parameter for Instagram embeds and the player exposes no end-of-video event, so this app makes no looping claim for them — and says so in the code. Videos you upload loop natively via the `loop` attribute.

## Roadmap

- **Facebook saves** — the third source, next to Instagram and Uploads.
- **Camera-roll sync** — photos and videos from your phone landing in the archive automatically.
- **Native wrapper** — a real installable app (App Store / Google Play) built on this codebase.
- **Cross-session Smart Feed** — learn from the stored `/api/events` log, not just the live session.
- **Collections** — user-defined shelves inside genres.

## Author

Built by **Jay Chaudhary** ([github.com/Jayc0007](https://github.com/Jayc0007)).

MIT License — see [LICENSE](LICENSE).
