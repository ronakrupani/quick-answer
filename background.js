/**
 * Quick Answer - service worker.
 *
 * This file owns everything AI. `LanguageModel` (the Prompt API / Gemini Nano)
 * is exposed in extension window and worker scripts only, never in content
 * scripts, so all model work happens here and the result is pushed to the tab.
 */

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

/* ---------------------------------------------------------- menu click */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  handle(info, tab).catch((err) => console.error('[Quick Answer]', err));
});

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

  if (typeof LanguageModel === 'undefined') {
    console.warn('[Quick Answer] LanguageModel is undefined in this service worker.');
    await post({
      type: 'QA_ERROR',
      message: "Chrome's built-in AI is not available on this machine."
    });
    return;
  }

  let availability;
  try {
    availability = await LanguageModel.availability();
  } catch (err) {
    console.error('[Quick Answer] availability() threw:', err);
    await post({
      type: 'QA_ERROR',
      message: "Chrome's built-in AI is not available on this machine."
    });
    return;
  }

  // Log the raw string so you can see what your Chrome actually returns.
  console.log('[Quick Answer] LanguageModel.availability() ->', availability);

  const state = classifyAvailability(availability);
  if (state === 'unavailable') {
    await post({
      type: 'QA_ERROR',
      message: "Chrome's built-in AI is not available on this machine."
    });
    return;
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
    await post({
      type: 'QA_ERROR',
      message: "Chrome's built-in AI could not start on this machine."
    });
    return;
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

    const finalText = tidy(answer) || 'Not sure';
    await post({ type: 'QA_DONE', text: finalText });
  } catch (err) {
    console.error('[Quick Answer] prompt failed:', err);
    await post({ type: 'QA_ERROR', message: 'Could not get an answer for that selection.' });
  } finally {
    try {
      session.destroy();
    } catch (err) {
      console.debug('[Quick Answer] destroy() failed:', err && err.message);
    }
  }
}

/* ------------------------------------------- content -> background pings */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'QA_PING') {
    sendResponse({ ok: true });
  }
  return false;
});
