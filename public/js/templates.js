'use strict';

const Templates = (() => {
  let editingId = null;
  let currentMediaPath = null;

  async function load() {
    try {
      const templates = await API.get('/api/templates');
      renderList(templates);
      Broadcast.loadTemplates(); // jaga-jaga select di tab create tetap fresh
    } catch (err) {
      document.getElementById('tpl-list').innerHTML =
        `<p class="conn-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderList(templates) {
    const el = document.getElementById('tpl-list');
    if (templates.length === 0) {
      el.innerHTML = '<p class="muted">Belum ada template.</p>';
      return;
    }
    const rows = templates
      .map(
        (t) => `
      <tr>
        <td>${escapeHtml(t.name)}</td>
        <td>${escapeHtml((t.textContent || '').slice(0, 80))}</td>
        <td>${t.mediaPath ? '🖼️ ada' : '—'}</td>
        <td>${t.updatedAt}</td>
        <td>
          <button class="btn small" onclick="Templates.edit(${t.id})">Edit</button>
          <button class="btn small danger" onclick="Templates.remove(${t.id})">Hapus</button>
        </td>
      </tr>`
      )
      .join('');
    el.innerHTML = `
      <table>
        <thead><tr><th>Nama</th><th>Isi pesan</th><th>Gambar</th><th>Diupdate</th><th>Aksi</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function clearForm() {
    editingId = null;
    currentMediaPath = null;
    document.getElementById('tpl-id').value = '';
    document.getElementById('tpl-name').value = '';
    document.getElementById('tpl-text').value = '';
    document.getElementById('tpl-image').value = '';
    document.getElementById('tpl-image-preview').innerHTML = '';
    document.getElementById('tpl-form-title').textContent = 'Buat Template Baru';
    document.getElementById('tpl-cancel-edit').classList.add('hidden');
  }

  async function edit(id) {
    try {
      const t = await API.get(`/api/templates/${id}`);
      editingId = id;
      currentMediaPath = t.mediaPath;
      document.getElementById('tpl-id').value = t.id;
      document.getElementById('tpl-name').value = t.name;
      document.getElementById('tpl-text').value = t.textContent;
      document.getElementById('tpl-image').value = '';
      document.getElementById('tpl-image-preview').innerHTML = t.mediaPath
        ? `<img class="preview-img" src="/uploads/${escapeHtml(t.mediaPath)}">`
        : '';
      document.getElementById('tpl-form-title').textContent = `Edit Template #${t.id}`;
      document.getElementById('tpl-cancel-edit').classList.remove('hidden');
      document.getElementById('tpl-name').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function save() {
    const id = Number(document.getElementById('tpl-id').value) || null;
    const name = document.getElementById('tpl-name').value.trim();
    const textContent = document.getElementById('tpl-text').value.trim();
    const fileInput = document.getElementById('tpl-image');

    if (!name || !textContent) {
      toast('Nama dan isi pesan wajib diisi', 'error');
      return;
    }

    try {
      let mediaPath = currentMediaPath;
      if (fileInput.files && fileInput.files[0]) {
        const fd = new FormData();
        fd.append('image', fileInput.files[0]);
        const uploaded = await API.upload('/api/media', fd);
        mediaPath = uploaded.mediaPath;
        // Media lama diganti → biarkan server membersihkan bila tidak dipakai
        if (currentMediaPath && currentMediaPath !== mediaPath) {
          await API.del('/api/media', { mediaPath: currentMediaPath }).catch(() => {});
        }
      }

      const body = { name, textContent, mediaPath };
      if (id) {
        await API.put(`/api/templates/${id}`, body);
        toast('Template diperbarui', 'ok');
      } else {
        await API.post('/api/templates', body);
        toast('Template dibuat', 'ok');
      }
      clearForm();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function remove(id) {
    if (!confirm(`Hapus template #${id}?`)) return;
    try {
      await API.del(`/api/templates/${id}`);
      toast('Template dihapus', 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return { load, edit, save, remove, clearForm };
})();

window.Templates = Templates;
