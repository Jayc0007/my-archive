'use strict';

/**
 * Genre classifier — tags a saved item from its caption + hashtags (+ author
 * handle as a weak signal). Pure keyword scoring, no ML, no network calls.
 *
 * How it works:
 *   1. The caption, hashtags and author are lower-cased into one text blob.
 *   2. Each genre has a keyword list (below). Every keyword that appears as
 *      a whole word/phrase in the blob scores one point for its genre.
 *   3. The genre with the highest score wins. Ties resolve in the priority
 *      order of GENRES (most specific first). Zero matches -> "More".
 *
 * The matched keywords are returned as `topics` — the Smart Feed uses them
 * to learn what the user lingers on (e.g. "robot", "f1", "monstera").
 */

const GENRES = [
  'Tech',
  'Design',
  'Girls',
  'Military',
  'Cars',
  'Animals',
  'Flora & Fauna',
  'More',
];

// Keyword lists. Keep them lowercase; matching is case-insensitive and uses
// word boundaries, so "car" will not match "card" or "scarf". Multi-word
// phrases are matched as exact substrings.
const KEYWORDS = {
  Tech: [
    'robot', 'robotics', 'humanoid', 'ai', 'artificial intelligence',
    'machine learning', 'neural', 'llm', 'gpt', 'chatbot', 'gpu', 'nvidia',
    'chip', 'semiconductor', 'software', 'code', 'coding', 'developer',
    'programming', 'python', 'javascript', 'app', 'drone', 'spacex',
    'rocket', 'satellite', 'space', 'nasa', 'cyber', 'quantum', 'lidar',
    'autonomous', 'self-driving', '3d print', '3d printing', 'vr', 'ar',
    'headset', 'tesla bot', 'openai', 'anthropic', 'deep learning',
    'computer vision', 'sensor', 'circuit', 'arduino', 'raspberry pi',
    'electric', 'ev', 'battery', 'starlink', 'mars',
  ],
  Design: [
    'design', 'architecture', 'interior', 'minimal', 'minimalism',
    'furniture', 'typography', 'branding', 'logo', 'ui', 'ux', 'aesthetic',
    'poster', 'graphic', 'render', '3d render', 'blender', 'sketch',
    'prototype', 'chair', 'lamp', 'sofa', 'room', 'decor', 'layout',
    'font', 'illustration', 'art', 'gallery', 'museum', 'sculpture',
  ],
  Girls: [
    'fashion', 'outfit', 'style', 'makeup', 'beauty', 'dress', 'model',
    'photoshoot', 'skincare', 'jewellery', 'jewelry', 'heels', 'saree',
    'gown', 'nails', 'hairstyle', 'streetwear', 'vogue', 'runway',
  ],
  Military: [
    'military', 'army', 'navy', 'air force', 'fighter', 'jet', 'tank',
    'soldier', 'defense', 'defence', 'missile', 'aircraft carrier',
    'submarine', 'special forces', 'combat', 'war', 'weapon', 'rifle',
    'helicopter', 'bomber', 'drone strike', 'naval', 'infantry',
  ],
  Cars: [
    'car', 'ferrari', 'lamborghini', 'porsche', 'bmw', 'supercar',
    'hypercar', 'drift', 'engine', 'v8', 'v12', 'gt3', 'racing', 'f1',
    'formula 1', 'formula1', 'motorsport', 'classic car', 'motorcycle',
    'bike', 'biker', 'mustang', 'gtr', 'amg', 'audi', 'mercedes',
    'mclaren', 'bugatti', 'koenigsegg', 'track day', 'drag race',
  ],
  Animals: [
    'dog', 'cat', 'puppy', 'kitten', 'wolf', 'lion', 'tiger', 'elephant',
    'horse', 'bird', 'wildlife', 'pet', 'panda', 'fox', 'owl', 'eagle',
    'dolphin', 'whale', 'shark', 'monkey', 'bear', 'deer', 'rabbit',
  ],
  'Flora & Fauna': [
    'plant', 'plants', 'flower', 'flowers', 'garden', 'gardening', 'tree',
    'forest', 'nature', 'jungle', 'bloom', 'leaf', 'botanical',
    'succulent', 'monstera', 'landscape', 'mountain', 'ocean', 'sunset',
    'hiking', 'camping', 'national park', 'waterfall', 'desert', 'beach',
  ],
  // "More" has no keywords — it is the default when nothing matches.
  More: [],
};

// Escape a string for use inside a RegExp.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build one word-boundary regex per keyword, lazily, and cache it.
const regexCache = new Map();
function keywordRegex(keyword) {
  if (!regexCache.has(keyword)) {
    // \b works for word characters; for keywords ending in digits or
    // symbols (e.g. "f1", "v8") the trailing \b still behaves correctly.
    regexCache.set(keyword, new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i'));
  }
  return regexCache.get(keyword);
}

/**
 * Classify a piece of text (caption + hashtags + author).
 * @param {string} text
 * @returns {{ genre: string, score: number, topics: string[] }}
 *   topics = the matched keywords (lower-cased), used by the Smart Feed.
 */
function classify(text) {
  const blob = (text || '').toLowerCase();
  let bestGenre = 'More';
  let bestScore = 0;
  let bestTopics = [];

  for (const genre of GENRES) {
    const keywords = KEYWORDS[genre] || [];
    const matched = keywords.filter((kw) => keywordRegex(kw).test(blob));
    // Strictly greater, so ties keep the earlier (higher-priority) genre.
    if (matched.length > bestScore) {
      bestScore = matched.length;
      bestGenre = genre;
      bestTopics = matched;
    }
  }

  return { genre: bestGenre, score: bestScore, topics: bestTopics };
}

module.exports = { GENRES, KEYWORDS, classify };
