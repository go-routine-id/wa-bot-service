'use strict';

const History = (() => {
  let pollTimer = null;
  let activeId = null;

  function tabActive() {
    const el = document.getElementById('tab-history');
    return !!(el && el.classList.contains('active'));
  }

  function hasActive(list) {
    return list.some((b) => ['pending', 'running'].includes(b.status));
  }

  /** Mulai poll tiap 2 dtk selama tab aktif & masih ada broadcast berjalan; berhenti otomatis. */
  function ensurePolling(list) {
    if (hasActive(list) && tabActive()) {
      if (!pollTimer) pollTimer = setInterval(tick, 2000);
    } else {
      stopPolling();
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function load() {
    try {
      const list = await API.get('/api/broadcasts');
      renderList(list);
      ensurePolling(list);
    } catch (err) {
      document.getElementById('hist-list').innerHTML =
        `<p class="conn-error">${escapeHtml(err.message)}</p>`;
      stopPolling();
    }
  }

  /** Tick polling: refresh list (dan detail bila sedang dibuka), lalu atur lanjut/henti. */
  async function tick() {
    if (!tabActive()) {
      stopPolling();
      return;
    }
    try {
      const list = await API.get('/api/broadcasts');
      renderList(list);
      if (activeId != null) {
        const data = await API.get(`/api/broadcasts/${activeId}`);
        renderDetail(data.broadcast, data.recipients);
      }
      ensurePolling(list);
    } catch (_) {
      // error sementara — biarkan timer lanjut
    }
  }

  function renderList(list) {
    const el = document.getElementById('hist-list');
    if (list.length === 0) {
      el.innerHTML = '<p class="muted">Belum ada broadcast.</p>';
      return;
    }
    const rows = list
      .map(
        (b) => `
      <tr>
        <td>#${b.id}</td>
        <td><span class="badge badge-${b.status}">${b.status}</span></td>
        <td>${b.mode}</td>
        <td>${b.ratePerMinute}/mnt</td>
        <td>${b.sentCount} / ${b.failedCount} / ${b.totalRecipients}</td>
        <td>${b.createdAt}</td>
        <td>
          <button class="btn small" onclick="History.openDetail(${b.id})">Detail</button>
          ${b.failedCount > 0 && ['completed', 'failed'].includes(b.status)
            ? `<button class="btn small" onclick="History.retryFailed(${b.id}, ${b.failedCount})">Retry gagal (${b.failedCount})</button>`
            : ''}
          ${['pending', 'running'].includes(b.status)
            ? `<button class="btn small danger" onclick="History.cancel(${b.id})">Cancel</button>`
            : ''}
        </td>
      </tr>`
      )
      .join('');
    el.innerHTML = `
      <table>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Mode</th><th>Rate</th><th>Sent/Fail/Total</th><th>Dibuat</th><th>Aksi</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function openDetail(id) {
    activeId = id;
    try {
      const data = await API.get(`/api/broadcasts/${id}`);
      renderDetail(data.broadcast, data.recipients);
      ensurePolling([data.broadcast]);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderDetail(b, recipients) {
    const el = document.getElementById('hist-detail');
    const counts = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    recipients.forEach((r) => {
      if (counts[r.status] !== undefined) counts[r.status] += 1;
    });
    const pct = b.totalRecipients ? Math.round((b.sentCount / b.totalRecipients) * 100) : 0;

    const rows = recipients
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.recipientNumber)}</td>
        <td><span class="badge badge-${r.status}">${r.status}</span></td>
        <td>${escapeHtml(r.error || '')}</td>
        <td>${escapeHtml(r.sentAt || '')}</td>
      </tr>`
      )
      .join('');

    const canRetry = counts.failed > 0 && ['completed', 'failed'].includes(b.status);

    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="detail-head">
        <button class="btn small" onclick="History.closeDetail()">← Kembali</button>
        <h3>Broadcast #${b.id} <span class="badge badge-${b.status}">${b.status}</span></h3>
        ${canRetry
          ? `<button class="btn small" onclick="History.retryFailed(${b.id}, ${counts.failed})">Kirim ulang yang gagal (${counts.failed})</button>`
          : ''}
      </div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <p class="muted">
        ${b.sentCount} terkirim · ${b.failedCount} gagal · ${counts.pending + counts.sending} menunggu ·
        ${counts.skipped} di-skip · dari ${b.totalRecipients} total
        ${b.mode === 'queue' ? '' : ' · mode: <strong>parallel</strong>'}
      </p>
      <blockquote>${escapeHtml(b.messageText)}</blockquote>
      ${b.mediaPath ? `<img class="detail-img" src="/uploads/${escapeHtml(b.mediaPath)}">` : ''}
      <table>
        <thead><tr><th>Nomor</th><th>Status</th><th>Error</th><th>Dikirim</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function closeDetail() {
    activeId = null;
    document.getElementById('hist-detail').classList.add('hidden');
    // Timer list tetap dikelola ensurePolling di tick berikutnya
  }

  async function cancel(id) {
    if (!confirm(`Batalkan broadcast #${id}? Sisa recipient akan di-skip.`)) return;
    try {
      await API.post(`/api/broadcasts/${id}/cancel`);
      toast('Broadcast dibatalkan', 'ok');
      await load();
      if (activeId === id) await openDetail(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /** Buat broadcast baru dari recipient yang gagal pada broadcast #id (nomor terkirim tidak di-resend). */
  async function retryFailed(id, count) {
    if (!confirm(`Kirim ulang ${count} pesan yang gagal dari broadcast #${id}? Broadcast baru akan dibuat; nomor yang sudah terkirim tidak dikirim ulang.`)) return;
    try {
      const created = await API.post(`/api/broadcasts/${id}/retry`);
      toast(`Broadcast retry #${created.id} dibuat (${created.totalRecipients} penerima)`, 'ok');
      await load();
      if (activeId === id) await openDetail(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return { load, openDetail, closeDetail, cancel, retryFailed };
})();

window.History = History;
