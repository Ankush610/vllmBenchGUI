// Thin fetch wrappers. All endpoints are same-origin under /api.
'use strict';

const API = {
  async _json(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body.detail === 'string'
          ? body.detail
          : JSON.stringify(body.detail || body);
      } catch (_) { /* non-JSON error body */ }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  getSettings: () => API._json('/api/settings'),
  putSettings: (body) => API._json('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),

  getModels: () => API._json('/api/models'),
  getDatasets: () => API._json('/api/datasets'),

  queueRuns: (runs) => API._json('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runs }),
  }),
  getRuns: () => API._json('/api/runs'),
  cancelRun: (id) => API._json(`/api/runs/${id}/cancel`, { method: 'POST' }),
  cancelAll: () => API._json('/api/runs/cancel-all', { method: 'POST' }),
  deleteRun: (id) => API._json(`/api/runs/${id}`, { method: 'DELETE' }),
  tailLogs: (id, file, offset) =>
    API._json(`/api/runs/${id}/logs?file=${encodeURIComponent(file)}&offset=${offset}`),

  getStatus: () => API._json('/api/status'),
  getResults: () => API._json('/api/dashboard/results'),
  exportUrl: (ids) => `/api/dashboard/export?ids=${ids.join(',')}`,
};

// ---------------------------------------------------------- view switching
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    document.dispatchEvent(new CustomEvent('view-changed', { detail: btn.dataset.view }));
  });
});

// --------------------------------------------------------------- tooltips
// One shared tooltip element; any node with data-tip shows it on hover.
(function tooltips() {
  const tip = document.getElementById('tooltip');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    tip.textContent = el.dataset.tip;
    tip.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    tip.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
    tip.style.top = (r.bottom + 6) + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) tip.classList.add('hidden');
  });
})();
