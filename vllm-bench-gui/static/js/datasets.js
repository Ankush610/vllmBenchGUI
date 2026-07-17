// Datasets view: catalog of built-in datasets (from the backend schema),
// local dataset files, and the offline-mode toggle.
//
// Everything renders from GET /api/datasets — the same schema that drives
// the Benchmark form — so this view never hardcodes dataset knowledge.
'use strict';

(function datasetsView() {
  const $ = (id) => document.getElementById(id);

  const BADGES = {
    offline: { cls: 'badge-offline', text: 'offline' },
    cached: { cls: 'badge-cached', text: 'cached after first run' },
    hf: { cls: 'badge-hf', text: 'needs subset+split for offline' },
  };

  function badgeEl(network) {
    const b = BADGES[network];
    const span = document.createElement('span');
    if (b) { span.className = `badge ${b.cls}`; span.textContent = b.text; }
    return span;
  }

  function card(d) {
    const el = document.createElement('div');
    el.className = 'dataset-card';

    const head = document.createElement('div');
    head.className = 'dataset-card-head';
    const h = document.createElement('h4');
    h.textContent = d.id;
    head.appendChild(h);
    head.appendChild(badgeEl(d.network));
    el.appendChild(head);

    const note = document.createElement('div');
    note.className = 'dataset-card-note';
    note.textContent = d.note || '';
    el.appendChild(note);

    const list = document.createElement('ul');
    list.className = 'dataset-card-fields';
    (d.fields || []).forEach((f) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = f.label + (f.required === true ? ' *' : '');
      if (f.tip) name.dataset.tip = f.tip;
      const flag = document.createElement('code');
      flag.textContent = f.flag
        + (f.default !== '' && f.default !== false ? ` = ${f.default}` : '');
      li.appendChild(name);
      li.appendChild(flag);
      list.appendChild(li);
    });
    el.appendChild(list);
    return el;
  }

  async function render() {
    let items;
    try { items = await API.getDatasets(); } catch (_) { return; /* offline */ }
    try {
      window.__settings = await API.getSettings();
    } catch (_) { /* keep last known */ }
    const s = window.__settings || {};

    $('offline-mode-toggle').checked = String(s.offline_mode) === '1';
    $('datasets-dir').textContent = s.dataset_dir || '…';

    const catalog = $('dataset-catalog');
    catalog.innerHTML = '';
    items.filter((d) => d.kind === 'builtin').forEach((d) => {
      catalog.appendChild(card(d));
    });

    const files = items.filter((d) => d.kind === 'file');
    const body = $('dataset-files-body');
    body.innerHTML = '';
    files.forEach((d) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = d.id.slice('file:'.length);
      const id = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = d.id;
      id.appendChild(code);
      const runsAs = document.createElement('td');
      runsAs.textContent = 'sharegpt (--dataset-path)';
      tr.appendChild(name);
      tr.appendChild(id);
      tr.appendChild(runsAs);
      body.appendChild(tr);
    });
    $('dataset-files-table').style.display = files.length ? '' : 'none';
    $('dataset-files-empty').style.display = files.length ? 'none' : '';
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

  document.addEventListener('view-changed', (e) => {
    if (e.detail === 'datasets') render();
  });
  render();
})();
