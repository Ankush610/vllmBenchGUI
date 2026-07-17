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
  let sortMode = 'date';         // 'date' | 'model'
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
  function sortedRows() {
    const rs = rows.slice();
    if (sortMode === 'model') {
      rs.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
    } else {
      rs.sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''));
    }
    return rs;
  }

  function renderTable() {
    const body = $('results-body');
    body.innerHTML = '';
    const rs = sortedRows();
    $('results-empty').classList.toggle('hidden', rs.length > 0);
    rs.forEach((r) => {
      const tr = document.createElement('tr');
      const date = (r.finished_at || '').replace('T', ' ').replace(/\+.*$/, '');
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${r.run_id}" ${selected.has(r.run_id) ? 'checked' : ''}></td>
        <td title="${r.model}" class="cell-model">${short(r.model)}</td>
        <td>${escapeHtml(r.label || '')}</td>
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
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function syncSelectAll() {
    const box = $('select-all');
    box.checked = rows.length > 0 && rows.every((r) => selected.has(r.run_id));
    box.indeterminate = !box.checked && rows.some((r) => selected.has(r.run_id));
  }

  $('select-all').addEventListener('change', (e) => {
    if (e.target.checked) rows.forEach((r) => selected.add(r.run_id));
    else selected.clear();
    renderTable();
    renderAllCharts();
  });

  document.querySelectorAll('#results-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      sortMode = th.dataset.sort === 'model' ? 'model' : 'date';
      renderTable();
    });
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
