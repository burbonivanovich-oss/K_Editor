// Точный порядок рутины B: приёмка → маркер → оценка → release.
//
// Аудит нашёл здесь расхождение путей выпуска. Шаг 6а `cycle-listen.md`
// просил при переносе тела из Google Doc поставить `draft: false`, а
// семью строками ниже тот же файл утверждал, что снимать флаг может
// только release-скрипт. Побеждала первая инструкция: release видел уже
// снятый `draft`, отвечал `ALREADY_RELEASED` кодом 0 и не проверял ни
// приёмку, ни НПА, ни ссылки, ни SEO, ни AI, ни оценку, ни факчек.
// Штатный выпуск шёл мимо гейта целиком.
//
// Исправлено с двух сторон: из инструкции убрано ручное снятие флага, а
// release проверяет статью в любом состоянии. Тест держит обе стороны —
// он гоняет настоящую цепочку команд, а не их описание.
//
// Запуск: node --test scripts/routine-b-order.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAnalysis as writeAnalysisFixture } from './analysis-fixture.mjs';
import { textUnits } from './factcheck/classify.mjs';
import { draftContract } from './factcheck/content-contract.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const SLUG = '2026-08-13-routine-b';

const today = () => new Date().toISOString().slice(0, 10);

const FM = (draft) => ['---', 'title: "Тестовая статья про ТС ПИоТ и штрафы"',
  'description: "Описание статьи достаточной длины для прохождения проверки SEO, не короче ста символов и не длиннее ста шестидесяти пяти символов ровно."',
  `draft: ${draft}`, 'pubDate: "2026-01-01"', 'reviewDate: "2026-07-01"',
  'categories:', '  - ts-piot', 'tags:', '  - тег1', '  - тег2', '  - тег3', '  - тег4',
  'seo:', '  keywords:', '    - тестовый ключ', '---'].join('\n');

/* Тело должно проходить гейты целиком: релиз больше не держит своего
 * списка проверок, он зовёт `gates.mjs`. Объём, три разные внутренние
 * ссылки и frontmatter стали его условиями — это цена того, что список
 * у релиза и у гейта теперь один. Ни чисел, ни дат: каждое значение
 * потребовало бы утверждения в отчёте, а отчёт здесь разбирает один
 * неопасный факт. */
const BODY = [
  'Текст статьи со ссылками [сюда](/category/ts-piot), [туда](/category/kkt) и [ещё](/category/markirovka).',
  '',
  '## Что проверяет ТС ПИоТ',
  '',
  `${Array.from({ length: 900 }, (_, i) => `слово${i % 40}`).join(' ')}.`,
  '',
  '## Вопрос-ответ',
  '',
  'Что-то конкретное про кассу и маркировку, чего выше не было.',
  '',
].join('\n');

/* Отчёт факчека, выдерживающий текущий доказательный контракт: у статьи
 * нет ни сумм, ни норм, поэтому одно неопасное утверждение — и покрытие
 * пустое. Тест про порядок шагов, не про факчек. */
const REPORT = {
  claims: [{
    id: 'r1', claimId: 'cfix0001', type: 'FACT', raw: 'ТС ПИоТ',
    statement: 'ТС ПИоТ — технические средства проверки и обработки данных, применяемые при продаже',
    status: 'match', severity: 'minor', confidence: 0.9,
    action: 'keep',
    quote: 'технические средства проверки и обработки данных',
    sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
    /* Роль источника нужна контракту материала: он требует, чтобы в
     * разборе участвовал хотя бы один источник роли `norm`. Класс
     * утверждения мягкий, поэтому снимок с него не спрашивают. */
    evidence: [{
      kind: 'primary', sourceRole: 'norm',
      url: 'http://publication.pravo.gov.ru/document/0001202301010001',
      locator: 'пункт 1', retrievedAt: '2026-08-20', effectiveAsOf: '2026-08-20',
      quote: 'технические средства проверки и обработки данных',
    }],
  }],
  summary: { overallStatus: 'ok', criticalIssues: 0 },
};

