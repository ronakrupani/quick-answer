/**
 * Quick Answer - service worker.
 *
 * This file owns everything AI. `LanguageModel` (the Prompt API / Gemini Nano)
 * is exposed in extension window and worker scripts only, never in content
 * scripts, so all model work happens here and the result is pushed to the tab.
 *
 * An optional API key can be configured on the options page. Built-in AI stays
 * the default; nothing is sent off the machine unless you opt in.
 */

importScripts('providers.js');

const MENU_ID = 'quick-answer-interpret';
const MAX_INPUT_CHARS = 4000;
const MAX_ANSWER_CHARS = 200;

const SYSTEM_PROMPT = [
  'You answer highlighted text from a web page.',
  'Be extremely brief. Brevity matters more than completeness.',
  'If it is a question, answer it directly, usually in a few words, never more than one sentence.',
  'If it is a word or term, define it in a few words.',
  'If it is a sentence or passage, say what it means in one short sentence.',
  'Never write more than one sentence. Never write more than 25 words.',
  'No preamble. No restating the question. No markdown. No lists. No quotes around the answer.',
  'If you do not know, reply exactly "Not sure" and nothing else.'
].join(' ');

/* ------------------------------------------------------------------ menu */

function createMenu() {
  // removeAll first so a reload does not throw "duplicate id".
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: 'Interpret',
        contexts: ['selection']
      },
      () => void chrome.runtime.lastError
    );
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

/* ------------------------------------------------- messaging to the tab */

/**
 * Content scripts do not run on chrome:// pages, the Chrome Web Store, or the
 * built-in PDF viewer, and a page loaded before the extension was installed
 * has no content script either. Swallow the rejection so it never surfaces as
 * an unhandled promise error in the service worker console.
 */
async function send(tabId, frameId, message) {
  const options = typeof frameId === 'number' ? { frameId } : undefined;
  try {
    await chrome.tabs.sendMessage(tabId, message, options);
    return true;
  } catch (err) {
    console.debug('[Quick Answer] tab message not delivered:', err && err.message);
    return false;
  }
}

/** Inject content.js on demand for tabs that loaded before install/reload. */
async function ensureContentScript(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId },
      files: ['content.js']
    });
    return true;
  } catch (err) {
    console.debug('[Quick Answer] could not inject content script:', err && err.message);
    return false;
  }
}

/* ---------------------------------------------------------- model layer */

/**
 * Availability strings have changed between Chrome versions:
 *   newer: 'available' | 'downloadable' | 'downloading' | 'unavailable'
 *   older: 'readily-available' | 'after-download' | 'no'
 * So classify by pattern rather than by an exact set.
 */
function classifyAvailability(raw) {
  const value = String(raw == null ? '' : raw);
  if (/unavailable|^no$/i.test(value)) return 'unavailable';
  if (/download|after-download/i.test(value)) return 'needs-download';
  return 'ready';
}

/** Clamp to whatever this build actually supports, when it tells us. */
async function tunedOptions() {
  const wanted = { temperature: 0.3, topK: 3 };
  try {
    const params = await LanguageModel.params();
    if (params) {
      if (typeof params.maxTemperature === 'number') {
        wanted.temperature = Math.min(wanted.temperature, params.maxTemperature);
      }
      if (typeof params.maxTopK === 'number') {
        wanted.topK = Math.max(1, Math.min(wanted.topK, params.maxTopK));
      }
    }
  } catch (err) {
    console.debug('[Quick Answer] LanguageModel.params() unavailable:', err && err.message);
  }
  return wanted;
}

