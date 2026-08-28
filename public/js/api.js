'use strict';

/** Fetch wrapper + helper kecil. Diekspos ke window supaya bisa dipakai semua modul. */
const API = (() => {
  async function request(method, url, body, isMultipart = false) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      if (isMultipart) {
        opts.body = body;
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data !== undefined ? json.data : json;
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    put: (url, body) => request('PUT', url, body),
    del: (url, body) => request('DELETE', url, body),
    upload: (url, formData) => request('POST', url, formData, true),
  };
})();

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

window.API = API;
