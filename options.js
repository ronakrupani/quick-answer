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

    // Hint plus a direct link to that provider's key page. Built with DOM
    // calls rather than innerHTML so provider strings are never parsed as markup.
    const hint = $('key-hint');
    hint.textContent = p.keyHint + ' ';
    if (p.keyUrl) {
      const a = document.createElement('a');
      a.href = p.keyUrl;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = 'Get a key';
      hint.appendChild(a);
    }
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

  // Provider docs go stale (Groq retired two model ids while their models page
  // still advertised them). This asks the provider what the key can actually use.
  $('load-models').addEventListener('click', () => {
    const settings = collect();
    if (!settings.apiKey) return say('Enter an API key first.', 'bad');
    say('Loading models...', 'busy');
    $('load-models').disabled = true;
    chrome.runtime.sendMessage({ type: 'QA_MODELS', settings }, (res) => {
      $('load-models').disabled = false;
      if (chrome.runtime.lastError) return say(chrome.runtime.lastError.message, 'bad');
      if (!res) return say('No response from the extension service worker.', 'bad');
      if (!res.ok) return say(res.message, 'bad');
      modelList.textContent = '';
      for (const m of res.models) modelList.append(new Option(m));
      if (res.models.indexOf(modelInput.value) === -1) {
        const was = modelInput.value;
        modelInput.value = res.models[0];
        return say(`"${was}" is not on your account. Switched to ${res.models[0]}. ` +
                   `${res.models.length} models available in the dropdown.`, 'ok');
      }
      say(`${res.models.length} models available. "${modelInput.value}" is valid.`, 'ok');
    });
  });

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
