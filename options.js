/**
 * Quick Answer - settings page.
 *
 * Reads and writes chrome.storage.local. The key is stored in this browser
 * profile only: storage.local is never synced to your Google account, and the
 * key is sent to the chosen provider and nowhere else.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const providerSel = $('provider');
  const keyInput = $('key');
  const modelInput = $('model');
  const modelList = $('model-list');
  const statusEl = $('status');

  let current = Object.assign({}, QA_DEFAULTS);

  /* ------------------------------------------------------------- rendering */

  for (const [id, p] of Object.entries(QA_PROVIDERS)) {
    providerSel.append(new Option(p.label, id));
  }

  function selectedMode() {
    const checked = document.querySelector('input[name=mode]:checked');
    return checked ? checked.value : 'builtin';
  }

  function syncCloudVisibility() {
    document.body.classList.toggle('show-cloud', selectedMode() !== 'builtin');
  }

  function syncProviderFields(keepModel) {
    const p = QA_PROVIDERS[providerSel.value] || QA_PROVIDERS.anthropic;
    $('key-hint').textContent = p.keyHint;
    $('model-hint').textContent = p.modelHint;
    modelList.textContent = '';
    for (const m of p.models) modelList.append(new Option(m));
    if (!keepModel) modelInput.value = p.defaultModel;
    modelInput.placeholder = p.defaultModel;
  }

  function say(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  /* --------------------------------------------------------------- loading */

  chrome.storage.local.get(QA_DEFAULTS, (stored) => {
    current = Object.assign({}, QA_DEFAULTS, stored);
    const modeRadio = document.querySelector(`input[name=mode][value="${current.mode}"]`);
    (modeRadio || $('m-builtin')).checked = true;
    providerSel.value = QA_PROVIDERS[current.provider] ? current.provider : 'anthropic';
    keyInput.value = current.apiKey || '';
    syncProviderFields(true);
    modelInput.value = current.model || QA_PROVIDERS[providerSel.value].defaultModel;
    syncCloudVisibility();
  });

  /* --------------------------------------------------------------- events */

  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.addEventListener('change', () => { syncCloudVisibility(); say(''); });
  }
  providerSel.addEventListener('change', () => { syncProviderFields(false); say(''); });

  $('reveal').addEventListener('click', () => {
    const shown = keyInput.type === 'text';
    keyInput.type = shown ? 'password' : 'text';
    $('reveal').textContent = shown ? 'Show' : 'Hide';
  });

  function collect() {
    return {
      mode: selectedMode(),
      provider: providerSel.value,
      apiKey: keyInput.value.trim(),
      model: modelInput.value.trim() || QA_PROVIDERS[providerSel.value].defaultModel
    };
  }

  function validate(settings) {
    if (settings.mode === 'builtin') return null;
    if (!settings.apiKey) return 'Enter an API key, or switch to "Built-in AI only".';
    return null;
  }

  $('save').addEventListener('click', () => {
    const settings = collect();
    const problem = validate(settings);
    if (problem) return say(problem, 'bad');
    chrome.storage.local.set(settings, () => {
      if (chrome.runtime.lastError) return say(chrome.runtime.lastError.message, 'bad');
      current = settings;
      say('Saved.', 'ok');
    });
  });

  $('test').addEventListener('click', () => {
    const settings = collect();
    const problem = validate(settings);
    if (problem) return say(problem, 'bad');
    say('Testing...', 'busy');
    $('test').disabled = true;
    chrome.runtime.sendMessage({ type: 'QA_TEST', settings }, (res) => {
      $('test').disabled = false;
      if (chrome.runtime.lastError) return say(chrome.runtime.lastError.message, 'bad');
      if (!res) return say('No response from the extension service worker.', 'bad');
      say(res.ok ? `Working. Answered: "${res.sample}"` : res.message, res.ok ? 'ok' : 'bad');
    });
  });
})();
