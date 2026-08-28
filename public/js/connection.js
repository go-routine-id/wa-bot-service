'use strict';

const Connection = (() => {
  let timer = null;

  function start() {
    if (timer) return;
    timer = setInterval(refresh, 2500);
  }

  async function refresh() {
    const section = document.getElementById('tab-connection');
    if (!section || !section.classList.contains('active')) return;
    try {
      render(await API.get('/api/connection/status'));
    } catch (err) {
      document.getElementById('conn-content').innerHTML =
        `<div class="conn-box"><p class="conn-error">${escapeHtml(err.message)}</p></div>`;
    }
  }

  function render(s) {
    const el = document.getElementById('conn-content');

    if (s.connected) {
      const name = s.userInfo?.name ? escapeHtml(s.userInfo.name) : '(tanpa nama)';
      const number = s.userInfo?.number ? escapeHtml(s.userInfo.number) : '?';
      el.innerHTML = `
        <div class="conn-box">
          <p class="conn-connected">✅ WhatsApp terhubung</p>
          <p class="muted">Terhubung sebagai <strong>${name}</strong> (${number})</p>
          <button class="btn" onclick="Connection.logout()">Logout</button>
        </div>`;
      return;
    }

    if (s.hasQr) {
      el.innerHTML = `
        <div class="conn-box">
          <h3>Scan QR ini dengan WhatsApp di HP kamu</h3>
          <p class="muted">Buka WhatsApp → Setelan → Perangkat tertaut → Tautkan perangkat</p>
          <img class="qr" src="${s.qrDataUrl}" alt="QR Code">
          <p class="muted">QR diperbarui otomatis. Status: menunggu scan…</p>
        </div>`;
      return;
    }

    if (s.status === 'auth_failure') {
      el.innerHTML = `
        <div class="conn-box">
          <p class="conn-error">⚠️ Autentikasi gagal: ${escapeHtml(s.lastError || '')}</p>
          <button class="btn" onclick="Connection.rescan()">Scan ulang QR</button>
        </div>`;
      return;
    }

    if (s.status === 'disconnected') {
      el.innerHTML = `
        <div class="conn-box">
          <p class="conn-error">⚠️ WhatsApp terputus${s.lastError ? ': ' + escapeHtml(s.lastError) : ''}</p>
          <button class="btn" onclick="Connection.rescan()">Hubungkan ulang</button>
        </div>`;
      return;
    }

    // uninitialized / connecting
    el.innerHTML = `<div class="conn-box"><p class="muted">Menghubungkan ke WhatsApp…</p></div>`;
  }

  async function rescan() {
    try {
      await API.post('/api/connection/rescan');
      toast('Memulai ulang koneksi…', 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function logout() {
    if (!confirm('Yakin logout dari WhatsApp? Kamu harus scan QR lagi untuk masuk.')) return;
    try {
      await API.post('/api/connection/logout');
      toast('Logout berhasil', 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return { start, refresh, rescan, logout };
})();

window.Connection = Connection;
