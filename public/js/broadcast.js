'use strict';

const Broadcast = (() => {
  let templatesCache = [];

  function toggleSource() {
    const source = document.querySelector('input[name="bc-source"]:checked').value;
    document.getElementById('bc-template-wrap').classList.toggle('hidden', source !== 'template');
    document.getElementById('bc-direct-wrap').classList.toggle('hidden', source !== 'direct');
    if (source === 'template') previewTemplate();
  }

  async function loadTemplates() {
    try {
      templatesCache = await API.get('/api/templates');
      const sel = document.getElementById('bc-template');
      sel.innerHTML = templatesCache
        .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}${t.mediaPath ? ' 🖼️' : ''}</option>`)
        .join('');
      previewTemplate();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function previewTemplate() {
    const sel = document.getElementById('bc-template');
    const t = templatesCache.find((x) => x.id === Number(sel.value));
    const el = document.getElementById('bc-template-preview');
    el.innerHTML = t
      ? `<blockquote>${escapeHtml(t.textContent)}</blockquote>` +
        (t.mediaPath ? '<p>🖼️ Template ini menyertakan gambar.</p>' : '')
      : '<p>—</p>';
  }

  async function submit() {
    const source = document.querySelector('input[name="bc-source"]:checked').value;
    const recipients = document.getElementById('bc-recipients').value.trim();
    const ratePerMinute = Number(document.getElementById('bc-rate').value);
    const mode = document.getElementById('bc-mode').value;

    if (!recipients) {
      toast('Nomor tujuan wajib diisi', 'error');
      return;
    }

    try {
      const body = { mode, ratePerMinute, recipients };

      if (source === 'template') {
        body.templateId = Number(document.getElementById('bc-template').value);
      } else {
        const message = document.getElementById('bc-message').value.trim();
        if (!message) {
          toast('Isi pesan broadcast terlebih dahulu', 'error');
          return;
        }
        body.messageText = message;
        const fileInput = document.getElementById('bc-image');
        if (fileInput.files && fileInput.files[0]) {
          const fd = new FormData();
          fd.append('image', fileInput.files[0]);
          const uploaded = await API.upload('/api/media', fd);
          body.mediaPath = uploaded.mediaPath;
        }
      }

      const created = await API.post('/api/broadcasts', body);
      toast(`Broadcast #${created.id} dibuat — status: ${created.status}`, 'ok');
      // Reset form
      document.getElementById('bc-recipients').value = '';
      document.getElementById('bc-message').value = '';
      document.getElementById('bc-image').value = '';
      // Buka tab history
      App.showTab('history');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return { toggleSource, loadTemplates, previewTemplate, submit };
})();

window.Broadcast = Broadcast;
