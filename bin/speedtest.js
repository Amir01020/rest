#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { measure } = require('../src/speedtest');

const HELP = `
Замер скорости скачивания по HTTP(S).

Использование:
  node bin/speedtest.js <url> [опции]

Опции:
  -n, --count <N>     количество последовательных запросов (по умолчанию 10)
  -t, --timeout <с>   таймаут бездействия соединения в секундах (по умолчанию 30)
      --cache-bust    добавлять к URL уникальный параметр и no-cache, чтобы обойти кэш CDN
      --keep-alive    переиспользовать TCP/TLS-соединение между запросами
      --json          вывести результат в формате JSON
  -h, --help          показать эту справку

Пример:
  node bin/speedtest.js https://proof.ovh.net/files/10Mb.dat -n 5
`.trim();

const nf = (digits) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmt0 = nf(0);
const fmt2 = nf(2);

function formatBytes(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${i === 0 ? fmt0.format(value) : fmt2.format(value)} ${units[i]}`;
}

const ms = (v) => `${fmt0.format(v)} мс`;
const mbit = (bytes, durationMs) => (durationMs > 0 ? (bytes * 8) / 1e6 / (durationMs / 1000) : 0);

function fail(message) {
  process.stderr.write(`Ошибка: ${message}\n\n${HELP}\n`);
  process.exit(2);
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        count: { type: 'string', short: 'n', default: '10' },
        timeout: { type: 'string', short: 't', default: '30' },
        'cache-bust': { type: 'boolean', default: false },
        'keep-alive': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (positionals.length !== 1) fail('нужно указать ровно один URL');

  let url;
  try {
    url = new URL(positionals[0]);
  } catch {
    fail(`некорректный URL: ${positionals[0]}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('поддерживаются только http:// и https://');

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) fail('--count должен быть целым числом >= 1');
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) fail('--timeout должен быть положительным числом');

  return {
    url: url.href,
    count,
    timeoutMs: timeout * 1000,
    cacheBust: values['cache-bust'],
    keepAlive: values['keep-alive'],
    json: values.json,
  };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const log = opts.json ? () => {} : (line = '') => process.stdout.write(`${line}\n`);

  log(`URL:      ${opts.url}`);
  log(`Запросов: ${opts.count} (последовательно)\n`);

  const width = String(opts.count).length;
  const { results, summary } = await measure(opts.url, {
    count: opts.count,
    timeoutMs: opts.timeoutMs,
    cacheBust: opts.cacheBust,
    keepAlive: opts.keepAlive,
    onResult(r) {
      const n = `#${String(r.index).padStart(width)}`;
      if (!r.ok) {
        log(`  ${n}  ОШИБКА  ${r.error}`);
        return;
      }
      log(
        `  ${n}  ${String(r.status)}  ${formatBytes(r.bytes).padStart(11)}  ` +
          `${ms(r.durationMs).padStart(10)}  (TTFB ${ms(r.ttfbMs)})  ` +
          `${fmt2.format(mbit(r.bytes, r.durationMs))} Мбит/с`
      );
    },
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ url: opts.url, results, summary }, null, 2)}\n`);
  } else {
    log('\nИтого');
    log(`  Успешных запросов:      ${summary.succeeded} из ${summary.requests}`);
    if (summary.succeeded > 0) {
      log(`  Скачано всего:          ${formatBytes(summary.totalBytes)} (${fmt0.format(summary.totalBytes)} байт)`);
      log(`  Среднее время запроса:  ${ms(summary.avgTimeMs)} (мин ${ms(summary.minTimeMs)}, макс ${ms(summary.maxTimeMs)})`);
      log(`  Среднее время до 1-го байта (TTFB): ${ms(summary.avgTtfbMs)}`);
      log(`  Скорость скачивания:    ${fmt2.format(summary.mbitPerSec)} Мбит/с (${fmt2.format(summary.mbytePerSec)} МБ/с)`);
    }
  }

  if (summary.failed > 0) {
    process.stderr.write(`\nВнимание: ${summary.failed} из ${summary.requests} запросов завершились ошибкой.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`Ошибка: ${err.message}\n`);
  process.exit(1);
});
