'use strict';

/**
 * Pembaca metrik proses lewat ps (tersedia di Linux & macOS). Dipakai endpoint
 * diagnostik chrome GET /api/sessions/:id/chrome — backend sudah tahu PID
 * chrome-nya dari handle puppeteer (client.pupBrowser.process().pid); file ini
 * hanya mengubah PID itu menjadi metrik yang bisa ditampilkan.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ps praktis instan; batas ini cuma pagar bila environment aneh membuatnya hang.
const PS_TIMEOUT_MS = 3000;

/**
 * etime ps → detik. Bentuk yang diterima: "45", "22:33", "03:22:33",
 * "21-03:22:33" (hari-jam:menit:detik). Input lain → null.
 */
function parseEtime(etime) {
  const s = String(etime ?? '').trim();
  const full = s.match(/^(?:(\d+)-)?(\d{1,3}):(\d{1,2}):(\d{2})$/);
  if (full) {
    return (
      Number(full[1] || 0) * 86400 +
      Number(full[2]) * 3600 +
      Number(full[3]) * 60 +
      Number(full[4])
    );
  }
  const mmss = s.match(/^(\d{1,2}):(\d{2})$/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const sec = s.match(/^(\d+)$/);
  return sec ? Number(sec[1]) : null;
}

/**
 * Satu baris keluaran `ps -o etime=,%cpu=,rss= -p <pid>` → metrik.
 * %cpu ps adalah rata-rata lifetime (bukan instantaneous) — pas untuk diagnosis
 * "chrome ini macet atau memang sibuk". rss ps dalam KB → MB. Baris kosong /
 * tidak bisa diparse → null.
 */
function parsePsRow(line) {
  const m = String(line ?? '').trim().match(/^(\S+)\s+(\S+)\s+(\S+)$/);
  if (!m) return null;
  const ageSec = parseEtime(m[1]);
  const cpuPercent = Number(m[2]);
  const rssMb = Number(m[3]) / 1024;
  if (ageSec === null || !Number.isFinite(cpuPercent) || !Number.isFinite(rssMb)) return null;
  return { ageSec, cpuPercent, rssMb };
}

/**
 * Metrik proses untuk sebuah PID. ps keluar dengan kode 1 bila tidak ada proses
 * dengan PID itu (Linux & macOS) → { alive: false }. Kegagalan lain (ps tak
 * ada, timeout) juga dilaporkan sebagai { alive: false } — ini endpoint
 * diagnostik; lebih baik menjawab "tidak diketahui hidup" daripada menggantung
 * request-nya.
 */
async function readProcess(pid) {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'etime=,%cpu=,rss=', '-p', String(pid)],
      {
        timeout: PS_TIMEOUT_MS,
        // %cpu ps mencetak desimal mengikuti LC_NUMERIC host — di locale koma
        // (mis. id_ID) Number("28,4") jadi NaN dan parser gagal. Pin ke C.
        env: { ...process.env, LC_ALL: 'C' },
      }
    );
    const row = parsePsRow(stdout.split('\n').find((l) => l.trim()));
    return row ? { alive: true, ...row } : { alive: false };
  } catch (_) {
    return { alive: false };
  }
}

module.exports = { parseEtime, parsePsRow, readProcess };
