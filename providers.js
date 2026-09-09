/**
 * Quick Answer - cloud provider adapters.
 *
 * Loaded by both background.js (via importScripts) and options.html (via a
 * plain script tag), so the two never drift. No modules, no build step.
 *
 * Each adapter is pure description plus two small functions: build the request,
 * pull the text out of the response. Nothing here logs or stores the key.
 */

var QA_PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keyHint: 'Starts with sk-ant-.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    modelHint: 'claude-haiku-4-5 is the cheapest and is plenty for one-line answers.',
    request(key, model, system, text) {
      const body = {
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: text }]
      };
      // Effort is supported on the 4.6+ family and rejected on Haiku 4.5.
      // Low effort keeps thinking on (recommended over disabling it) while
      // staying cheap and fast, which suits a one-sentence answer.
      if (/^claude-(opus-(5|4-[678])|sonnet-5|fable-5)/.test(model)) {
        body.output_config = { effort: 'low' };
      }
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          // Anthropic blocks browser-origin requests by default. An extension
          // service worker may not need this, but sending it is harmless if
          // the server ignores it and unblocks us if it does not.
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body
      };
    },
    answer(json) {
      // The content array can hold thinking blocks before the text ones.
      const blocks = Array.isArray(json && json.content) ? json.content : [];
      return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
    },
    error(json) {
      return json && json.error && json.error.message;
    }
  },

  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    keyHint: 'Starts with sk-.',
    keyUrl: 'https://platform.openai.com/api-keys',
    modelHint: 'Any chat-completions model id works. Type your own if it is not listed.',
    request(key, model, system, text) {
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key
        },
        // No token cap sent: the field name differs across model generations,
        // and the system prompt plus the length trim already bound the answer.
        body: {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text }
          ]
        }
      };
    },
    answer(json) {
      const choice = json && json.choices && json.choices[0];
      return (choice && choice.message && choice.message.content) || '';
    },
    error(json) {
      return json && json.error && json.error.message;
    }
  },

  groq: {
    label: 'Groq',
    defaultModel: 'llama-3.1-8b-instant',
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
    keyHint: 'Starts with gsk_.',
    keyUrl: 'https://console.groq.com/keys',
    modelHint: 'llama-3.1-8b-instant is the quickest and is plenty for one-line answers.',
    request(key, model, system, text) {
      return {
        // Groq speaks the OpenAI chat-completions shape on its own base URL.
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key
        },
        body: {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text }
          ]
        }
      };
    },
    answer(json) {
      const choice = json && json.choices && json.choices[0];
      return (choice && choice.message && choice.message.content) || '';
    },
    error(json) {
      return json && json.error && json.error.message;
    }
  },

  google: {
    label: 'Google (Gemini API)',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    keyHint: 'Created in Google AI Studio.',
    keyUrl: 'https://aistudio.google.com/apikey',
    modelHint: 'This is the cloud Gemini API, separate from the built-in on-device model.',
    request(key, model, system, text) {
      return {
        // The key goes in a header, never in the query string, so it cannot
        // leak through logs or the browser's network history.
        url: 'https://generativelanguage.googleapis.com/v1beta/models/' +
             encodeURIComponent(model) + ':generateContent',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key
        },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text }] }]
        }
      };
    },
    answer(json) {
      const cand = json && json.candidates && json.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      return parts.map((p) => (p && p.text) || '').join(' ');
    },
    error(json) {
      return json && json.error && json.error.message;
    }
  }
};

var QA_DEFAULTS = {
  mode: 'builtin',      // 'builtin' | 'auto' | 'cloud'
  provider: 'anthropic',
  apiKey: '',
  model: ''
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QA_PROVIDERS, QA_DEFAULTS };
}
