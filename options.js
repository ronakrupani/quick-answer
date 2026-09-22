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
  const backupInput = $('backup-key');
  const backupProviderSel = $('backup-provider');
  const backupModelInput = $('backup-model');
  const backupModelList = $('backup-model-list');
  const modelInput = $('model');
  const modelList = $('model-list');
  const statusEl = $('status');

  let current = Object.assign({}, QA_DEFAULTS);

  /* ------------------------------------------------------------- rendering */

  for (const [id, p] of Object.entries(QA_PROVIDERS)) {
    providerSel.append(new Option(p.label, id));
  }
  backupProviderSel.append(new Option('Same as primary', ''));
  for (const [id, p] of Object.entries(QA_PROVIDERS)) {
    backupProviderSel.append(new Option(p.label, id));
  }

  /** The provider the backup slot actually resolves to. */
  function backupProviderId() {
    return backupProviderSel.value || providerSel.value;
  }

  function renderKeyHint(el, p) {
    el.textContent = p.keyHint + ' ';
    if (p.keyUrl) {
      const a = document.createElement('a');
      a.href = p.keyUrl;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = 'Get a key';
      el.appendChild(a);
    }
  }

  function syncBackupFields(keepModel) {
    const bId = backupProviderId();
    const b = QA_PROVIDERS[bId];
    renderKeyHint($('backup-key-hint'), b);
    backupModelList.textContent = '';
    for (const m of b.models) backupModelList.append(new Option(m));
    const same = !backupProviderSel.value;
    // Blank means "same model as primary" only when the provider is the same;
    // across providers a blank means that provider's own default.
    backupModelInput.placeholder = same ? 'Same as primary' : b.defaultModel;
    $('backup-model-hint').textContent = same
      ? 'Leave blank to use the primary model. ' + b.modelHint
      : b.modelHint;
    if (!keepModel) backupModelInput.value = '';
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
    renderKeyHint($('key-hint'), p);
    $('model-hint').textContent = p.modelHint;
    modelList.textContent = '';
    for (const m of p.models) modelList.append(new Option(m));
    // A backup set to "same as primary" follows the primary provider.
    syncBackupFields(true);
    if (!keepModel) modelInput.value = p.defaultModel;
    modelInput.placeholder = p.defaultModel;
  }

  function say(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  /**
   * chrome.runtime.lastError from sendMessage is almost always one thing: the
   * background worker did not answer. That happens when the extension files
   * were updated without reloading, or the worker failed to start. Say so.
   */
  function explainSendError(err) {
    const raw = (err && err.message) || String(err);
    if (/message port closed|Receiving end does not exist|Could not establish connection/i.test(raw)) {
      return 'The extension\'s background script did not respond. Open chrome://extensions, ' +
             'click the reload icon on Quick Answer, then reopen this page. If it keeps happening, ' +
             'click "Errors" on the extension card and send me what it says.';
    }
    return raw;
  }

  // Ping the worker on load so a dead or stale worker is obvious immediately,
  // rather than discovered when a button silently fails.
  function checkWorker() {
    let answered = false;
    try {
      chrome.runtime.sendMessage({ type: 'QA_PING' }, (res) => {
        answered = true;
        if (chrome.runtime.lastError || !res || !res.ok) {
          say(explainSendError(chrome.runtime.lastError || { message: 'message port closed' }), 'bad');
        }
      });
    } catch (err) {
      say(explainSendError(err), 'bad');
      return;
    }
    // A wedged worker may never call back at all.
    setTimeout(() => { if (!answered) say(explainSendError({ message: 'message port closed' }), 'bad'); }, 4000);
  }

  /* --------------------------------------------------------------- loading */

  chrome.storage.local.get(QA_DEFAULTS, (stored) => {
    current = Object.assign({}, QA_DEFAULTS, stored);
    const modeRadio = document.querySelector(`input[name=mode][value="${current.mode}"]`);
    (modeRadio || $('m-builtin')).checked = true;
    providerSel.value = QA_PROVIDERS[current.provider] ? current.provider : 'anthropic';
    keyInput.value = current.apiKey || '';
    backupInput.value = current.backupKey || '';
    backupProviderSel.value = QA_PROVIDERS[current.backupProvider] ? current.backupProvider : '';
    backupModelInput.value = current.backupModel || '';
    syncBackupFields(true);
    chrome.storage.local.get('lastFailover', (r) => showFailoverNote(r && r.lastFailover));
    checkWorker();
    syncProviderFields(true);
    modelInput.value = current.model || QA_PROVIDERS[providerSel.value].defaultModel;
    syncCloudVisibility();
  });

  /* --------------------------------------------------------------- events */

  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.addEventListener('change', () => { syncCloudVisibility(); say(''); });
  }
  providerSel.addEventListener('change', () => { syncProviderFields(false); say(''); });
  backupProviderSel.addEventListener('change', () => { syncBackupFields(false); say(''); });

  function wireReveal(buttonId, input) {
    $(buttonId).addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      $(buttonId).textContent = shown ? 'Show' : 'Hide';
    });
  }
  wireReveal('reveal', keyInput);
  wireReveal('reveal-backup', backupInput);

  // Tell the user when the primary was last skipped, so an exhausted key
  // does not go unnoticed just because the backup kept things working.
  function showFailoverNote(info) {
    const note = $('failover-note');
    if (!info || !info.at) { note.hidden = true; return; }
    const when = new Date(info.at);
    note.textContent = 'Primary key was skipped ' + when.toLocaleString() +
      ' (' + (info.reason || 'failed') + '). The backup handled it. ' +
      'Run Test connection once the primary is fixed.';
    note.hidden = false;
  }

  function collect() {
    return {
      mode: selectedMode(),
      provider: providerSel.value,
      apiKey: keyInput.value.trim(),
      backupProvider: backupProviderSel.value,
      backupKey: backupInput.value.trim(),
      backupModel: backupModelInput.value.trim(),
      model: modelInput.value.trim() || QA_PROVIDERS[providerSel.value].defaultModel
    };
  }

  function validate(settings) {
    if (settings.mode === 'builtin') return null;
    if (!settings.apiKey) return 'Enter an API key, or switch to "Built-in AI only".';
    const sameProvider = !settings.backupProvider || settings.backupProvider === settings.provider;
    if (sameProvider && settings.backupKey && settings.backupKey === settings.apiKey) {
      return 'The backup key is the same as the primary. Leave it blank or use a different key.';
    }
    return null;
  }

  // Provider docs go stale (Groq retired two model ids while their models page
  // still advertised them). This asks the provider what the key can actually use.
  function wireLoadModels(buttonId, slot, input, list) {
    $(buttonId).addEventListener('click', () => {
      const settings = collect();
      const key = slot === 'backup' ? settings.backupKey : settings.apiKey;
      if (!key) return say(slot === 'backup' ? 'Enter a backup API key first.' : 'Enter an API key first.', 'bad');
      say('Loading models...', 'busy');
      $(buttonId).disabled = true;
      chrome.runtime.sendMessage({ type: 'QA_MODELS', settings, slot }, (res) => {
        $(buttonId).disabled = false;
        if (chrome.runtime.lastError) return say(explainSendError(chrome.runtime.lastError), 'bad');
        if (!res) return say(explainSendError({ message: 'message port closed' }), 'bad');
        if (!res.ok) return say(res.message, 'bad');
        list.textContent = '';
        for (const m of res.models) list.append(new Option(m));
        const label = slot === 'backup' ? 'Backup' : 'Primary';
        // A blank backup model means "same as primary", which is a valid choice.
        if (slot === 'backup' && !input.value) {
          const same = !backupProviderSel.value;
          return say(`${label} key: ${res.models.length} models available in the dropdown. ` +
                     (same ? 'Leave blank to match the primary.' : `Leave blank to use ${QA_PROVIDERS[backupProviderId()].defaultModel}.`), 'ok');
        }
        if (res.models.indexOf(input.value) === -1) {
          const was = input.value;
          input.value = res.models[0];
          return say(`${label} key: "${was}" is not on this account. Switched to ${res.models[0]}. ` +
                     `${res.models.length} models available in the dropdown.`, 'ok');
        }
        say(`${label} key: ${res.models.length} models available. "${input.value}" is valid.`, 'ok');
      });
    });
  }
  wireLoadModels('load-models', 'primary', modelInput, modelList);
  wireLoadModels('load-backup-models', 'backup', backupModelInput, backupModelList);

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
      if (chrome.runtime.lastError) return say(explainSendError(chrome.runtime.lastError), 'bad');
      if (!res) return say(explainSendError({ message: 'message port closed' }), 'bad');
      if (!res.results || !res.results.length) return say(res.message || 'Test failed.', 'bad');
      statusEl.textContent = '';
      statusEl.className = '';
      for (const r of res.results) {
        const line = document.createElement('span');
        line.className = 'r ' + (r.ok ? 'ok' : 'bad');
        const label = r.slot === 'backup' ? 'Backup' : 'Primary';
        const on = ` (${[r.label, r.model].filter(Boolean).join(', ')})`;
        line.textContent = r.ok
          ? `${label} key${on}: working. Answered: "${r.sample}"`
          : `${label} key${on}: ${r.message}`;
        statusEl.appendChild(line);
      }
      if (res.results[0] && res.results[0].ok) {
        chrome.storage.local.remove('lastFailover', () => showFailoverNote(null));
      }
    });
  });
})();
