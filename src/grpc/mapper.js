'use strict';

/**
 * Terjemahan bentuk domain ↔ bentuk proto.
 *
 * Dipisah dari handler supaya satu tempat saja yang tahu bentuk kawatnya.
 * Nilai null/undefined dari DB dijadikan string kosong: proto3 tidak punya
 * konsep null untuk scalar, dan mengirim undefined membuat @grpc/grpc-js
 * melempar saat serialisasi.
 */

const teks = (v) => (v === null || v === undefined ? '' : String(v));
const angka = (v) => (v === null || v === undefined ? 0 : Number(v));

const MODE = { queue: 'BROADCAST_MODE_QUEUE', parallel: 'BROADCAST_MODE_PARALLEL' };
const MODE_BALIK = { BROADCAST_MODE_QUEUE: 'queue', BROADCAST_MODE_PARALLEL: 'parallel' };

const STATUS = {
  pending: 'BROADCAST_STATUS_PENDING',
  running: 'BROADCAST_STATUS_RUNNING',
  completed: 'BROADCAST_STATUS_COMPLETED',
  failed: 'BROADCAST_STATUS_FAILED',
  cancelled: 'BROADCAST_STATUS_CANCELLED',
};

const STATUS_PENERIMA = {
  pending: 'RECIPIENT_STATUS_PENDING',
  sending: 'RECIPIENT_STATUS_SENDING',
  sent: 'RECIPIENT_STATUS_SENT',
  failed: 'RECIPIENT_STATUS_FAILED',
  skipped: 'RECIPIENT_STATUS_SKIPPED',
};

function broadcastKeProto(b) {
  return {
    id: angka(b.id),
    session_id: teks(b.sessionId),
    session_name: teks(b.sessionName),
    mode: MODE[b.mode] || 'BROADCAST_MODE_UNSPECIFIED',
    status: STATUS[b.status] || 'BROADCAST_STATUS_UNSPECIFIED',
    template_id: angka(b.templateId),
    message_text: teks(b.messageText),
    media_path: teks(b.mediaPath),
    total_recipients: angka(b.totalRecipients),
    sent_count: angka(b.sentCount),
    failed_count: angka(b.failedCount),
    error: teks(b.error),
    created_at: teks(b.createdAt),
    started_at: teks(b.startedAt),
    finished_at: teks(b.finishedAt),
  };
}

function penerimaKeProto(r) {
  return {
    id: angka(r.id),
    number: teks(r.recipientNumber),
    status: STATUS_PENERIMA[r.status] || 'RECIPIENT_STATUS_UNSPECIFIED',
    error: teks(r.error),
    sent_at: teks(r.sentAt),
  };
}

function sesiKeProto(s) {
  return {
    id: teks(s.id),
    name: teks(s.name),
    status: teks(s.status),
    connected: s.status === 'connected',
    phone_number: teks(s.userInfo && s.userInfo.number),
    display_name: teks(s.userInfo && s.userInfo.name),
  };
}

/** Body untuk broadcastService.create — dari request proto. */
function createRequestKeBody(req) {
  const body = {
    sessionId: req.session_id,
    mode: MODE_BALIK[req.mode] || '',
    recipients: req.recipients,
  };
  // oneof: proto-loader menaruh nama field yang terisi di properti `pesan`.
  if (req.pesan === 'template_id') body.templateId = req.template_id;
  if (req.pesan === 'message_text') body.messageText = req.message_text;
  if (req.media_path) body.mediaPath = req.media_path;
  if (req.kecepatan === 'delay_seconds') body.delaySeconds = req.delay_seconds;
  if (req.kecepatan === 'rate_per_minute') body.ratePerMinute = req.rate_per_minute;
  return body;
}

module.exports = { broadcastKeProto, penerimaKeProto, sesiKeProto, createRequestKeBody };
