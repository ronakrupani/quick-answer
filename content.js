/**
 * Quick Answer - content script.
 *
 * Dumb UI only. It never touches `LanguageModel`; that lives in background.js.
 * Its two jobs: remember where the selection was when the context menu opened,
 * and draw the popup when the service worker tells it what to say.
 */

(() => {
  // content.js is declared in the manifest AND may be injected on demand for
  // tabs that predate the install, so guard against running twice.
  if (window.__quickAnswerLoaded) return;
  window.__quickAnswerLoaded = true;

  const HOST_ID = 'quick-answer-host';
  const GAP = 8;          // px between the selection and the card
  const MARGIN = 8;       // px kept clear of the viewport edges
  const MAX_WIDTH = 320;

  /** Selection rect in page coordinates, captured before the menu opens. */
  let anchor = null;
  let host = null;
  let root = null;
  let card = null;

  /* --------------------------------------------------------- anchoring */

  // By the time the menu click fires the selection may be gone, so capture on
  // `contextmenu`, which runs first. Page coordinates (scrollX/scrollY added)
  // keep the popup anchored to the text while the page scrolls.
  document.addEventListener(
    'contextmenu',
    () => {
      try {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;
        anchor = {
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          right: rect.right + window.scrollX,
          bottom: rect.bottom + window.scrollY
        };
      } catch (err) {
        anchor = null;
      }
    },
    true
  );

  /* ------------------------------------------------------------ styles */

  const CSS = `
    :host { all: initial; }
    .card {
      box-sizing: border-box;
      max-width: ${MAX_WIDTH}px;
      width: max-content;
      padding: 8px 11px;
      border: 1px solid rgba(0, 0, 0, 0.14);
      border-radius: 8px;
      background: #ffffff;
      color: #1a1a1a;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
            Helvetica, Arial, sans-serif;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 6px 20px rgba(0, 0, 0, 0.12);
      opacity: 0;
      transform: translateY(4px);
      animation: qa-in 90ms ease-out forwards;
      overflow-wrap: break-word;
      word-break: break-word;
      user-select: text;
      -webkit-user-select: text;
      cursor: default;
      text-align: left;
    }
    @keyframes qa-in {
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; opacity: 1; transform: none; }
    }
    .muted { color: #6b6b6b; }
    .dots {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 15px;
      padding: 1px 2px;
    }
    .dots i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #9a9a9a;
      animation: qa-pulse 1s ease-in-out infinite;
    }
    .dots i:nth-child(2) { animation-delay: 0.16s; }
    .dots i:nth-child(3) { animation-delay: 0.32s; }
    @keyframes qa-pulse {
      0%, 100% { opacity: 0.28; transform: scale(0.82); }
      50%      { opacity: 1;    transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .dots i { animation: none; opacity: 0.6; }
    }
    .sub { display: block; margin-top: 3px; font-size: 11px; color: #6b6b6b; }
    @media (prefers-color-scheme: dark) {
      .card {
        background: #1f1f1f;
        color: #ececec;
        border-color: rgba(255, 255, 255, 0.16);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 6px 20px rgba(0, 0, 0, 0.45);
      }
      .muted, .sub { color: #a3a3a3; }
      .dots i { background: #8a8a8a; }
    }
  `;

  /* ------------------------------------------------------------ popup */

  function ensurePopup() {
    if (host && host.isConnected && card) return;
    destroyPopup();

    host = document.createElement('div');
    host.id = HOST_ID;
    // `all: initial` lives in the shadow CSS; these are the few properties the
    // host itself needs, set inline so page CSS cannot override them.
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'absolute', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('top', '0', 'important');
    host.style.setProperty('left', '0', 'important');

    // Closed shadow root: page scripts cannot reach in, page CSS cannot leak in.
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    card = document.createElement('div');
    card.className = 'card';
    root.append(style, card);

    // Clicking inside must not dismiss, so the answer stays selectable.
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());

    (document.body || document.documentElement).appendChild(host);
    addDismissListeners();
  }

  function destroyPopup() {
    removeDismissListeners();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
    card = null;
  }

  function onDocMouseDown(e) {
    // The dismiss listener runs in the capture phase, so it fires before the
    // card's own stopPropagation. Ask the event path instead. With a closed
    // shadow root the path is retargeted to the host, which is what we want:
    // clicks inside the card must not dismiss it, so the answer stays
    // selectable and copyable.
    if (!host) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (e.target === host || path.indexOf(host) !== -1) return;
    destroyPopup();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') destroyPopup();
  }

  function addDismissListeners() {
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', destroyPopup);
  }
  function removeDismissListeners() {
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', destroyPopup);
  }

  /** Place the card under the selection, clamped inside the viewport. */
  function position() {
    if (!host || !card) return;
    const a = anchor || {
      left: window.scrollX + window.innerWidth / 2,
      right: window.scrollX + window.innerWidth / 2,
      top: window.scrollY + window.innerHeight / 2,
      bottom: window.scrollY + window.innerHeight / 2
    };

    const width = card.offsetWidth || MAX_WIDTH;
    const height = card.offsetHeight || 32;

    // Viewport edges expressed in page coordinates.
    const minX = window.scrollX + MARGIN;
    const maxX = window.scrollX + document.documentElement.clientWidth - width - MARGIN;
    const minY = window.scrollY + MARGIN;
    const maxY = window.scrollY + document.documentElement.clientHeight - height - MARGIN;

    let left = a.left;
    if (left > maxX) left = maxX;      // would overflow the right edge, shift left
    if (left < minX) left = minX;

    let top = a.bottom + GAP;
    if (top > maxY) {
      const above = a.top - height - GAP;   // flip above the selection
      top = above >= minY ? above : Math.max(minY, maxY);
    }

    host.style.setProperty('left', `${Math.round(left)}px`, 'important');
    host.style.setProperty('top', `${Math.round(top)}px`, 'important');
  }

  function render(build) {
    ensurePopup();
    card.textContent = '';
    build(card);
    position();
    // Re-measure once the card has laid out (fonts, wrapping).
    requestAnimationFrame(position);
  }

  function showLoading() {
    render((el) => {
      const dots = document.createElement('div');
      dots.className = 'dots';
      dots.append(
        document.createElement('i'),
        document.createElement('i'),
        document.createElement('i')
      );
      el.appendChild(dots);
    });
  }

  function showDownload(percent) {
    render((el) => {
      const line = document.createElement('div');
      line.textContent = `Downloading model ${percent}%`;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = 'One-time download, this takes a few minutes.';
      el.append(line, sub);
    });
  }

  function showText(text, muted) {
    render((el) => {
      const line = document.createElement('div');
      if (muted) line.className = 'muted';
      line.textContent = text;
      el.appendChild(line);
    });
  }

  /* ---------------------------------------------------------- messages */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    switch (message.type) {
      case 'QA_LOADING':
        showLoading();
        break;
      case 'QA_DOWNLOAD':
        showDownload(Number(message.percent) || 0);
        break;
      case 'QA_CHUNK':
        if (message.text) showText(message.text, false);
        break;
      case 'QA_DONE':
        showText(message.text || 'Not sure', false);
        break;
      case 'QA_ERROR':
        showText(message.message || 'Something went wrong.', true);
        break;
      default:
        return false;
    }
    sendResponse({ ok: true });
    return false;
  });
})();
