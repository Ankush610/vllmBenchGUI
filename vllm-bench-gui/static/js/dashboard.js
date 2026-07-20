// Dashboard view: 6 ApexCharts (3×2: left = throughput, right = latency),
// results table with select/sort/delete/export, expand modal.
'use strict';

(function dashboard() {
  const $ = (id) => document.getElementById(id);
  const short = (m) => (m.includes('/') ? m.split('/').pop() : m);
  const fmt = (v, d = 1) => (v === null || v === undefined ? '—'
    : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

  let rows = [];                 // /api/dashboard/results
  let selected = new Set();      // run_ids driving the charts
  // Ordered sort priority: [{key, dir}, ...]. First entry is the primary sort,
  // each later entry only breaks ties left by the ones before it — so
  // model → dataset → concurrency groups a sweep the way you'd read it.
  let sortStack = [{ key: 'date', dir: 'desc' }];
  // The starting date sort is a default, not a choice the user made, so the
  // first header click replaces it instead of stacking on top of it.
  let sortPristine = true;
  // Whitespace-separated search terms; a row must match all of them. Purely a
  // table view filter — it never touches `selected`, so hidden rows keep their
  // place on the charts and in export/delete.
  let filterTerms = [];
  let charts = {};               // chartId -> ApexCharts instance
  let chartTypes = {};           // chartId -> 'bar' | 'line'
  let modalChart = null;
  let modalDef = null;

  // Series colors carry the QUANTILE, consistently across every chart:
  // throughput singles = mid blue; p50 = light blue; p99 = dark blue.
  // Same validated one-hue ramp → lightness difference stays readable
  // under every color-vision deficiency (identity is never hue-alone:
  // legend + table view always present).
  const C_MID = '#2a78d6', C_P50 = '#86b6ef', C_P99 = '#1c5cab';

  // Chart definitions. DOM order fills a 2-col grid row by row:
  // row 1 = single-series throughput, row 2 = the two dual-bar (p50/p99)
  // latency charts side by side so their bar layout reads the same,
  // row 3 = total throughput + tail latency.
  const CHART_DEFS = [
    { id: 'out_tok', title: 'Output token throughput', yTitle: 'tok/s', colors: [C_MID],
      series: (rs) => [{ name: 'output tok/s', data: rs.map((r) => num(r.output_tok_per_sec)) }] },
    { id: 'req_s', title: 'Request throughput', yTitle: 'req/s', colors: [C_MID],
      series: (rs) => [{ name: 'req/s', data: rs.map((r) => num(r.req_per_sec)) }] },
    { id: 'ttft', title: 'TTFT p50 / p99', yTitle: 'ms', colors: [C_P50, C_P99],
      series: (rs) => [
        { name: 'TTFT p50', data: rs.map((r) => num(r.ttft_p50_ms)) },
        { name: 'TTFT p99', data: rs.map((r) => num(r.ttft_p99_ms)) },
      ] },
    { id: 'tpot', title: 'TPOT p50 / p99', yTitle: 'ms/token', colors: [C_P50, C_P99],
      series: (rs) => [
        { name: 'TPOT p50', data: rs.map((r) => num(r.tpot_p50_ms)) },
        { name: 'TPOT p99', data: rs.map((r) => num(r.tpot_p99_ms)) },
      ] },
    { id: 'total_tok', title: 'Total token throughput', yTitle: 'tok/s', colors: [C_MID],
      series: (rs) => [{ name: 'total tok/s', data: rs.map((r) => num(r.total_tok_per_sec)) }] },
    { id: 'e2el', title: 'E2EL p99', yTitle: 's', colors: [C_P99],
      series: (rs) => [{ name: 'E2EL p99',
        data: rs.map((r) => (r.e2el_p99_ms == null ? null : +(r.e2el_p99_ms / 1000).toFixed(3))) }] },
  ];

  // compact value-axis labels: 12000 → "12k"
  function compact(v) {
    if (v == null) return '';
    const n = Number(v);
    return Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${+n.toFixed(1)}`;
  }

  function num(v) { return v == null ? null : +Number(v).toFixed(2); }

  function chartRows() {
    // Grouped by model name, then concurrency — a manual sweep reads
    // left-to-right as the saturation curve.
    return rows
      .filter((r) => selected.has(r.run_id))
      .slice()
      .sort((a, b) => (a.model || '').localeCompare(b.model || '')
        || (a.max_concurrency || 0) - (b.max_concurrency || 0));
  }

  function labels(rs) {
    return rs.map((r) => `${short(r.model)} @ c${r.max_concurrency ?? '?'}`);
  }

  // ------------------------------------------------------------- charts
  // Bar mode uses HORIZONTAL bars: run labels sit on the y-axis where any
  // number of them stays readable, and the card grows with the run count.
  // Line mode stays vertical (x = runs) — that's the sweep/saturation view.
  function chartOptions(def, type, rs, big) {
    const horizontal = type === 'bar';
    const nSeries = def.series(rs).length || 1;
    const autoHeight = Math.max(230, rs.length * (nSeries > 1 ? 34 : 22) + 90);
    return {
      chart: {
        type,
        height: big ? '100%' : (horizontal ? autoHeight : 230),
        animations: {
          enabled: true,
          easing: 'easeout',
          speed: 550,
          animateGradually: { enabled: true, delay: 45 },  // bars sweep in one by one
          dynamicAnimation: { enabled: true, speed: 320 }, // smooth data updates
        },
        toolbar: { show: type === 'line' }, // box-zoom / pan / reset
        zoom: { enabled: type === 'line' },
      },
      plotOptions: {
        bar: {
          horizontal,
          barHeight: '62%',            // thin marks; whitespace does the separating
          columnWidth: '55%',
          borderRadius: 4,             // rounded data-end only,
          borderRadiusApplication: 'end', // baseline stays square
        },
      },
      colors: def.colors,
      series: def.series(rs),
      xaxis: horizontal
        ? { categories: labels(rs), title: { text: def.yTitle, style: { fontSize: '11px', fontWeight: 500, color: '#77767f' } },
            labels: { style: { fontSize: '11px', colors: '#77767f' }, formatter: compact },
            axisBorder: { show: false }, axisTicks: { show: false } }
        : { categories: labels(rs),
            labels: { rotate: -35, style: { fontSize: '10px', colors: '#77767f' } },
            axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: horizontal
        ? { labels: { style: { fontSize: '11px', colors: '#46464f' }, maxWidth: 220 } }
        : { title: { text: def.yTitle, style: { fontSize: '11px', fontWeight: 500, color: '#77767f' } },
            labels: { style: { fontSize: '11px', colors: '#77767f' }, formatter: compact } },
      grid: {
        borderColor: '#ececf4',        // recessive hairline grid
        xaxis: { lines: { show: horizontal } },   // value-axis lines only
        yaxis: { lines: { show: !horizontal } },
        padding: { left: 8, right: 12 },
      },
      dataLabels: { enabled: false },
      stroke: type === 'line'
        ? { curve: 'straight', width: 2 }
        : { show: true, width: 2, colors: ['#ffffff'] },  // 2px gap between adjacent bars
      markers: type === 'line' ? { size: 4, hover: { size: 6 } } : {},
      legend: { position: 'top', horizontalAlign: 'right', fontSize: '12px',
                markers: { radius: 4 } },
      tooltip: { shared: type === 'line', intersect: type !== 'line' },
      noData: { text: 'No runs selected',
                style: { color: '#77767f', fontSize: '13px' } },
    };
  }

  function buildChartCards() {
    const grid = $('charts-grid');
    grid.innerHTML = '';
    CHART_DEFS.forEach((def) => {
      chartTypes[def.id] = chartTypes[def.id] || 'bar';
      const card = document.createElement('div');
      card.className = 'chart-card';
      card.innerHTML = `
        <div class="chart-head">
          <span class="chart-title">${def.title}</span>
          <div class="chart-controls">
            <button class="btn btn-small" data-act="toggle" title="Switch bar/line">Bar/Line</button>
            <button class="btn btn-small" data-act="expand" title="Expand">⤢</button>
          </div>
        </div>
        <div class="chart-body" id="chart-${def.id}"></div>`;
      card.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        chartTypes[def.id] = chartTypes[def.id] === 'bar' ? 'line' : 'bar';
        renderChart(def);
      });
      card.querySelector('[data-act="expand"]').addEventListener('click', () => openModal(def));
      grid.appendChild(card);
    });
  }

  function renderChart(def) {
    const el = $(`chart-${def.id}`);
    if (!el) return;
    if (window.__apexMissing) {
      el.innerHTML = '<div class="chart-empty">ApexCharts not available (offline and no vendor file). '
        + 'Place apexcharts.min.js in static/vendor/.</div>';
      return;
    }
    const rs = chartRows();
    if (charts[def.id]) { charts[def.id].destroy(); delete charts[def.id]; }
    charts[def.id] = new ApexCharts(el, chartOptions(def, chartTypes[def.id], rs, false));
    charts[def.id].render();
  }

  function renderAllCharts() {
    CHART_DEFS.forEach(renderChart);
    renderStats();
  }

  // --------------------------------------------------------- KPI tiles
  // Headline numbers for the CURRENT SELECTION — a stat tile says one
  // thing; the charts below carry the comparisons.
  function renderStats() {
    const rs = chartRows();
    const el = $('stats-row');
    const best = (key, dir) => rs.reduce((acc, r) => {
      const v = r[key];
      if (v == null) return acc;
      if (!acc || (dir === 'max' ? v > acc.v : v < acc.v)) return { v, r };
      return acc;
    }, null);

    const peakOut = best('output_tok_per_sec', 'max');
    const peakReq = best('req_per_sec', 'max');
    const bestTtft = best('ttft_p99_ms', 'min');
    const models = new Set(rs.map((r) => r.model)).size;
    const runLabel = (b) => (b ? `${short(b.r.model)} @ c${b.r.max_concurrency ?? '?'}` : 'no runs selected');
    const val = (b, d = 0) => (b ? Number(b.v).toLocaleString(undefined,
      { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '—');

    el.innerHTML = `
      <div class="stat-tile">
        <div class="stat-label">Peak output throughput</div>
        <div class="stat-value">${val(peakOut)}<small> tok/s</small></div>
        <div class="stat-context">${runLabel(peakOut)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Peak request throughput</div>
        <div class="stat-value">${val(peakReq, 2)}<small> req/s</small></div>
        <div class="stat-context">${runLabel(peakReq)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Best TTFT p99</div>
        <div class="stat-value">${val(bestTtft, 1)}<small> ms</small></div>
        <div class="stat-context">${runLabel(bestTtft)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Selection</div>
        <div class="stat-value">${rs.length}<small> run${rs.length === 1 ? '' : 's'}</small></div>
        <div class="stat-context">${models} model${models === 1 ? '' : 's'} · ${rows.length} total completed</div>
      </div>`;
  }

  // -------------------------------------------------------------- modal
  function openModal(def) {
    modalDef = def;
    $('modal-title').textContent = def.title;
    $('chart-modal').classList.remove('hidden');
    renderModalChart();
  }

  function renderModalChart() {
    if (!modalDef || window.__apexMissing) return;
    if (modalChart) { modalChart.destroy(); modalChart = null; }
    modalChart = new ApexCharts($('modal-chart'),
      chartOptions(modalDef, chartTypes[modalDef.id], chartRows(), true));
    modalChart.render();
  }

  function closeModal() {
    $('chart-modal').classList.add('hidden');
    if (modalChart) { modalChart.destroy(); modalChart = null; }
    modalDef = null;
  }

  $('modal-close').addEventListener('click', closeModal);
  $('modal-toggle').addEventListener('click', () => {
    if (!modalDef) return;
    chartTypes[modalDef.id] = chartTypes[modalDef.id] === 'bar' ? 'line' : 'bar';
    renderModalChart();
    renderChart(modalDef); // keep the in-grid copy in sync
  });
  $('chart-modal').addEventListener('click', (e) => {
    if (e.target === $('chart-modal')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalDef) closeModal();
  });

  // -------------------------------------------------------------- table
  // Sortable columns. Text keys return a string: finished_at is ISO-8601, so
  // lexicographic order is chronological order. Concurrency is compared as a
  // number — as text, c100 would sort before c8.
  const SORT_KEYS = {
    model: (r) => r.model || '',
    backend: (r) => r.backend || '',
    dataset: (r) => r.dataset || '',
    concurrency: (r) => r.max_concurrency,
    date: (r) => r.finished_at || '',
  };
  const NUMERIC_SORTS = new Set(['concurrency']);
  // Dates read newest-first by default; names A→Z, sweeps low→high.
  const DEFAULT_DIR = {
    date: 'desc', model: 'asc', backend: 'asc', dataset: 'asc', concurrency: 'asc',
  };

  // Compare one row pair on a single column. Returns the raw comparison
  // (already signed by dir), or 0 when the column can't separate them.
  function compareOn(a, b, mode, dir) {
    const key = SORT_KEYS[mode];
    if (!key) return 0;
    const sign = dir === 'asc' ? 1 : -1;
    if (NUMERIC_SORTS.has(mode)) {
      const av = key(a), bv = key(b);
      const aMissing = av === null || av === undefined;
      const bMissing = bv === null || bv === undefined;
      // Rows with no value sink to the bottom in BOTH directions (ignoring
      // dir on purpose) rather than masquerading as 0.
      if (aMissing || bMissing) {
        if (aMissing && bMissing) return 0;
        return aMissing ? 1 : -1;
      }
      return (av - bv) * sign;
    }
    // numeric:true keeps c2 < c10 inside otherwise-equal model names.
    return key(a).localeCompare(key(b), undefined,
      { numeric: true, sensitivity: 'base' }) * sign;
  }

  function sortedRows() {
    const stack = sortStack.length ? sortStack : [{ key: 'date', dir: 'desc' }];
    return rows.slice().sort((a, b) => {
      for (const { key, dir } of stack) {
        const cmp = compareOn(a, b, key, dir);
        if (cmp !== 0) return cmp;
      }
      // Ties resolve newest-first so grouped rows keep a stable, useful order.
      return (b.finished_at || '').localeCompare(a.finished_at || '');
    });
  }

  // The Label column is a free-text annotation ("baseline", "after tuning").
  // It carries nothing when empty or when it just repeats the model, so the
  // cell is blanked in that case — and the whole column hidden when no row
  // has a meaningful label.
  function labelText(r) {
    const l = (r.label || '').trim();
    if (!l) return '';
    const model = r.model || '';
    return (l === model || l === short(model)) ? '' : l;
  }

  // Matched against the full model path (not the shortened cell text, so
  // "meta-llama" finds a row displayed as "Llama-3.1-8B") plus the label.
  function matchesFilter(r) {
    if (!filterTerms.length) return true;
    const hay = `${r.model || ''} ${r.label || ''}`.toLowerCase();
    return filterTerms.every((t) => hay.includes(t));
  }

  function visibleRows() {
    return sortedRows().filter(matchesFilter);
  }

  function renderTable() {
    const body = $('results-body');
    body.innerHTML = '';
    const rs = visibleRows();
    const showLabel = rs.some((r) => labelText(r));
    $('results-empty').classList.toggle('hidden', rs.length > 0);
    $('results-empty').textContent = filterTerms.length
      ? 'No runs match this filter.'
      : 'No completed runs yet. Queue a benchmark from the Benchmark tab.';
    $('th-label').classList.toggle('hidden', !showLabel);
    rs.forEach((r) => {
      const tr = document.createElement('tr');
      const date = (r.finished_at || '').replace('T', ' ').replace(/\+.*$/, '');
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${r.run_id}" ${selected.has(r.run_id) ? 'checked' : ''}></td>
        <td title="${r.model}" class="cell-model">${short(r.model)}</td>
        <td class="cell-label${showLabel ? '' : ' hidden'}">${escapeHtml(labelText(r))}</td>
        <td><span class="cell-chip">${r.dataset}</span></td>
        <td><span class="cell-chip">${r.backend}</span></td>
        <td class="num">${r.max_concurrency ?? '—'}</td>
        <td class="num">${r.input_len ?? '—'} / ${r.output_len ?? '—'}</td>
        <td class="num">${fmt(r.req_per_sec, 2)}</td>
        <td class="num">${fmt(r.output_tok_per_sec)}</td>
        <td class="num">${fmt(r.ttft_p50_ms)} / ${fmt(r.ttft_p99_ms)}</td>
        <td class="num">${fmt(r.tpot_p50_ms)} / ${fmt(r.tpot_p99_ms)}</td>
        <td class="num">${fmt(r.e2el_p99_ms)}</td>
        <td class="cell-date">${date}</td>
        <td><button class="row-del" data-id="${r.run_id}" title="Delete run">🗑</button></td>`;
      tr.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
        if (e.target.checked) selected.add(r.run_id); else selected.delete(r.run_id);
        syncSelectAll();
        renderAllCharts();
      });
      tr.querySelector('.row-del').addEventListener('click', () => deleteRuns([r.run_id]));
      body.appendChild(tr);
    });
    syncSelectAll();
    syncSortIndicators();
    syncFilterCount();
  }

  // Arrow direction lives in data-dir; theme.css renders it via ::after.
  // data-rank carries the 1-based priority, shown only when more than one
  // column is active (a lone "1" would be noise).
  function syncSortIndicators() {
    const multi = sortStack.length > 1;
    document.querySelectorAll('#results-table th.sortable').forEach((th) => {
      const idx = sortStack.findIndex((s) => s.key === th.dataset.sort);
      const active = idx !== -1;
      th.classList.toggle('sorted', active);
      if (active) {
        th.dataset.dir = sortStack[idx].dir;
        if (multi) th.dataset.rank = String(idx + 1); else delete th.dataset.rank;
      } else {
        delete th.dataset.dir;
        delete th.dataset.rank;
      }
      th.setAttribute('aria-sort', active
        ? (sortStack[idx].dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    $('sort-reset').classList.toggle('hidden', sortPristine);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Scoped to the visible rows: with a filter active, the header checkbox
  // reflects and toggles only what you can see.
  function syncSelectAll() {
    const box = $('select-all');
    const rs = visibleRows();
    box.checked = rs.length > 0 && rs.every((r) => selected.has(r.run_id));
    box.indeterminate = !box.checked && rs.some((r) => selected.has(r.run_id));
  }

  $('select-all').addEventListener('change', (e) => {
    const rs = visibleRows();
    if (e.target.checked) rs.forEach((r) => selected.add(r.run_id));
    else rs.forEach((r) => selected.delete(r.run_id));
    renderTable();
    renderAllCharts();
  });

  // "12 of 40" tells you rows are hidden — the charts and Export/Delete still
  // act on the selection, which can include those hidden rows.
  function syncFilterCount() {
    const el = $('filter-count');
    const active = filterTerms.length > 0;
    el.classList.toggle('hidden', !active);
    if (active) el.textContent = `${visibleRows().length} of ${rows.length}`;
  }

  $('model-filter').addEventListener('input', (e) => {
    filterTerms = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    renderTable();
  });

  // Each header cycles through three states: off → default direction →
  // flipped → off. Columns accumulate in click order, so clicking Model then
  // Dataset then Conc. sorts by model, and within each model by dataset, and
  // within each of those by concurrency — no column is ever applied twice.
  document.querySelectorAll('#results-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!SORT_KEYS[key]) return;
      if (sortPristine) { sortStack = []; sortPristine = false; }
      const idx = sortStack.findIndex((s) => s.key === key);
      if (idx === -1) {
        sortStack.push({ key, dir: DEFAULT_DIR[key] || 'asc' });
      } else if (sortStack[idx].dir === (DEFAULT_DIR[key] || 'asc')) {
        sortStack[idx].dir = sortStack[idx].dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortStack.splice(idx, 1); // third click drops it out of the ordering
      }
      renderTable();
    });
  });

  // Back to the default single sort (newest run first).
  $('sort-reset').addEventListener('click', () => {
    sortStack = [{ key: 'date', dir: 'desc' }];
    sortPristine = true;
    renderTable();
  });

  async function deleteRuns(ids) {
    if (!ids.length) return;
    const msg = ids.length === 1
      ? 'Delete this run? Its result JSON and logs are removed too.'
      : `Delete ${ids.length} selected runs? Their result JSONs and logs are removed too.`;
    if (!confirm(msg)) return;
    for (const id of ids) {
      try { await API.deleteRun(id); selected.delete(id); } catch (e) {
        alert(`Delete failed for ${id}: ${e.message}`);
      }
    }
    await refresh(true);
  }

  $('btn-delete-selected').addEventListener('click', () =>
    deleteRuns(rows.filter((r) => selected.has(r.run_id)).map((r) => r.run_id)));

  $('btn-export').addEventListener('click', () => {
    const ids = rows.filter((r) => selected.has(r.run_id)).map((r) => r.run_id);
    if (!ids.length) { alert('Select at least one run to export.'); return; }
    window.location.href = API.exportUrl(ids);
  });

  // ------------------------------------------------------------ refresh
  async function refresh(force) {
    let fresh;
    try { fresh = await API.getResults(); } catch (_) { return; }
    const changed = force
      || fresh.length !== rows.length
      || fresh.some((r, i) => !rows[i] || rows[i].run_id !== r.run_id);
    // New runs start selected so they appear on the charts immediately.
    const known = new Set(rows.map((r) => r.run_id));
    fresh.forEach((r) => { if (!known.has(r.run_id)) selected.add(r.run_id); });
    rows = fresh;
    if (changed) {
      renderTable();
      renderAllCharts();
    }
  }

  function isDashboardVisible() {
    return $('view-dashboard').classList.contains('active');
  }

  document.addEventListener('view-changed', (e) => {
    if (e.detail === 'dashboard') refresh(true);
  });
  setInterval(() => { if (isDashboardVisible()) refresh(false); }, 5000);

  buildChartCards();
  refresh(true);
})();
