// Datasets view: catalog of built-in datasets (from the backend schema),
// local dataset files, and the offline-mode toggle.
//
// Everything renders from GET /api/datasets — the same schema that drives
// the Benchmark form — so this view never hardcodes dataset knowledge.
'use strict';

(function datasetsView() {
  const $ = (id) => document.getElementById(id);
  let datasetDirFull = '';   // full path for the copy button

  // Short badge on the card; the tooltip carries the full story.
  const BADGES = {
    offline: { cls: 'offline', text: 'offline',
      tip: 'Fully self-contained — never touches the network.' },
    cached: { cls: 'cached', text: 'auto-download',
      tip: 'Downloads once on first use, then runs from cache. Set a local dataset path to skip the download entirely.' },
    hf: { cls: 'hf', text: 'hf hub',
      tip: 'Fetched from the HuggingFace Hub. Pin subset + split so a warmed cache also works offline.' },
  };

  const ICON_PATHS = {
    random: 'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    sonnet: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    sharegpt: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z',
    'speed-bench': 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
    hf: 'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z',
  };

  function icon(id, size) {
    const wrap = document.createElement('span');
    wrap.className = 'ds-icon';
    const s = size || 20;
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${s}" height="${s}">`
      + `<path fill="currentColor" d="${ICON_PATHS[id] || ICON_PATHS.file}"/></svg>`;
    return wrap;
  }

  function badgeEl(network) {
    const b = BADGES[network];
    const span = document.createElement('span');
    if (b) {
      span.className = `ds-badge ${b.cls}`;
      span.textContent = b.text;
      span.dataset.tip = b.tip;
    }
    return span;
  }

  // One chip per field: solid = has a default, ghost = optional/empty.
  // The tooltip shows the real CLI flag plus the field's help text.
  function chip(f) {
    const el = document.createElement('span');
    const hasDefault = f.default !== '' && f.default !== false && f.default != null;
    el.className = 'ds-chip' + (hasDefault ? '' : ' ghost');
    if (hasDefault) {
      el.innerHTML = `${f.label.toLowerCase()} <b>${f.default}</b>`;
    } else {
      el.textContent = f.label.toLowerCase();
    }
    el.dataset.tip = f.flag + (f.tip ? ` — ${f.tip}` : '');
    return el;
  }

  function useDataset(id) {
    document.dispatchEvent(new CustomEvent('use-dataset', { detail: id }));
    const nav = document.querySelector('.nav-item[data-view="benchmark"]');
    if (nav) nav.click();
  }

  function useButton(id) {
    const btn = document.createElement('button');
    btn.className = 'ds-use-btn';
    btn.innerHTML = 'Use in Benchmark <svg viewBox="0 0 24 24" width="14" height="14">'
      + '<path fill="currentColor" d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>';
    btn.addEventListener('click', () => useDataset(id));
    return btn;
  }

  function card(d) {
    const el = document.createElement('div');
    el.className = 'dataset-card';

    const head = document.createElement('div');
    head.className = 'ds-card-head';
    head.appendChild(icon(d.id));
    const title = document.createElement('div');
    title.className = 'ds-card-title';
    const h = document.createElement('h4');
    h.textContent = d.id;
    title.appendChild(h);
    const note = document.createElement('span');
    note.className = 'ds-note';
    note.textContent = d.note || '';
    note.title = d.note || '';
    title.appendChild(note);
    head.appendChild(title);
    head.appendChild(badgeEl(d.network));
    el.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'ds-chips';
    (d.fields || []).forEach((f) => chips.appendChild(chip(f)));
    el.appendChild(chips);

    const foot = document.createElement('div');
    foot.className = 'ds-card-foot';
    foot.appendChild(useButton(d.id));
    el.appendChild(foot);
    return el;
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function fileRow(d) {
    const row = document.createElement('div');
    row.className = 'ds-file-row';
    // The mechanics live in the tooltip, not on the surface.
    row.dataset.tip = `${d.id} — runs as a ShareGPT-format dataset `
      + `(--dataset-path ${d.path || ''})`;
    row.appendChild(icon('file', 16));
    const name = document.createElement('span');
    name.className = 'ds-file-name';
    name.textContent = d.id.slice('file:'.length);
    row.appendChild(name);
    const size = document.createElement('span');
    size.className = 'ds-file-meta';
    size.textContent = formatSize(d.size);
    row.appendChild(size);
    row.appendChild(useButton(d.id));
    return row;
  }

  async function render() {
    let items;
    try { items = await API.getDatasets(); } catch (_) { return; /* offline */ }
    try {
      window.__settings = await API.getSettings();
    } catch (_) { /* keep last known */ }
    const s = window.__settings || {};

    $('offline-mode-toggle').checked = String(s.offline_mode) === '1';

    // Folder chip: last two path segments on the surface, everything else
    // (full path + drop instructions) in the tooltip.
    datasetDirFull = s.dataset_dir || '';
    const parts = datasetDirFull.split(/[\\/]/).filter(Boolean);
    $('datasets-dir').textContent = parts.length
      ? parts.slice(-2).join('/') : '…';
    $('ds-folder-chip').dataset.tip = datasetDirFull
      ? `${datasetDirFull} — drop .json / .jsonl files (ShareGPT format) here; `
        + 'they appear below and in the Benchmark dataset dropdown.'
      : '';

    const catalog = $('dataset-catalog');
    catalog.innerHTML = '';
    items.filter((d) => d.kind === 'builtin').forEach((d) => {
      catalog.appendChild(card(d));
    });

    const files = items.filter((d) => d.kind === 'file');
    const list = $('dataset-files-list');
    list.innerHTML = '';
    files.forEach((d) => list.appendChild(fileRow(d)));
    $('dataset-files-empty').style.display = files.length ? 'none' : '';
    const count = $('ds-files-count');
    count.textContent = String(files.length);
    count.classList.toggle('hidden', !files.length);
  }

  $('offline-mode-toggle').addEventListener('change', async (e) => {
    const checked = e.target.checked;
    try {
      await API.putSettings({ offline_mode: checked });
      // Benchmark form listens for this and re-applies requiredness.
      document.dispatchEvent(new CustomEvent('settings-saved'));
    } catch (err) {
      e.target.checked = !checked;
      alert('Could not save offline mode: ' + err.message);
    }
  });

  $('copy-dataset-dir').addEventListener('click', (e) => {
    e.stopPropagation();
    if (datasetDirFull && navigator.clipboard) {
      navigator.clipboard.writeText(datasetDirFull).catch(() => {});
    }
  });

  document.addEventListener('view-changed', (e) => {
    if (e.detail === 'datasets') render();
  });
  render();
})();
