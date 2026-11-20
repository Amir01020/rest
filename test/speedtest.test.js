'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { measure, downloadOnce, summarize, withCacheBuster } = require('../src/speedtest');

const execFileAsync = promisify(execFile);
const CLI = path.join(__dirname, '..', 'bin', 'speedtest.js');
const PAYLOAD = Buffer.alloc(256 * 1024, 7);

let server;
let base;
let active = 0;
let maxActive = 0;
let hits = 0;

test.before(async () => {
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    hits++;
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => active--);

    if (pathname === '/file') {
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      // отдаём частями с задержкой, чтобы запросы точно пересекались, если бы шли параллельно
      res.write(PAYLOAD.subarray(0, 1000));
      setTimeout(() => res.end(PAYLOAD.subarray(1000)), 20);
    } else if (pathname === '/redirect') {
      res.writeHead(302, { location: '/file' });
      res.end();
    } else if (pathname === '/truncated') {
      res.writeHead(200, { 'content-length': 10_000 });
      res.write(Buffer.alloc(100));
      setTimeout(() => res.destroy(), 10);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('downloadOnce скачивает тело целиком и считает байты', async () => {
  const r = await downloadOnce(`${base}/file`);
  assert.equal(r.status, 200);
  assert.equal(r.bytes, PAYLOAD.length);
  assert.ok(r.durationMs >= r.ttfbMs && r.ttfbMs > 0);
});

test('downloadOnce следует редиректам', async () => {
  const r = await downloadOnce(`${base}/redirect`);
  assert.equal(r.bytes, PAYLOAD.length);
  assert.equal(r.url, `${base}/file`);
});

test('downloadOnce бросает ошибку на не-2xx и на оборванный ответ', async () => {
  await assert.rejects(downloadOnce(`${base}/missing`), /HTTP 404/);
  await assert.rejects(downloadOnce(`${base}/truncated`));
});

test('measure делает N запросов строго последовательно', async () => {
  hits = 0;
  maxActive = 0;
  const seen = [];
  const { results, summary } = await measure(`${base}/file`, { count: 10, onResult: (r) => seen.push(r.index) });

  assert.equal(hits, 10);
  assert.equal(maxActive, 1);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(results.length, 10);
  assert.equal(summary.succeeded, 10);
  assert.equal(summary.totalBytes, PAYLOAD.length * 10);
});

test('measure с keep-alive переиспользует соединение', async () => {
  const { summary } = await measure(`${base}/file`, { count: 3, keepAlive: true });
  assert.equal(summary.succeeded, 3);
});

test('measure продолжает после ошибок и отражает их в сводке', async () => {
  const { summary } = await measure(`${base}/missing`, { count: 3 });
  assert.equal(summary.failed, 3);
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.mbitPerSec, 0);
});

test('summarize корректно считает среднее и скорость', () => {
  const s = summarize([
    { ok: true, bytes: 1_000_000, durationMs: 1000, ttfbMs: 100 },
    { ok: true, bytes: 1_000_000, durationMs: 3000, ttfbMs: 300 },
    { ok: false, error: 'x', durationMs: 50 },
  ]);
  assert.equal(s.totalBytes, 2_000_000);
  assert.equal(s.avgTimeMs, 2000);
  assert.equal(s.avgTtfbMs, 200);
  assert.equal(s.bytesPerSec, 500_000); // 2 МБ за 4 с
  assert.equal(s.mbitPerSec, 4); // 500 000 Б/с × 8 = 4 Мбит/с
  assert.equal(s.mbytePerSec, 0.5);
  assert.equal(s.failed, 1);
});

test('withCacheBuster сохраняет исходные параметры и добавляет уникальный', () => {
  const a = new URL(withCacheBuster('https://example.com/img.jpg?w=100'));
  const b = new URL(withCacheBuster('https://example.com/img.jpg?w=100'));
  assert.equal(a.searchParams.get('w'), '100');
  assert.notEqual(a.searchParams.get('_speedtest'), b.searchParams.get('_speedtest'));
});

test('CLI: --json выдаёт корректную сводку', async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, `${base}/file`, '-n', '3', '--json']);
  const data = JSON.parse(stdout);
  assert.equal(data.results.length, 3);
  assert.equal(data.summary.totalBytes, PAYLOAD.length * 3);
});

test('CLI: при некорректных аргументах код выхода 2', async () => {
  await assert.rejects(execFileAsync(process.execPath, [CLI, 'not-a-url']), (err) => err.code === 2);
  await assert.rejects(execFileAsync(process.execPath, [CLI, `${base}/file`, '-n', '0']), (err) => err.code === 2);
});

test('CLI: при ошибках запросов код выхода 1', async () => {
  await assert.rejects(execFileAsync(process.execPath, [CLI, `${base}/missing`, '-n', '2']), (err) => err.code === 1);
});
