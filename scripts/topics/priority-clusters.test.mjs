import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIORITY_CLUSTERS, PRIORITY_WEIGHT, priorityMultiplier } from './priority-clusters.mjs';

test('priorityMultiplier: кластеры Контур.Маркета получают вес PRIORITY_WEIGHT', () => {
  for (const cluster of PRIORITY_CLUSTERS) {
    assert.equal(priorityMultiplier(cluster), PRIORITY_WEIGHT, `ожидался приоритет для ${cluster}`);
  }
});

test('priorityMultiplier: непрофильные кластеры (законодательство/бухгалтерия) получают вес 1', () => {
  for (const cluster of ['nalogi', 'otchetnost-edo', 'kadry', 'buhgalteriya', 'zakonodatelstvo']) {
    assert.equal(priorityMultiplier(cluster), 1, `не ожидался приоритет для ${cluster}`);
  }
});

test('priorityMultiplier: null/undefined кластер не роняет и не приоритизирует', () => {
  assert.equal(priorityMultiplier(null), 1);
  assert.equal(priorityMultiplier(undefined), 1);
  assert.equal(priorityMultiplier(''), 1);
});

test('PRIORITY_CLUSTERS: содержит именно список редактора (касса/оборудование/маркировка/эквайринг/ЕГАИС/ОФД/Меркурий/общепит/розница/аптека/ТС ПИоТ)', () => {
  assert.deepEqual(
    [...PRIORITY_CLUSTERS].sort(),
    [
      'apteka', 'egais', 'ekvairing', 'horeca', 'kkt', 'markirovka',
      'markirovka-2026', 'merkuriy', 'ofd-fn', 'oborudovanie', 'roznica', 'ts-piot',
    ].sort(),
  );
});
