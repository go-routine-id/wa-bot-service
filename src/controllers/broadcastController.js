'use strict';

const broadcastService = require('../services/broadcastService');
const { HttpError } = require('../utils/httpError');

function parsePagination(query) {
  const limit = Math.min(Math.max(Number.parseInt(query?.limit ?? '50', 10) || 50, 1), 500);
  const offset = Math.max(Number.parseInt(query?.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}

/** Organisasi pemanggil — selalu ada, dipasang middleware auth. */
const org = (req) => req.auth.orgId;

/**
 * ?scope=all membuka pandangan lintas organisasi — khusus akun platform admin
 * (izin '*'). Gerbang ada DI SINI, bukan di service: non-admin yang memaksa
 * param itu harus menerima 403, bukan diam-diam diperlakukan sebagai request
 * biasa (fallback senyap = kebocoran model izin).
 */
function assertScopeAllAllowed(req) {
  const permissions = req.auth?.permissions;
  if (!Array.isArray(permissions) || !permissions.includes('*')) {
    throw new HttpError(403, 'scope=all khusus akun dengan izin platform admin (*)');
  }
}

const broadcastController = {
  create(req, res) {
    // Sumber pembuatan: UI web mengirim X-Client: web; selain itu 'api'.
    // Nilai di-whitelist di sini — header bebas tak boleh menulis label seenaknya.
    const source = req.get('x-client') === 'web' ? 'web' : 'api';
    const data = broadcastService.create(req.body, org(req), {
      source,
      accountId: req.auth.accountId ?? null,
    });
    res.status(201).json({ data });
  },

  list(req, res) {
    const { limit, offset } = parsePagination(req.query);
    const allOrgs = req.query?.scope === 'all';
    if (allOrgs) assertScopeAllAllowed(req);
    res.json({ data: broadcastService.list({ limit, offset }, org(req), { allOrgs }) });
  },

  detail(req, res) {
    const allOrgs = req.query?.scope === 'all';
    if (allOrgs) assertScopeAllAllowed(req);
    const data = broadcastService.getDetail(Number(req.params.id), org(req), { allOrgs });
    res.json({ data });
  },

  cancel(req, res) {
    const data = broadcastService.cancel(Number(req.params.id), org(req));
    res.json({ data });
  },

  /** Tambah nomor tujuan: body { recipients }. Hanya broadcast berstatus 'pending'. */
  addRecipients(req, res) {
    const data = broadcastService.addRecipients(Number(req.params.id), req.body?.recipients, org(req));
    res.status(201).json({ data });
  },

  /**
   * Hapus satu nomor tujuan. Recipient yang sudah 'sent' ditolak 409 kecuali
   * query ?confirmSent=true (konfirmasi eksplisit user di UI).
   */
  removeRecipient(req, res) {
    const data = broadcastService.removeRecipient(
      Number(req.params.id),
      Number(req.params.recipientId),
      { confirmSent: req.query?.confirmSent === 'true' },
      org(req)
    );
    res.json({ data });
  },

  retry(req, res) {
    const source = req.get('x-client') === 'web' ? 'web' : 'api';
    const data = broadcastService.retry(
      Number(req.params.id),
      { sessionId: req.body?.sessionId },
      org(req),
      { source, accountId: req.auth.accountId ?? null }
    );
    res.status(201).json({ data });
  },
};

module.exports = broadcastController;
