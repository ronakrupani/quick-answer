# Quick Answer

Highlight text on any web page, right-click, pick **Interpret**. A small popup appears right under your selection with a very short answer.

- Highlight a question, it answers the question.
- Highlight a term, it defines it in a few words.
- Highlight a dense sentence, it tells you what the sentence means.

Answers are one sentence maximum, usually just a few words. The popup is plain and small, and it disappears when you click away or press Escape.

By default everything runs on your own machine using Chrome's built-in AI (the Prompt API, backed by Gemini Nano). No accounts, no network calls to any model provider. After the one-time model download, it works offline.

An API key is optional, for machines that cannot run the built-in model. See [Using an API key instead](#using-an-api-key-instead). It is off by default, and nothing leaves your machine until you turn it on.

## Requirements, please read first

This extension will not work on every machine. Chrome's built-in AI has real hardware requirements:

- **Chrome 138 or newer**, on desktop. The Prompt API is not available on Chrome for Android, iOS, or ChromeOS on Android.
- **Operating system**: Windows 10 or 11, macOS 13 (Ventura) or newer, Linux, or ChromeOS (platform 16389.0.0+ on Chromebook Plus).
- **Storage**: at least 22 GB free on the volume that holds your Chrome profile. If free space drops below 10 GB after the download, Chrome deletes the model.
- **GPU or memory**: more than 4 GB of VRAM, or at least 16 GB of RAM with 4 or more CPU cores.
- **Network**: an unmetered connection for the initial model download.

If your machine does not qualify, the popup says so in one line rather than showing a generic error. That is also the case where an API key is worth configuring, since the hardware bar above does not apply to it.

## Install (load unpacked)

1. Download this repository. Either `git clone` it, or use the green **Code** button and **Download ZIP**, then unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** with the toggle in the top right.
4. Click **Load unpacked**.
5. Select the folder that contains `manifest.json` (the folder you just cloned or unzipped).
6. Quick Answer now appears in your extensions list. There is no options page and no toolbar popup to configure. Just select text on a page and right-click.

To confirm it loaded correctly, open any ordinary web page, select a word, and right-click. You should see **Interpret** in the context menu.

## First use downloads the model

The very first time you run Interpret, Chrome downloads the Gemini Nano model. This is a multi-gigabyte, one-time download and it can take several minutes on a normal connection.

You will see the live progress as a percentage in the popup, along with a note that this is a one-time download. Once it finishes, the extension answers in a second or two and works with no network connection at all.

If the download appears stuck, open `chrome://on-device-internals` to see the model's real status. Chrome may also be waiting for an idle moment or an unmetered network.

## Using an API key instead

The built-in model needs hardware many machines do not have. If yours is one of them, you can point the extension at a hosted model instead. Open `chrome://extensions`, find Quick Answer, click **Details**, then **Extension options**.

**Understand the tradeoff before you turn this on.** With a key configured, the text you highlight is sent to the provider you choose, under your own account and billing. That is the opposite of the default behavior. Only the selected text is sent, never the whole page, and never anything you have not explicitly highlighted.

Three modes:

- **Built-in AI only** (default) Fully offline. Nothing leaves your machine. No key involved even if one is saved.
- **Built-in AI, fall back to API** Stays local when it can. Uses your key only when the built-in model is genuinely unavailable.
- **API only** Always uses your key.

Supported providers: Anthropic, OpenAI, Groq, and the Google Gemini API. Paste a key, pick a model, and press **Test connection** to confirm it works before saving. Cheap models are more than adequate here, since answers are one sentence.

Where the key is kept:

- In `chrome.storage.local`, which lives in this browser profile on this machine. It is not `storage.sync`, so it never travels to your Google account or your other devices.
- It is sent to the provider you chose and nowhere else. It is never written to the console or to any log.
- Anyone with access to your computer and your Chrome profile can read it, the same as a saved password. Treat it accordingly, and revoke the key from the provider's dashboard if the machine is shared or lost.

## Known limits

These are inherent to how Chrome extensions and on-device models work, not bugs to file:

- **Restricted pages.** Content scripts cannot run on `chrome://` pages, the Chrome Web Store, other extensions' pages, or Chrome's built-in PDF viewer. The context menu item may appear there, but no popup can be drawn. The extension swallows this quietly instead of throwing errors.
- **Pages open before install.** A tab you opened before installing or reloading the extension has no content script yet. Quick Answer tries to inject one on demand, but if that fails, reload the tab.
- **The model is small.** Gemini Nano is far less capable than a cloud model. It gets things wrong, and it sometimes ignores the instruction to be brief. The extension trims anything over roughly 200 characters down to its first sentence, so a rambling answer will look truncated. That is deliberate.
- **Selection cap.** The selection is truncated to about 4000 characters before it is sent to the model.
- **Latency.** On-device inference is slower than a cloud API. The answer streams in as it is generated, so you see the first words quickly.
- **One popup at a time.** Opening a new answer replaces the previous popup.
- **Cross-origin iframes.** Selections inside an iframe are handled, but the popup is drawn inside that frame, so it is clipped to the frame's bounds.
- **API answers do not stream.** Hosted models reply in about a second and the answer is one sentence, so the popup shows the loading dots and then the finished answer. Streaming is used for the built-in model, where it genuinely helps.
- **Groq model ids move.** Groq retires and renames models fairly often. If a model id stops working, check console.groq.com/docs/models and type the current id into the Model box, which accepts any value rather than only the listed ones.
- **The browser-access header is unverified.** Anthropic blocks browser-origin requests by default. The extension sends `anthropic-dangerous-direct-browser-access: true`, which an extension service worker may not need. It is harmless if the server ignores it. **Test connection** tells you the truth in one click.

## How to update

```
git pull
```

Then open `chrome://extensions` and click the circular refresh icon on the Quick Answer card. Chrome does not auto-reload unpacked extensions when files change on disk.

If you installed from a ZIP instead of a clone, download the new ZIP, unzip it over the old folder, and hit the same refresh icon.

## How it works

Six files, no build step, no dependencies.

- `manifest.json` is Manifest V3. Note that the Prompt API needs no manifest permission at all. If you have seen advice about a `trial_tokens` field or an `aiLanguageModelOriginTrial` permission, that is stale origin-trial documentation and it will break the extension.
- `background.js` is the service worker and owns everything AI. `LanguageModel` is exposed only in extension window and worker scripts, so all model work happens here. It creates the context menu, checks availability, creates a fresh session per request (MV3 service workers are killed after about 30 seconds idle, which would invalidate any cached session), streams the answer, and pushes it to the tab.
- `content.js` is UI only. It never touches `LanguageModel`. It records the selection rectangle on `contextmenu` (before the menu opens, while the selection still exists), then draws the answer in a closed shadow DOM so the page's CSS cannot leak in and wreck it.
- `providers.js` holds the hosted-provider adapters. It is loaded by the worker through `importScripts` and by the options page through a plain script tag, so the two can never drift apart.
- `options.html` / `options.js` are the settings page. Settings live in `chrome.storage.local`.

## License

MIT
