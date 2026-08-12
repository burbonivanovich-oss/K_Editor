// Тесты «не переписывать отчёт ради отметки времени».
//
// Аудит 12.08.2026: linkgraph и audit-npa-references меняли свой JSON при
// каждом запуске — только строкой generatedAt. Агент запускает аудит,
// чтобы посмотреть, и получает грязное рабочее дерево; в CI на это же
// ругается проверка «тесты не меняют дерево».
//
// Запуск: node --test scripts/lib/write-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReportIfChanged } from './write-report.mjs';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'write-report-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('первый раз файл создаётся', () => {
  withTmp((dir) => {
    const p = join(dir, 'nested', 'report.json');
    assert.equal(writeReportIfChanged(p, { generatedAt: 'A', totals: { x: 1 } }), true);
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).totals.x, 1);
  });
});

test('те же данные с новой отметкой времени — файл не трогается', () => {
  withTmp((dir) => {
    const p = join(dir, 'report.json');
    writeReportIfChanged(p, { generatedAt: 'A', totals: { x: 1 } });
    const before = readFileSync(p, 'utf8');
    assert.equal(writeReportIfChanged(p, { generatedAt: 'Б', totals: { x: 1 } }), false);
    assert.equal(readFileSync(p, 'utf8'), before, 'отметка не должна перезаписывать файл');
  });
});

test('изменились данные — файл перезаписывается вместе с отметкой', () => {
  withTmp((dir) => {
    const p = join(dir, 'report.json');
    writeReportIfChanged(p, { generatedAt: 'A', totals: { x: 1 } });
    assert.equal(writeReportIfChanged(p, { generatedAt: 'Б', totals: { x: 2 } }), true);
    const now = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(now.totals.x, 2);
    assert.equal(now.generatedAt, 'Б');
  });
});

test('битый прошлый отчёт не роняет запись', () => {
  withTmp((dir) => {
    const p = join(dir, 'report.json');
    writeFileSync(p, '{ это не json');
    assert.equal(writeReportIfChanged(p, { generatedAt: 'A', totals: { x: 1 } }), true);
  });
});

test('свой ключ отметки времени', () => {
  withTmp((dir) => {
    const p = join(dir, 'report.json');
    writeReportIfChanged(p, { checkedAt: 'A', n: 1 }, 'checkedAt');
    assert.equal(writeReportIfChanged(p, { checkedAt: 'Б', n: 1 }, 'checkedAt'), false);
  });
});