/** Репозиторий-фикстура в состоянии «статья написана, лежит на вычитке». */
function withRepo(fn, { draft = 'true' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'routine-b-')));
  for (const d of ['src/content/blog', 'src/data/analyze', 'src/data/factcheck/results', 'src/data/factcheck/claims', '.claude/factchecked', 'docs']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  // Версия редполитики — часть контракта артефактов (policyVersion).
  writeFileSync(join(dir, 'docs/editorial-policy.md'), '# Редполитика фикстуры\n');
  writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), `${FM(draft)}\n${BODY}`);
  /* Контракт материала: гейт `contract` без него блокирует, и правильно
   * делает — без контракта непонятно, что статья обязана закрыть. */
  mkdirSync(join(dir, 'src/data/contracts'), { recursive: true });
  {
    const c = draftContract(SLUG, 'legal-review');
    c.intent = 'фикстура: закрыть вопрос читателя';
    c.audience = ['владелец бизнеса'];
    c.requiredSources = ['norm'];
    c.mustCover = c.mustCover.map((x) => ({ ...x, detect: '.' }));
    writeFileSync(join(dir, 'src/data/contracts', `${SLUG}.json`), JSON.stringify(c, null, 2));
  }

  /* K-02: классификация единиц текста. Отчёт здесь пишется вручную, а не
   * через writeBundle, поэтому таблицу собираем тем же способом. */
  const report = structuredClone(REPORT);
  const units = {};
  for (const u of textUnits(BODY)) {
    const mine = u.text.includes('ТС ПИоТ') && !report.claims[0].span;
    if (mine) report.claims[0].span = u.id;
    units[u.id] = mine ? { class: 'factual' } : { class: 'non_factual', reason: 'тест: связующий текст' };
  }
  report.units = units;
  writeFileSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`), JSON.stringify(report));
  /* Реестр извлечения под отчёт (H-01): без него связка не замкнута. */
  writeFileSync(
    join(dir, 'src/data/factcheck/claims', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, claims: [{ id: 'cfix0001', type: 'FACT', raw: 'ТС ПИоТ', offset: 0, line: 1 }] }),
  );
  writeFileSync(join(dir, 'src/data/factcheck/sources.json'),
    JSON.stringify({ npaWhitelist: { fz: {}, pp: {}, prikaz: {} } }));
  writeFileSync(join(dir, 'src/data/editorial-cycle.json'), JSON.stringify({
    cycleId: 't', state: 'running', maxInReview: 2,
    plan: [{ slug: SLUG, status: 'review', title: 'Тестовая статья про ТС ПИоТ и штрафы' }],
    batches: [], log: [],
  }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'article'], { cwd: dir });
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const env = (dir) => ({
  ...process.env,
  RELEASE_DATA_ROOT: dir,
  FACTCHECK_ROOT: dir,
  CYCLE_STATE_PATH: join(dir, 'src/data/editorial-cycle.json'),
});

/** Шаг рутины как есть — командой, а не имитацией её результата. */
function step(dir, script, args, { expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [join(SCRIPTS, script), ...args], { encoding: 'utf8', env: env(dir), cwd: dir });
    if (expectFail) assert.fail(`${script} ${args.join(' ')} — ожидался отказ, а прошло: ${out}`);
    return { code: 0, out };
  } catch (e) {
    if (!expectFail) assert.fail(`${script} ${args.join(' ')} — упало: ${(e.stdout || '') + (e.stderr || '')}`);
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** Шаг 6 списка: `/analyze-article` — агентский, здесь только его результат. */
const writeAnalysis = (dir, opts = {}) => writeAnalysisFixture(dir, SLUG, opts);

const release = (dir, args = [], opts = {}) => {
  const r = step(dir, 'release-article.mjs', [SLUG, '--json', ...args], opts);
  return JSON.parse(r.out || '{}');
};

const draftOf = (dir) =>
  readFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), 'utf8').match(/^draft:\s*(\S+)/m)[1];

const statusOf = (dir) =>
  JSON.parse(readFileSync(join(dir, 'src/data/editorial-cycle.json'), 'utf8')).plan[0].status;

test('порядок из cycle-listen.md проходит целиком и снимает draft только на release', () => {
  withRepo((dir) => {
    // 4. маркер факчека — после того, как тело из дока перенесено
    step(dir, 'factcheck/write-marker.mjs', [SLUG]);
    // 5. приёмка редактора — статус, который release и проверяет
    step(dir, 'cycle-state.mjs', ['accept', '--slug', SLUG]);
    // 6. оценка по текущей версии текста
    writeAnalysis(dir);

    assert.equal(draftOf(dir), 'true', 'до release статья обязана оставаться черновиком');

    // 7. единственный гейт
    const out = release(dir);
    assert.equal(out.status, 'RELEASED');
    assert.equal(draftOf(dir), 'false');

    // 8. статус темы — только после успешного шага 7
    step(dir, 'cycle-state.mjs', ['release', '--slug', SLUG]);
    assert.equal(statusOf(dir), 'released');
  });
});

test('release до приёмки редактора — блокер, а не выпуск', () => {
  withRepo((dir) => {
    step(dir, 'factcheck/write-marker.mjs', [SLUG]);
    writeAnalysis(dir);
    const out = release(dir, [], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.startsWith('Приёмка редактором')), JSON.stringify(out.blockers));
    assert.equal(draftOf(dir), 'true', 'заблокированный release не трогает файл');
  });
});

test('release до оценки — блокер', () => {
  withRepo((dir) => {
    step(dir, 'factcheck/write-marker.mjs', [SLUG]);
    step(dir, 'cycle-state.mjs', ['accept', '--slug', SLUG]);
    const out = release(dir, [], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.startsWith('Оценка')), JSON.stringify(out.blockers));
  });
});

test('release до маркера факчека — блокер', () => {
  withRepo((dir) => {
    step(dir, 'cycle-state.mjs', ['accept', '--slug', SLUG]);
    writeAnalysis(dir);
    const out = release(dir, [], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек')), JSON.stringify(out.blockers));
  });
});

/* Та самая дыра. Раньше эта последовательность заканчивалась статусом
 * ALREADY_RELEASED и кодом 0 — без единой проверки. */
test('draft снят руками в обход release — проверки всё равно идут и находят пропуски', () => {
  withRepo((dir) => {
    const out = release(dir, [], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.equal(out.alreadyReleased, true);
    for (const gate of ['Приёмка редактором', 'Оценка', 'Фактчек']) {
      assert.ok(out.blockers.some((b) => b.startsWith(gate)),
        `гейт «${gate}» не отработал на уже опубликованной статье: ${JSON.stringify(out.blockers)}`);
    }
  }, { draft: 'false' });
});

test('draft снят руками после факчека — маркер отваливается по хешу', () => {
  withRepo((dir) => {
    step(dir, 'factcheck/write-marker.mjs', [SLUG]);
    step(dir, 'cycle-state.mjs', ['accept', '--slug', SLUG]);
    writeAnalysis(dir);

    // Ручная правка флага — то, что запрещает инструкция.
    const p = join(dir, 'src/content/blog', `${SLUG}.md`);
    writeFileSync(p, readFileSync(p, 'utf8').replace('draft: true', 'draft: false'));

    const out = release(dir, [], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.includes('правили после факчека')), JSON.stringify(out.blockers));
  });
});

/* Инструкция и код обязаны говорить одно и то же: пока в шаге 6а
 * снова не появится ручное снятие флага, тест выше имеет смысл. */
test('инструкция рутины B не предлагает снимать draft вручную', () => {
  const md = readFileSync(join(SCRIPTS, '..', '.claude/commands/cycle-listen.md'), 'utf8');
  const step6a = md.slice(md.indexOf('**Тема `owner: bot`'), md.indexOf('Дальше — общее для обоих путей'));
  assert.ok(!/draft: true → false/.test(step6a.split('Раньше здесь стояло')[0]),
    'в шаге 6а снова появилось ручное снятие draft — это обход release-гейта');
  assert.match(step6a, /`draft: true` оставить как\s+есть/);
});
