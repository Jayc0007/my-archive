'use strict';

/* Import page — uploads an Instagram saved_posts.json export (or the
 * fictional sample) to POST /api/import and shows the result. */

const dropEl = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const resultEl = document.getElementById('result');
const demoBtn = document.getElementById('demoBtn');

function showResult(html) {
  resultEl.innerHTML = html;
  resultEl.classList.remove('hidden');
}

function showError(message) {
  showResult(`<p class="big">Import failed.</p><p>${message}</p>`);
}

function showSummary(data) {
  const genreLines = Object.entries(data.genres || {})
    .map(([g, n]) => `<li>${g}: ${n}</li>`)
    .join('');
  showResult(`
    <p class="big">Imported ${data.imported} post${data.imported === 1 ? '' : 's'}.</p>
    <p>
      Found ${data.found} posts in the export.
      ${data.duplicates ? `${data.duplicates} were already in your archive.` : ''}
      ${data.skipped ? `${data.skipped} entries had no Instagram link and were skipped.` : ''}
    </p>
    ${genreLines ? `<ul>${genreLines}</ul>` : ''}
    <p><a class="btn btn-primary" href="/">Open the feed</a></p>
  `);
}

async function importFile(file) {
  const form = new FormData();
  form.append('file', file);
  showResult('<p>Importing…</p>');
  try {
    const res = await fetch('/api/import', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
    showSummary(data);
  } catch (err) {
    showError(err.message);
  }
}

async function importDemo() {
  showResult('<p>Importing the sample export…</p>');
  try {
    const res = await fetch('/sample-export.json');
    const json = await res.json();
    const importRes = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    const data = await importRes.json().catch(() => ({}));
    if (!importRes.ok) throw new Error(data.error || 'Import failed.');
    showSummary(data);
  } catch (err) {
    showError(err.message);
  }
}

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) importFile(fileInput.files[0]);
});

demoBtn.addEventListener('click', importDemo);

dropEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropEl.classList.add('drag');
});
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag'));
dropEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dropEl.classList.remove('drag');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) importFile(file);
});
