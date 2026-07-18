// Benchmark view: run tabs, param grid + validation, submit/cancel,
// status chip, footer indicators, log tail.
//
// The frontend holds zero authoritative state: queue/status/logs live in the
// backend. The only client state — unsubmitted draft tabs — is mirrored to
// localStorage on every change so drafts survive a refresh.
'use strict';

(function benchmark() {
  const DRAFTS_KEY = 'vbench_drafts_v1';
  const ACTIVE_STATUSES = ['downloading', 'starting_server', 'running_benchmark'];

  // ------------------------------------------------------------ param defs
  const DEFAULT_PARAMS = {
    model: '',
    tensor_parallel_size: 1,
    gpu_memory_utilization: 0.90,
    max_model_len: '',
    port: '',
    extra_server_args: '',
    backend: 'vllm',
    dataset: 'random',
    num_prompts: 1000,
    max_concurrency: 200,
    request_rate: 'inf',
    ignore_eos: true,
    seed: 0,
    dataset_params: {},   // per-dataset params, filled from the schema
  };

  const SERVER_FIELDS = [
    { key: 'model', label: 'Model', type: 'model',
      placeholder: 'Qwen/Qwen2.5-7B-Instruct', wide: true,
      tip: 'Pick a local model or type any HF repo ID; missing models auto-download before the run.' },
    { key: 'tensor_parallel_size', label: 'Tensor parallel size', type: 'select',
      options: [1, 2, 4, 8],
      tip: 'Number of GPUs the model is sharded across; must be ≤ GPUs on this node.' },
    { key: 'gpu_memory_utilization', label: 'GPU memory utilization', type: 'number',
      step: '0.01', placeholder: '0.90',
      tip: "Fraction of each GPU's VRAM vLLM may reserve for weights + KV cache." },
    { key: 'max_model_len', label: 'Max model len', type: 'number',
      placeholder: '8192',
      tip: "Max context length; leave empty for the model's native limit; lower it on KV-cache OOM." },
    { key: 'port', label: 'Port', type: 'number', placeholder: '8000',
      tip: 'Server port; auto-assigns the next free port if empty (local mode).' },
    { key: 'extra_server_args', label: 'Extra server args (advanced)', type: 'text',
      placeholder: '--enable-prefix-caching', wide: true,
      tip: 'Raw flags appended to `vllm serve` as-is. Shell metacharacters are rejected.' },
  ];

  const BENCH_FIELDS = [
    { key: 'backend', label: 'Backend', type: 'select',
      options: ['vllm', 'openai-chat'],
      tip: 'vllm = /v1/completions (raw throughput); openai-chat = /v1/chat/completions (realistic chat serving).' },
    { key: 'dataset', label: 'Dataset', type: 'dataset',
      tip: 'Pick a dataset; its own options appear below. The badge shows what it needs from the network — see the Datasets tab for details.' },
    { key: 'num_prompts', label: 'Num prompts', type: 'number', placeholder: '1000',
      tip: 'Total requests in this run; more = tighter percentiles, longer runtime.' },
    { key: 'max_concurrency', label: 'Max concurrency', type: 'number', placeholder: '200',
      tip: 'Max requests in flight; the main knob for saturating the server.' },
    { key: 'request_rate', label: 'Request rate', type: 'text', placeholder: 'inf',
      tip: "Requests/sec arrival rate; 'inf' = closed loop bounded only by concurrency." },
    { key: 'seed', label: 'Seed', type: 'number', placeholder: '0',
      tip: 'Same seed + params = same prompts, reproducible runs.' },
    { key: 'ignore_eos', label: 'Ignore EOS', type: 'toggle',
      tip: 'Force full output length even if the model wants to stop early; keeps token counts exact.' },
  ];

  // ----------------------------------------------------- dataset schema
  // Full specs (fields, network badge, notes) come from GET /api/datasets;
  // this seed only keeps the dropdown alive before hydrate() lands.
  let datasetsCache = [{ id: 'random' }, { id: 'sharegpt' }, { id: 'sonnet' }];
  const FILE_SPEC_ID = '__file__';

  const BADGES = {
    offline: { cls: 'badge-offline', text: 'offline' },
    cached: { cls: 'badge-cached', text: 'cached after first run' },
    hf: { cls: 'badge-hf', text: 'needs subset+split for offline' },
  };

  function dsSpec(id) {
    return datasetsCache.find((d) => d.id === id)
      || (String(id).startsWith('file:')
        ? datasetsCache.find((d) => d.kind === 'file') : null)
      || null;
  }

  function dsFields(id) {
    const spec = dsSpec(id);
    return (spec && spec.fields) || [];
  }

  function defaultDatasetParams(id) {
    const dp = {};
    dsFields(id).forEach((f) => { dp[f.key] = f.default; });
    return dp;
  }

  function isOffline() {
    return !!(window.__settings && String(window.__settings.offline_mode) === '1');
  }

  // Rehydrate a pre-schema config (flat input_len/output_len/prefix) into
  // dataset_params — the JS twin of dataset_schema.legacy_to_params.
  function legacyToParams(bench) {
    const ds = bench.dataset || 'random';
    const dp = defaultDatasetParams(ds);
    const inLen = bench.input_len, outLen = bench.output_len;
    if (ds === 'random') {
      if (inLen != null && inLen !== '') dp.random_input_len = inLen;
      if (outLen != null && outLen !== '') dp.random_output_len = outLen;
    } else if (ds === 'sonnet') {
      if (inLen != null && inLen !== '') dp.sonnet_input_len = inLen;
      if (outLen != null && outLen !== '') dp.sonnet_output_len = outLen;
      if (bench.sonnet_prefix_len != null && bench.sonnet_prefix_len !== '') {
        dp.sonnet_prefix_len = bench.sonnet_prefix_len;
      }
    } else if (ds === 'sharegpt' || ds.startsWith('file:')) {
      if (outLen != null && outLen !== '') dp.sharegpt_output_len = outLen;
    }
    return dp;
  }

  // ------------------------------------------------------------ validation
  const intIn = (v, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi;
  };

  // Mirrors dataset_schema.validate_params (backend parity).
  function validateDatasetParams(dsId, dp) {
    const errors = {};
    dp = dp || {};
    dsFields(dsId).forEach((f) => {
      const v = dp[f.key];
      const unset = v == null || v === '';
      if (unset) {
        if (f.required === true) errors[f.key] = 'required';
        else if (f.required === 'offline' && isOffline()) {
          errors[f.key] = 'required in offline mode';
        }
        return;
      }
      if (f.type === 'int' || f.type === 'float') {
        const n = Number(v);
        if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) {
          errors[f.key] = f.type === 'int' ? 'must be a whole number' : 'must be a number';
          return;
        }
        const below = f.min != null && (f.min_exclusive ? n <= f.min : n < f.min);
        if (below || (f.max != null && n > f.max)) {
          errors[f.key] = `must be between ${f.min_exclusive ? '(exclusive) ' : ''}${f.min} and ${f.max}`;
        }
      } else if (f.type === 'select') {
        if (!f.options.map(String).includes(String(v))) errors[f.key] = 'invalid choice';
      } else if (f.type === 'hf_repo') {
        if (!/^[\w.\-]+\/[\w.\-]+$/.test(String(v).trim())) {
          errors[f.key] = 'must look like org/name (HF repo id)';
        }
      } else if (f.type === 'str' || f.type === 'path') {
        if (/[;&|`\n]|\$\(/.test(String(v))) {
          errors[f.key] = 'shell metacharacters ; & | ` $( not allowed';
        }
      }
    });
    return errors;
  }

  function validateParams(p) {
    const errors = {};
    if (!/^[\w.\-]+\/[\w.\-]+$/.test(p.model.trim())) {
      errors.model = 'required, must look like org/name';
    }
    if (![1, 2, 4, 8].includes(Number(p.tensor_parallel_size))) {
      errors.tensor_parallel_size = 'must be 1, 2, 4 or 8';
    }
    const gmu = Number(p.gpu_memory_utilization);
    if (!(gmu >= 0.1 && gmu <= 0.99)) {
      errors.gpu_memory_utilization = 'must be between 0.1 and 0.99';
    }
    if (p.max_model_len !== '' && !intIn(p.max_model_len, 256, 10_000_000)) {
      errors.max_model_len = 'must be an integer ≥ 256, or empty';
    }
    if (p.port !== '' && !intIn(p.port, 1024, 65535)) {
      errors.port = 'must be 1024–65535, or empty for auto';
    }
    if (/[;&|`\n]|\$\(/.test(p.extra_server_args)) {
      errors.extra_server_args = 'shell metacharacters ; & | ` $( not allowed';
    }
    if (!intIn(p.num_prompts, 1, 1_000_000)) errors.num_prompts = 'must be 1–1000000';
    if (!intIn(p.max_concurrency, 1, 1_000_000)) errors.max_concurrency = 'must be ≥ 1';
    const rr = String(p.request_rate).trim();
    if (rr !== 'inf' && !(Number(rr) > 0)) {
      errors.request_rate = "positive number or 'inf'";
    }
    if (!intIn(p.seed, 0, 4_000_000_000)) errors.seed = 'must be an integer ≥ 0';
    Object.assign(errors, validateDatasetParams(p.dataset, p.dataset_params));
    return errors;
  }

  // ---------------------------------------------------------------- state
  let tabs = [];            // {tid, name, label, params, runId}
  let activeTid = null;
  let runsById = {};        // from GET /api/runs
  let modelsCache = [];
  // `raw` keeps the bytes as received; the panel renders a \r-collapsed view.
  // `phase` is the user's pick: 'auto' follows the running phase, anything else
  // pins the panel to that one log file.
  let logFollow = { runId: null, file: null, offset: 0, raw: '', phase: 'auto' };
  let tabErrors = {};       // tid -> {field: msg} (drafts only)

  const $ = (id) => document.getElementById(id);
  const uid = () => 't' + Math.random().toString(36).slice(2, 10);

  const activeTab = () => tabs.find((t) => t.tid === activeTid) || null;
  const draftTabs = () => tabs.filter((t) => !t.runId);
  const runOf = (tab) => (tab && tab.runId ? runsById[tab.runId] : null);
  const isLocked = (tab) => {
    const run = runOf(tab);
    return !!run && ACTIVE_STATUSES.includes(run.status);
  };

  function shortName(model) {
    return model.includes('/') ? model.split('/').pop() : model;
  }

  function dedupedName(base, exceptTid) {
    const taken = new Set(tabs.filter((t) => t.tid !== exceptTid).map((t) => t.name));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i += 1;
    return `${base}-${i}`;
  }

  function saveDrafts() {
    const drafts = draftTabs().map(({ tid, name, label, params }) =>
      ({ tid, name, label, params }));
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({ drafts, activeTid }));
  }

  // ----------------------------------------------------------- tab strip
  function renderTabs() {
    const strip = $('run-tabs');
    strip.innerHTML = '';
    tabs.forEach((tab) => {
      const el = document.createElement('div');
      el.className = 'run-tab' + (tab.tid === activeTid ? ' active' : '')
        + (isLocked(tab) ? ' locked' : '');
      const label = document.createElement('span');
      label.textContent = tab.name || 'New';
      el.appendChild(label);
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.tid); });
      el.appendChild(close);
      el.addEventListener('click', () => selectTab(tab.tid));
      strip.appendChild(el);
    });
    const add = document.createElement('button');
    add.className = 'tab-add';
    add.textContent = '+';
    add.title = 'New run (clones current params)';
    add.addEventListener('click', addTab);
    strip.appendChild(add);
  }

  function addTab() {
    const src = activeTab();
    const params = src ? JSON.parse(JSON.stringify(src.params))
      : freshParams();
    const tab = {
      tid: uid(),
      name: dedupedName(params.model ? shortName(params.model) : 'New', null),
      label: src ? src.label : '',
      params,
      runId: null,
    };
    tabs.push(tab);
    selectTab(tab.tid);
    saveDrafts();
  }

  function closeTab(tid) {
    const tab = tabs.find((t) => t.tid === tid);
    if (!tab || isLocked(tab)) return;
    const run = runOf(tab);
    if (run && run.status === 'queued') {
      API.cancelRun(run.id).catch(() => {});
    }
    tabs = tabs.filter((t) => t.tid !== tid);
    delete tabErrors[tid];
    if (!tabs.length) tabs.push(freshTab());
    if (activeTid === tid) activeTid = tabs[tabs.length - 1].tid;
    renderTabs();
    renderParams();
    saveDrafts();
  }

  // DEFAULT_PARAMS.dataset_params is a shared object — every tab needs its own.
  function freshParams() {
    return { ...DEFAULT_PARAMS, dataset_params: defaultDatasetParams('random') };
  }

  function freshTab() {
    return { tid: uid(), name: 'New', label: '', params: freshParams(), runId: null };
  }

  function selectTab(tid) {
    activeTid = tid;
    renderTabs();
    renderParams();
    updateChip();
    retargetLogs();
    saveDrafts();
  }

  // ---------------------------------------------------------- param grid
  function renderParams() {
    const tab = activeTab();
    if (!tab) return;
    buildGrid($('server-params'), SERVER_FIELDS, tab);
    buildGrid($('bench-params'), BENCH_FIELDS, tab);
    buildDatasetGrid(tab);
    $('run-label').value = tab.label || '';
    $('run-label').disabled = !!tab.runId;
    showErrors(tab);
  }

  function buildGrid(grid, fields, tab) {
    grid.innerHTML = '';
    const locked = !!tab.runId; // submitted tabs are read-only
    fields.forEach((f) => {
      const cell = document.createElement('div');
      cell.className = 'param-cell' + (f.wide ? ' param-cell-wide' : '');
      cell.dataset.field = f.key;

      const label = document.createElement('label');
      label.textContent = f.label + ' ';
      const info = document.createElement('span');
      info.className = 'info';
      info.textContent = 'i';
      info.dataset.tip = f.tip;
      label.appendChild(info);
      cell.appendChild(label);

      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach((o) => {
          const opt = document.createElement('option');
          opt.value = String(o);
          opt.textContent = String(o);
          input.appendChild(opt);
        });
        input.value = String(tab.params[f.key]);
      } else if (f.type === 'dataset') {
        input = document.createElement('select');
        datasetsCache.forEach((d) => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.id + (d.note ? ` — ${d.note}` : '');
          input.appendChild(opt);
        });
        if (![...input.options].some((o) => o.value === tab.params.dataset)) {
          tab.params.dataset = 'random';
          tab.params.dataset_params = defaultDatasetParams('random');
        }
        input.value = tab.params.dataset;
      } else if (f.type === 'toggle') {
        const row = document.createElement('div');
        row.className = 'toggle-row';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!tab.params[f.key];
        row.appendChild(input);
        const txt = document.createElement('span');
        txt.textContent = tab.params[f.key] ? 'on' : 'off';
        row.appendChild(txt);
        input.addEventListener('change', () => { txt.textContent = input.checked ? 'on' : 'off'; });
        cell.appendChild(row);
      } else if (f.type === 'model') {
        input = buildModelInput(cell, tab);
      } else {
        input = document.createElement('input');
        input.type = 'text';
        if (f.type === 'number' && f.step) input.inputMode = 'decimal';
        input.placeholder = f.placeholder || '';
        input.value = tab.params[f.key] === null ? '' : String(tab.params[f.key]);
      }

      if (f.type !== 'toggle' && f.type !== 'model') cell.appendChild(input);
      input.disabled = locked;

      if (f.type === 'dataset') {
        const badge = document.createElement('span');
        badge.id = 'dataset-badge';
        badge.style.marginTop = '2px';
        cell.appendChild(badge);
        setDatasetBadge(badge, tab.params.dataset);
      }

      const err = document.createElement('div');
      err.className = 'param-error';
      cell.appendChild(err);

      const commit = () => {
        tab.params[f.key] = f.type === 'toggle' ? input.checked : input.value.trim();
        if (f.key === 'model') onModelChanged(tab);
        if (f.key === 'dataset') {
          // Switching datasets resets its options to that dataset's defaults.
          tab.params.dataset_params = defaultDatasetParams(tab.params.dataset);
          updateDatasetBadge(tab);
          buildDatasetGrid(tab);
        }
        validateTab(tab);
        showErrors(tab);
        saveDrafts();
        updateSubmitState();
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      grid.appendChild(cell);
    });
  }

  // Searchable model dropdown: free text + suggestion list with badges.
  function buildModelInput(cell, tab) {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Qwen/Qwen2.5-7B-Instruct';
    input.value = tab.params.model;
    input.autocomplete = 'off';
    cell.appendChild(input);

    const badge = document.createElement('span');
    badge.style.marginTop = '2px';
    cell.appendChild(badge);
    const refreshBadge = () => {
      const v = input.value.trim();
      if (!v) { badge.textContent = ''; badge.className = ''; return; }
      const local = modelsCache.some((m) => m.repo_id.toLowerCase() === v.toLowerCase());
      badge.className = 'badge ' + (local ? 'badge-local' : 'badge-download');
      badge.textContent = local ? 'local' : 'will download';
    };
    refreshBadge();

    let list = null;
    const closeList = () => { if (list) { list.remove(); list = null; } };
    const openList = () => {
      closeList();
      const q = input.value.trim().toLowerCase();
      const matches = modelsCache.filter((m) => m.repo_id.toLowerCase().includes(q));
      if (!matches.length) return;
      list = document.createElement('div');
      list.className = 'dropdown-list';
      matches.slice(0, 30).forEach((m) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.innerHTML = `<span>${m.repo_id}</span><span class="badge badge-local">local</span>`;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = m.repo_id;
          closeList();
          input.dispatchEvent(new Event('change'));
          refreshBadge();
        });
        list.appendChild(item);
      });
      cell.appendChild(list);
    };

    input.addEventListener('focus', async () => {
      try { modelsCache = await API.getModels(); } catch (_) { /* keep stale */ }
      openList();
      refreshBadge();
    });
    input.addEventListener('input', () => { openList(); refreshBadge(); });
    input.addEventListener('blur', () => setTimeout(closeList, 120));
    return input;
  }

  function onModelChanged(tab) {
    if (tab.params.model) {
      tab.name = dedupedName(shortName(tab.params.model), tab.tid);
      renderTabs();
    }
  }

  function setDatasetBadge(el, dsId) {
    const spec = dsSpec(dsId);
    const badge = spec && BADGES[spec.network];
    el.className = badge ? `badge ${badge.cls}` : '';
    el.textContent = badge ? badge.text : '';
  }

  function updateDatasetBadge(tab) {
    const el = $('dataset-badge');
    if (el) setDatasetBadge(el, tab.params.dataset);
  }

  // Per-dataset sub-fields, rendered straight from the schema served by
  // GET /api/datasets. Rebuilt whenever the dataset (or settings) changes.
  function buildDatasetGrid(tab) {
    const grid = $('dataset-params');
    grid.innerHTML = '';
    const locked = !!tab.runId;
    const fields = dsFields(tab.params.dataset);
    $('dataset-params-title').style.display = fields.length ? '' : 'none';
    if (!tab.params.dataset_params) tab.params.dataset_params = {};
    const dp = tab.params.dataset_params;

    fields.forEach((f) => {
      const cell = document.createElement('div');
      cell.className = 'param-cell' + (f.type === 'path' || f.type === 'hf_repo'
        ? ' param-cell-wide' : '');
      cell.dataset.field = f.key;

      const label = document.createElement('label');
      label.textContent = f.label + ' ';
      if (f.tip) {
        const info = document.createElement('span');
        info.className = 'info';
        info.textContent = 'i';
        info.dataset.tip = f.tip;
        label.appendChild(info);
      }
      cell.appendChild(label);

      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach((o) => {
          const opt = document.createElement('option');
          opt.value = String(o);
          opt.textContent = o === '' ? '(default)' : String(o);
          input.appendChild(opt);
        });
        input.value = dp[f.key] == null ? '' : String(dp[f.key]);
        cell.appendChild(input);
      } else if (f.type === 'bool') {
        const row = document.createElement('div');
        row.className = 'toggle-row';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!dp[f.key];
        row.appendChild(input);
        const txt = document.createElement('span');
        txt.textContent = dp[f.key] ? 'on' : 'off';
        row.appendChild(txt);
        input.addEventListener('change', () => { txt.textContent = input.checked ? 'on' : 'off'; });
        cell.appendChild(row);
      } else {
        input = document.createElement('input');
        input.type = 'text';
        if (f.type === 'int' || f.type === 'float') input.inputMode = 'decimal';
        input.placeholder = f.placeholder
          || (f.default !== '' && f.default !== false ? String(f.default) : '');
        input.value = dp[f.key] == null ? '' : String(dp[f.key]);
        cell.appendChild(input);
      }
      input.disabled = locked;

      const err = document.createElement('div');
      err.className = 'param-error';
      cell.appendChild(err);

      // Non-blocking offline hint (sharegpt/speed-bench dataset path).
      const warn = document.createElement('div');
      warn.className = 'param-warn';
      cell.appendChild(warn);

      const refreshWarn = () => {
        warn.textContent = (f.offline_nudge && isOffline()
          && (dp[f.key] == null || dp[f.key] === ''))
          ? 'Offline mode: set a local dataset path unless the download cache is already warm.'
          : '';
      };
      refreshWarn();

      const commit = () => {
        dp[f.key] = f.type === 'bool' ? input.checked : input.value.trim();
        refreshWarn();
        validateTab(tab);
        showErrors(tab);
        saveDrafts();
        updateSubmitState();
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      grid.appendChild(cell);
    });
  }

  function validateTab(tab) {
    if (tab.runId) { delete tabErrors[tab.tid]; return {}; }
    const errors = validateParams(tab.params);
    tabErrors[tab.tid] = errors;
    return errors;
  }

  function showErrors(tab) {
    const errors = tabErrors[tab.tid] || {};
    document.querySelectorAll('.param-cell').forEach((cell) => {
      const key = cell.dataset.field;
      if (!key) return;
      const msg = errors[key] || '';
      cell.classList.toggle('invalid', !!msg);
      const err = cell.querySelector('.param-error');
      if (err) err.textContent = msg;
    });
  }

  function updateSubmitState() {
    const drafts = draftTabs();
    const anyInvalid = drafts.some(
      (t) => Object.keys(tabErrors[t.tid] ?? validateTab(t)).length > 0);
    $('btn-submit').disabled = drafts.length === 0 || anyInvalid;
  }

  // ------------------------------------------------------- submit/cancel
  // Coerce dataset params by their spec type; empty optionals are dropped.
  function cleanDatasetParams(params) {
    const out = {};
    const dp = params.dataset_params || {};
    dsFields(params.dataset).forEach((f) => {
      const v = dp[f.key];
      if (f.type === 'bool') { out[f.key] = !!v; return; }
      if (v == null || String(v).trim() === '') return;
      out[f.key] = (f.type === 'int' || f.type === 'float')
        ? Number(v) : String(v).trim();
    });
    return out;
  }

  async function submit() {
    const drafts = draftTabs();
    for (const t of drafts) {
      if (Object.keys(validateTab(t)).length) {
        selectTab(t.tid);
        showErrors(t);
        return;
      }
    }
    const payload = drafts.map((t) => ({
      name: t.name === 'New' ? '' : t.name,
      label: t.label || '',
      server: {
        model: t.params.model.trim(),
        tensor_parallel_size: Number(t.params.tensor_parallel_size),
        gpu_memory_utilization: Number(t.params.gpu_memory_utilization),
        max_model_len: t.params.max_model_len === '' ? null : Number(t.params.max_model_len),
        port: t.params.port === '' ? null : Number(t.params.port),
        extra_server_args: t.params.extra_server_args || '',
      },
      bench: {
        backend: t.params.backend,
        dataset: t.params.dataset,
        num_prompts: Number(t.params.num_prompts),
        max_concurrency: Number(t.params.max_concurrency),
        request_rate: String(t.params.request_rate).trim(),
        ignore_eos: !!t.params.ignore_eos,
        seed: Number(t.params.seed),
        dataset_params: cleanDatasetParams(t.params),
      },
    }));
    try {
      const res = await API.queueRuns(payload);
      res.ids.forEach((id, i) => { drafts[i].runId = id; });
      saveDrafts(); // drafts became runs → drop them from localStorage
      renderTabs();
      renderParams();
      await pollStatuses();
    } catch (e) {
      alert('Submit failed: ' + e.message);
    }
  }

  async function cancelActive() {
    const status = await API.getStatus().catch(() => null);
    const runId = status && status.active_run_id;
    if (!runId) { alert('No active run to cancel.'); return; }
    if (!confirm('Cancel the active run? The vLLM server and benchmark will be shut down.')) return;
    try { await API.cancelRun(runId); } catch (e) { alert('Cancel failed: ' + e.message); }
    pollStatuses();
  }

  async function cancelAll() {
    if (!confirm('Cancel the active run AND clear all queued runs?')) return;
    try { await API.cancelAll(); } catch (e) { alert('Cancel-all failed: ' + e.message); }
    $('cancel-menu').classList.add('hidden');
    pollStatuses();
  }

  // ------------------------------------------------------ status polling
  const CHIP_TEXT = {
    queued: 'queued', downloading: 'downloading model',
    starting_server: 'starting vLLM server', running_benchmark: 'running benchmark',
    completed: 'completed', failed: 'failed', cancelled: 'cancelled',
  };

  function updateChip() {
    const chip = $('status-chip');
    const run = runOf(activeTab());
    if (!run) {
      chip.className = 'status-chip status-none';
      chip.textContent = 'draft';
      chip.title = 'This tab has not been submitted yet';
      return;
    }
    chip.className = 'status-chip status-' + run.status;
    chip.textContent = CHIP_TEXT[run.status] || run.status;
    chip.title = (run.status_detail || '') + ' — click to follow this run’s logs';
  }

  async function pollStatuses() {
    let runs;
    try { runs = await API.getRuns(); } catch (_) { return; }
    runsById = {};
    runs.forEach((r) => { runsById[r.id] = r; });
    renderTabs();
    updateChip();
    updateSubmitState();

    let status;
    try { status = await API.getStatus(); } catch (_) { return; }
    const dot = $('server-dot');
    const text = $('server-status');
    if (status.execution_mode === 'slurm' && status.active_run) {
      const r = status.active_run;
      dot.className = 'dot ' + (r.status === 'running_benchmark' ? 'dot-green' : 'dot-amber');
      text.textContent = r.slurm_job_id
        ? `Job ${r.slurm_job_id} ${r.status === 'starting_server' ? 'pending' : 'running'}`
        : 'Submitting job…';
    } else if (status.server) {
      dot.className = 'dot dot-green';
      text.textContent = `Serving ${status.server.model} on :${status.server.port}`;
    } else if (status.active_run && status.active_run.status === 'starting_server') {
      dot.className = 'dot dot-amber';
      text.textContent = 'Starting…';
    } else {
      dot.className = 'dot dot-gray';
      text.textContent = 'Idle';
    }

    if (!logFollow.runId && status.active_run_id) retargetLogs();
  }

  // ----------------------------------------------------------- log tail
  const PHASE_HEADERS = {
    download: '=== DOWNLOAD ===', server: '=== VLLM SERVER ===',
    bench: '=== BENCHMARK ===', slurm: '=== SLURM JOB ===',
  };

  function followTarget() {
    const tab = activeTab();
    const run = runOf(tab);
    if (run) return run.id;
    return null; // fall back to globally active run in pollLogs
  }

  // `hf download` and vLLM redraw progress with carriage returns. Appending the
  // bytes verbatim would pile every redraw onto one endless line, so apply
  // terminal semantics: within a line, text after the last \r wins.
  function collapseCarriageReturns(text) {
    return text.split('\n').map(line => {
      const i = line.lastIndexOf('\r');
      return i === -1 ? line : line.slice(i + 1);
    }).join('\n');
  }

  // Re-render from the raw buffer: a \r redraw can span two polled chunks, so
  // collapsing per-chunk would strip the wrong states.
  function renderLogs() {
    const panel = $('logs-panel');
    panel.textContent = collapseCarriageReturns(logFollow.raw || '');
    if ($('stick-bottom').checked) panel.scrollTop = panel.scrollHeight;
  }

  // Point the panel at a run, keeping the user's phase pick across runs.
  function resetFollow(runId) {
    logFollow = { runId, file: null, offset: 0, raw: '', phase: logFollow.phase };
    $('logs-panel').textContent = '';
  }

  function retargetLogs() {
    const target = followTarget();
    if (target && target !== logFollow.runId) resetFollow(target);
  }

  async function pollLogs() {
    let runId = followTarget();
    if (!runId) {
      const status = await API.getStatus().catch(() => null);
      runId = status && status.active_run_id;
    }
    if (!runId) return;
    if (runId !== logFollow.runId) resetFollow(runId);

    let res;
    // 'auto' lets the backend pick the running phase's file; an explicit pick is
    // passed straight through, so the panel stays on it as the run moves on.
    try { res = await API.tailLogs(runId, logFollow.phase, logFollow.offset); }
    catch (_) { return; }
    if (!res.exists) {
      // No file yet: the phase was skipped (cached model, reused server) or is
      // still ahead of us. Say so for an explicit pick, but don't commit it to
      // the buffer or pin `file` — the next poll picks the log up if it appears.
      if (logFollow.phase !== 'auto') {
        $('logs-panel').textContent =
          `${PHASE_HEADERS[res.file] || res.file}\n\n(no log for this phase)`;
      }
      return;
    }
    if (res.file !== logFollow.file) {
      // First fetch, or (in auto) the phase switched → new file starts at byte 0.
      logFollow.file = res.file;
      logFollow.offset = 0;
      try { res = await API.tailLogs(runId, res.file, 0); } catch (_) { return; }
      logFollow.raw = (logFollow.raw || '') +
        `\n${PHASE_HEADERS[res.file] || ('=== ' + res.file + ' ===')}\n`;
      renderLogs();
    }
    if (res.data) {
      logFollow.raw = (logFollow.raw || '') + res.data;
      logFollow.offset = res.offset;
      renderLogs();
    }
  }

  // --------------------------------------------------------------- boot
  async function hydrate() {
    // settings → footer
    try {
      const s = await API.getSettings();
      window.__settings = s;
      $('footer-model-dir').textContent = s.model_dir;
      const tok = $('footer-hf-token');
      tok.textContent = s.hf_token_set ? 'Loaded ✓' : 'Not set';
      tok.className = s.hf_token_set ? 'token-ok' : 'token-missing';
    } catch (_) { /* footer shows placeholders */ }

    try { datasetsCache = await API.getDatasets(); } catch (_) { /* builtins */ }
    try { modelsCache = await API.getModels(); } catch (_) { /* empty */ }

    // tabs: restored drafts + re-hydrated queued/active runs
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(DRAFTS_KEY)); } catch (_) { /* corrupt */ }
    tabs = (stored && Array.isArray(stored.drafts) ? stored.drafts : [])
      .map((d) => {
        const params = { ...DEFAULT_PARAMS, ...d.params };
        // Migrate pre-schema drafts; top up new-style ones with defaults so
        // fields added to the schema later pick up their default.
        params.dataset_params = (d.params && d.params.dataset_params
          && Object.keys(d.params.dataset_params).length)
          ? { ...defaultDatasetParams(params.dataset), ...d.params.dataset_params }
          : legacyToParams(params);
        delete params.input_len;
        delete params.output_len;
        delete params.sonnet_prefix_len;
        return { ...d, params, runId: null };
      });

    let runs = [];
    try { runs = await API.getRuns(); } catch (_) { /* offline */ }
    runsById = {};
    runs.forEach((r) => { runsById[r.id] = r; });
    runs
      .filter((r) => r.status === 'queued' || ACTIVE_STATUSES.includes(r.status))
      .forEach((r) => {
        tabs.push({
          tid: uid(), name: r.name, label: r.label || '',
          params: flattenConfig(r.config), runId: r.id,
        });
      });

    if (!tabs.length) tabs.push(freshTab());
    activeTid = (stored && tabs.some((t) => t.tid === stored.activeTid))
      ? stored.activeTid : tabs[0].tid;

    renderTabs();
    renderParams();
    updateSubmitState();
    pollStatuses();
    setInterval(pollStatuses, 3000);
    setInterval(pollLogs, 2000);
  }

  function flattenConfig(cfg) {
    const dp = cfg.bench.dataset_params;
    return {
      ...DEFAULT_PARAMS,
      model: cfg.server.model,
      tensor_parallel_size: cfg.server.tensor_parallel_size,
      gpu_memory_utilization: cfg.server.gpu_memory_utilization,
      max_model_len: cfg.server.max_model_len ?? '',
      port: cfg.server.port ?? '',
      extra_server_args: cfg.server.extra_server_args || '',
      backend: cfg.bench.backend,
      dataset: cfg.bench.dataset,
      num_prompts: cfg.bench.num_prompts,
      max_concurrency: cfg.bench.max_concurrency,
      request_rate: cfg.bench.request_rate,
      ignore_eos: cfg.bench.ignore_eos,
      seed: cfg.bench.seed,
      // Pre-schema runs carry flat length fields instead of dataset_params.
      dataset_params: (dp && Object.keys(dp).length)
        ? { ...defaultDatasetParams(cfg.bench.dataset), ...dp }
        : legacyToParams(cfg.bench),
    };
  }

  // ------------------------------------------------------------ wiring
  $('btn-submit').addEventListener('click', submit);
  $('btn-cancel').addEventListener('click', cancelActive);
  $('btn-cancel-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('cancel-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('cancel-menu').classList.add('hidden'));
  $('btn-cancel-all').addEventListener('click', cancelAll);
  $('run-label').addEventListener('change', () => {
    const tab = activeTab();
    if (tab && !tab.runId) { tab.label = $('run-label').value; saveDrafts(); }
  });
  $('status-chip').addEventListener('click', () => {
    const run = runOf(activeTab());
    if (run) {
      resetFollow(run.id);
      pollLogs();
    }
  });
  $('log-phase').addEventListener('change', (e) => {
    // Re-read the chosen file from byte 0; keep following the same run.
    logFollow.phase = e.target.value;
    logFollow.file = null;
    logFollow.offset = 0;
    logFollow.raw = '';
    $('logs-panel').textContent = '';
    pollLogs();
  });
  document.addEventListener('settings-saved', hydrateFooter);

  // "Use in Benchmark" from the Datasets view: point a draft tab at the
  // dataset (a fresh tab if the current one is already submitted).
  document.addEventListener('use-dataset', (e) => {
    let tab = activeTab();
    if (!tab || tab.runId) { addTab(); tab = activeTab(); }
    tab.params.dataset = e.detail;
    tab.params.dataset_params = defaultDatasetParams(e.detail);
    renderParams();
    validateTab(tab);
    showErrors(tab);
    saveDrafts();
    updateSubmitState();
  });

  async function hydrateFooter() {
    try {
      const s = await API.getSettings();
      window.__settings = s;
      $('footer-model-dir').textContent = s.model_dir;
      const tok = $('footer-hf-token');
      tok.textContent = s.hf_token_set ? 'Loaded ✓' : 'Not set';
      tok.className = s.hf_token_set ? 'token-ok' : 'token-missing';
    } catch (_) { /* keep last known */ }
    // Offline mode changes requiredness (hf subset/split) and the nudges —
    // re-validate and re-render the active tab immediately.
    const tab = activeTab();
    if (tab) {
      validateTab(tab);
      renderParams();
      updateSubmitState();
    }
  }

  hydrate();
})();
