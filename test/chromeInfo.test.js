'use strict';

/**
 * Utils diagnostik proses chrome (src/utils/chromeProcess.js).
 *
 * parseEtime/parsePsRow dipisah dari pembacaan ps supaya bisa diuji tanpa
 * proses nyata; readProcess diuji lewat PID proses test itu sendiri dan proses
 * anak yang baru di-mati-kan.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseEtime, parsePsRow, readProcess } = require('../src/utils/chromeProcess');

test('parseEtime: detik, menit, jam, hari', () => {
  assert.strictEqual(parseEtime('45'), 45);
  assert.strictEqual(parseEtime('22:33'), 22 * 60 + 33);
  assert.strictEqual(parseEtime('03:22:33'), 3 * 3600 + 22 * 60 + 33);
  assert.strictEqual(parseEtime('21-03:22:33'), 21 * 86400 + 3 * 3600 + 22 * 60 + 33);
  assert.strictEqual(parseEtime(''), null);
  assert.strictEqual(parseEtime('abc'), null);
  assert.strictEqual(parseEtime(null), null);
});

test('parsePsRow: satu baris ps → metrik; baris rusak → null', () => {
  assert.deepStrictEqual(parsePsRow('  21-03:22:33  28.4 319872'), {
    ageSec: 21 * 86400 + 3 * 3600 + 22 * 60 + 33,
    cpuPercent: 28.4,
    rssMb: 319872 / 1024,
  });
  assert.deepStrictEqual(parsePsRow('   05:12   1.5 1024'), {
    ageSec: 5 * 60 + 12,
    cpuPercent: 1.5,
    rssMb: 1,
  });
  assert.strictEqual(parsePsRow(''), null);
  assert.strictEqual(parsePsRow('garbage line'), null);
});

test('readProcess: proses sendiri → alive dengan metrik', async () => {
  const me = await readProcess(process.pid);
  assert.strictEqual(me.alive, true);
  assert.strictEqual(typeof me.ageSec, 'number');
  assert.ok(me.ageSec >= 0);
  assert.ok(Number.isFinite(me.cpuPercent));
  assert.ok(me.rssMb > 0);
});

test('readProcess: proses yang baru mati → alive:false', async () => {
  const { once } = require('node:events');
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const pid = child.pid;
  child.kill();
  await once(child, 'exit');
  const info = await readProcess(pid);
  assert.strictEqual(info.alive, false);
});