/** Hard ceiling in code, because Gemini Nano ignores instructions sometimes. */
function tidy(text) {
  let out = String(text || '')
    .replace(/^\s*(?:```[a-z]*\s*)?/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > MAX_ANSWER_CHARS) {
    const match = out.match(/^[\s\S]*?[.!?](?=\s|$)/);
    out = match ? match[0].trim() : out.slice(0, MAX_ANSWER_CHARS).trim() + '…';
  }
  return out;
}

/* ---------------------------------------------------------------- settings */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(QA_DEFAULTS);
    return Object.assign({}, QA_DEFAULTS, stored);
  } catch (err) {
    console.debug('[Quick Answer] could not read settings:', err && err.message);
    return Object.assign({}, QA_DEFAULTS);
  }
}

/** True when a cloud call is configured well enough to attempt. */
function cloudReady(settings) {
  return !!(settings && settings.apiKey && QA_PROVIDERS[settings.provider]);
}

/**
 * One non-streaming request to the configured provider.
 * Cloud models answer in about a second, and the answer is one sentence, so
 * streaming would add an SSE parser per provider for no perceptible gain.
 * Throws an Error whose message is safe to show in the popup.
 */
async function askCloud(settings, text) {
  const provider = QA_PROVIDERS[settings.provider];
  if (!provider) throw new Error('That provider is not configured.');
  const model = settings.model || provider.defaultModel;
  const { url, headers, body } = provider.request(settings.apiKey, model, SYSTEM_PROMPT, text);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    // Network down, DNS, or a CORS rejection all land here.
    console.error('[Quick Answer] network error calling', settings.provider, err);
    throw new Error('Could not reach ' + provider.label + '. Check your connection.');
  }

  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // Leave json null; handled below.
  }

  if (!res.ok) {
    const detail = (json && provider.error(json)) || '';
    console.error('[Quick Answer]', provider.label, 'HTTP', res.status, detail || raw.slice(0, 300));
    if (res.status === 401 || res.status === 403) throw new Error('That API key was rejected.');
    if (res.status === 429) throw new Error('Rate limited by ' + provider.label + '. Try again shortly.');
    if (res.status >= 500) throw new Error(provider.label + ' is having trouble. Try again shortly.');
    throw new Error(detail ? detail.slice(0, 140) : provider.label + ' returned HTTP ' + res.status + '.');
  }
  if (!json) throw new Error(provider.label + ' returned a response we could not read.');

  const answer = provider.answer(json);
  if (!answer) {
    console.warn('[Quick Answer] empty answer from', provider.label, json);
    throw new Error(provider.label + ' returned an empty answer.');
  }
  return answer;
}

/* ---------------------------------------------------------- menu click */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  handle(info, tab).catch((err) => console.error('[Quick Answer]', err));
});

/**
 * Run the built-in on-device model.
 * Resolves to the answer, or throws. A thrown error with `.builtinUnavailable`
 * means this machine cannot run it, which is what "auto" mode falls back on.
 */
async function askBuiltin(selection, post) {
  const unavailable = (msg) => {
    const err = new Error(msg);
    err.builtinUnavailable = true;
    return err;
  };

  if (typeof LanguageModel === 'undefined') {
    console.warn('[Quick Answer] LanguageModel is undefined in this service worker.');
    throw unavailable("Chrome's built-in AI is not available on this machine.");
  }

  let availability;
  try {
    availability = await LanguageModel.availability();
  } catch (err) {
    console.error('[Quick Answer] availability() threw:', err);
    throw unavailable("Chrome's built-in AI is not available on this machine.");
  }

  // Log the raw string so you can see what your Chrome actually returns.
  console.log('[Quick Answer] LanguageModel.availability() ->', availability);

  const state = classifyAvailability(availability);
  if (state === 'unavailable') {
    throw unavailable("Chrome's built-in AI is not available on this machine.");
  }
  if (state === 'needs-download') {
    await post({ type: 'QA_DOWNLOAD', percent: 0 });
  }

  const { temperature, topK } = await tunedOptions();

  // A session cached in a module variable dies with the service worker
  // (~30s idle), so create a fresh one per request. Simple and always valid.
  let session;
  try {
    session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      temperature,
      topK,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const loaded = typeof e.loaded === 'number' ? e.loaded : 0;
          // e.loaded is 0..1 in current builds; tolerate a 0..100 build too.
          const fraction = loaded > 1 ? loaded / 100 : loaded;
          const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
          post({ type: 'QA_DOWNLOAD', percent });
        });
      }
    });
  } catch (err) {
    console.error('[Quick Answer] create() failed:', err);
    throw unavailable("Chrome's built-in AI could not start on this machine.");
  }

  try {
    await post({ type: 'QA_LOADING' });
    let answer = '';

    if (typeof session.promptStreaming === 'function') {
      const stream = session.promptStreaming(selection);
      for await (const chunk of stream) {
        const piece = String(chunk == null ? '' : chunk);
        // Older builds streamed the cumulative string, newer ones stream deltas.
        answer = piece.startsWith(answer) && piece.length >= answer.length ? piece : answer + piece;
        await post({ type: 'QA_CHUNK', text: tidy(answer) });
      }
    } else {
      answer = await session.prompt(selection);
    }
    return answer;
  } finally {
    try {
      session.destroy();
    } catch (err) {
      console.debug('[Quick Answer] destroy() failed:', err && err.message);
    }
  }
}

async function handle(info, tab) {
  const tabId = tab.id;
  const frameId = typeof info.frameId === 'number' ? info.frameId : undefined;
  const selection = String(info.selectionText || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!selection) return;

  const post = (message) => send(tabId, frameId, message);

  let delivered = await post({ type: 'QA_LOADING' });
  if (!delivered) {
    // Page probably predates the install, or is a restricted page.
    const injected = await ensureContentScript(tabId, frameId);
    if (!injected) return;
    delivered = await post({ type: 'QA_LOADING' });
    if (!delivered) return;
  }

  const settings = await loadSettings();
  const useCloud = settings.mode === 'cloud' && cloudReady(settings);
  let answer = '';

  try {
    if (useCloud) {
      answer = await askCloud(settings, selection);
    } else {
      try {
        answer = await askBuiltin(selection, post);
      } catch (err) {
        // "auto" mode is the only path that falls back, and only when the
        // machine genuinely cannot run the built-in model.
        if (err && err.builtinUnavailable && settings.mode === 'auto' && cloudReady(settings)) {
          console.log('[Quick Answer] built-in unavailable, falling back to', settings.provider);
          await post({ type: 'QA_LOADING' });
          answer = await askCloud(settings, selection);
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    console.error('[Quick Answer]', err);
    const message = (err && err.message) || 'Could not get an answer for that selection.';
    await post({ type: 'QA_ERROR', message });
    return;
  }

  await post({ type: 'QA_DONE', text: tidy(answer) || 'Not sure' });
}

/* ------------------------------------------- content -> background pings */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'QA_PING') {
    sendResponse({ ok: true });
    return false;
  }

  // The options page "Test connection" button. Uses the settings currently in
  // the form, so you can verify a key before saving it.
  if (message.type === 'QA_TEST') {
    const settings = Object.assign({}, QA_DEFAULTS, message.settings || {});
    askCloud(settings, 'Define the word "test" in three words.')
      .then((text) => sendResponse({ ok: true, sample: tidy(text) }))
      .catch((err) => sendResponse({ ok: false, message: (err && err.message) || 'Test failed.' }));
    return true;   // keep the channel open for the async reply
  }

  return false;
});
