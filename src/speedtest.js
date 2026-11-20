'use strict';

const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

const MAX_REDIRECTS = 5;
const USER_AGENT = 'internet-speed-test/1.0 (+node)';

/**
 * Выполняет один GET-запрос и возвращает объект ответа (поток тела ещё не прочитан).
 */
function get(url, { agents, timeoutMs, headers }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!client) {
      reject(new Error(`Неподдерживаемый протокол: ${url.protocol}`));
      return;
    }

    // Агент выбирается по протоколу текущего URL: редирект может сменить http на https.
    const agent = agents[url.protocol] || false;
    const req = client.get(url, { agent, headers }, resolve);
    req.on('error', reject);
    // Таймаут бездействия сокета: срабатывает, если данных нет дольше timeoutMs
    // (и во время установки соединения, и во время скачивания тела).
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Таймаут: нет данных дольше ${timeoutMs} мс`));
    });
  });
}

/**
 * Скачивает ресурс целиком и замеряет время.
 * Время считается от отправки запроса до получения последнего байта тела
 * (включая DNS, TCP/TLS-рукопожатие и редиректы).
 *
 * @returns {Promise<{url: string, status: number, bytes: number, ttfbMs: number, durationMs: number}>}
 */
async function downloadOnce(rawUrl, { timeoutMs = 30_000, agents = {}, headers = {} } = {}) {
  const requestHeaders = {
    'user-agent': USER_AGENT,
    // Просим не сжимать ответ, чтобы считать реальные байты, пришедшие по сети.
    'accept-encoding': 'identity',
    ...headers,
  };

  let url = new URL(rawUrl);
  const start = performance.now();
  let res;

  for (let hop = 0; ; hop++) {
    res = await get(url, { agents, timeoutMs, headers: requestHeaders });
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (!isRedirect) break;

    res.resume(); // освобождаем сокет
    if (hop >= MAX_REDIRECTS) throw new Error(`Слишком много редиректов (> ${MAX_REDIRECTS})`);
    url = new URL(res.headers.location, url);
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim());
  }

  const ttfbMs = performance.now() - start;
  let bytes = 0;
  // Если соединение оборвётся посреди тела, итератор выбросит ошибку.
  for await (const chunk of res) bytes += chunk.length;
  const durationMs = performance.now() - start;

  const expected = Number(res.headers['content-length']);
  if (Number.isFinite(expected) && bytes !== expected) {
    throw new Error(`Ответ получен не полностью: ${bytes} из ${expected} байт`);
  }

  return { url: url.href, status: res.statusCode, bytes, ttfbMs, durationMs };
}

/** Добавляет к URL уникальный параметр, чтобы обойти кэш прокси/CDN. */
function withCacheBuster(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('_speedtest', randomUUID());
  return url.href;
}

/**
 * Считает итоговую статистику по результатам запросов.
 * Скорость = суммарно скачанные байты / суммарное время запросов.
 */
function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const durations = ok.map((r) => r.durationMs);
  const totalBytes = ok.reduce((s, r) => s + r.bytes, 0);
  const totalTimeMs = durations.reduce((s, d) => s + d, 0);
  const bytesPerSec = totalTimeMs > 0 ? totalBytes / (totalTimeMs / 1000) : 0;

  return {
    requests: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    totalBytes,
    totalTimeMs,
    avgTimeMs: ok.length ? totalTimeMs / ok.length : 0,
    minTimeMs: ok.length ? Math.min(...durations) : 0,
    maxTimeMs: ok.length ? Math.max(...durations) : 0,
    avgTtfbMs: ok.length ? ok.reduce((s, r) => s + r.ttfbMs, 0) / ok.length : 0,
    bytesPerSec,
    mbitPerSec: (bytesPerSec * 8) / 1e6,
    mbytePerSec: bytesPerSec / 1e6,
  };
}

/**
 * Делает `count` последовательных запросов к `url` и возвращает результаты и сводку.
 * Каждый следующий запрос начинается только после полного получения предыдущего ответа.
 */
async function measure(url, { count = 10, timeoutMs = 30_000, cacheBust = false, keepAlive = false, onResult } = {}) {
  // Без keep-alive каждый запрос открывает новое соединение, и рукопожатие входит в замер.
  const agents = keepAlive
    ? {
        'http:': new http.Agent({ keepAlive: true, maxSockets: 1 }),
        'https:': new https.Agent({ keepAlive: true, maxSockets: 1 }),
      }
    : {};
  const headers = cacheBust ? { 'cache-control': 'no-cache', pragma: 'no-cache' } : {};

  const results = [];
  try {
    for (let i = 0; i < count; i++) {
      const target = cacheBust ? withCacheBuster(url) : url;
      const started = performance.now();
      let result;
      try {
        result = { index: i + 1, ok: true, ...(await downloadOnce(target, { timeoutMs, agents, headers })) };
      } catch (err) {
        result = { index: i + 1, ok: false, error: err.message, durationMs: performance.now() - started };
      }
      results.push(result);
      if (onResult) onResult(result);
    }
  } finally {
    for (const agent of Object.values(agents)) agent.destroy();
  }

  return { results, summary: summarize(results) };
}

module.exports = { measure, downloadOnce, summarize, withCacheBuster };
