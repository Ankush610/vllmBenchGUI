// Settings view: load/save, SLURM block reveal, write-only token field.
'use strict';

(function settings() {
  const $ = (id) => document.getElementById(id);
  const form = $('settings-form');

  const TEXT_FIELDS = ['model_dir', 'results_dir',
    'slurm_partition', 'slurm_time_limit', 'slurm_account', 'slurm_extra_flags'];
  const NUM_FIELDS = ['port_range_start', 'health_check_timeout', 'slurm_gpus_per_job'];

  function setMsg(text, ok) {
    const el = $('settings-msg');
    el.textContent = text;
    el.className = ok ? 'ok' : 'err';
    if (text) setTimeout(() => { el.textContent = ''; }, 5000);
  }

  function toggleSlurmBlock() {
    const mode = form.elements.execution_mode.value;
    $('slurm-block').classList.toggle('hidden', mode !== 'slurm');
  }

  async function load() {
    let s;
    try { s = await API.getSettings(); } catch (e) {
      setMsg('Could not load settings: ' + e.message, false);
      return;
    }
    TEXT_FIELDS.concat(NUM_FIELDS).forEach((k) => {
      if (form.elements[k] && s[k] !== undefined) form.elements[k].value = s[k];
    });
    form.elements.bind_address.value = s.bind_address;
    form.elements.execution_mode.value = s.execution_mode;
    // Token is write-only: show placeholder dots when one is stored.
    form.elements.hf_token.value = '';
    form.elements.hf_token.placeholder = s.hf_token_set ? '••••••••••••' : 'hf_…';
    $('hf-token-hint').textContent = s.hf_token_set
      ? 'A token is stored. Leave blank to keep it; type a new one to replace it.'
      : 'No token stored. Needed for gated models (e.g. Llama).';
    toggleSlurmBlock();
  }

  async function save() {
    const body = {};
    TEXT_FIELDS.forEach((k) => {
      if (form.elements[k]) body[k] = form.elements[k].value.trim();
    });
    NUM_FIELDS.forEach((k) => {
      const v = form.elements[k].value.trim();
      if (v !== '') body[k] = Number(v);
    });
    body.bind_address = form.elements.bind_address.value;
    body.execution_mode = form.elements.execution_mode.value;
    // Only send the token if the user typed one — blank means "keep".
    const tok = form.elements.hf_token.value.trim();
    if (tok !== '') body.hf_token = tok;

    try {
      await API.putSettings(body);
      setMsg('Saved ✓', true);
      form.elements.hf_token.value = '';
      await load();
      // Footer indicators on the Benchmark view update instantly.
      document.dispatchEvent(new CustomEvent('settings-saved'));
    } catch (e) {
      setMsg('Save failed: ' + e.message, false);
    }
  }

  form.querySelectorAll('input[name=execution_mode]').forEach((r) =>
    r.addEventListener('change', toggleSlurmBlock));
  $('btn-save-settings').addEventListener('click', save);

  load();
})();
