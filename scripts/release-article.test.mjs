// Тесты release-article.mjs через реальный CLI (subprocess) на временной
// фикстуре (RELEASE_DATA_ROOT). Гейты SEO и AI-маркеры полностью
// изолированы — они получают абсолютный путь к статье и не зависят от
// cwd. Гейты npa-audit и check-blog-links всегда идут по РЕАЛЬНОМУ
// репозиторию (у них нет своих оверрайдов путей) — сейчас блог в
// репозитории пуст, поэтому они всегда проходят чисто; появление
// незнакомых НПА или битых ссылок в реальном src/content/blog/ проявится
// в CI отдельными шагами (audit-npa-references.mjs --strict,
// check-blog-links.mjs), не здесь.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS } from './check-analysis.mjs';
import { writeBundle } from './factcheck/bundle-fixture.mjs';
import { writeAnalysis as writeAnalysisFixture, allChecksOk } from './analysis-fixture.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release-article.mjs');

// /category/ — не /blog/: этой ссылки check-blog-links.mjs не проверяет
// вообще (только /blog/<slug>/), а check-seo.mjs (P0: ≥1 внутренняя
// ссылка) принимает оба. Раньше ссылка была на /blog/other-article —
// несуществующий файл, который до T-01 никто не замечал: npa-audit и
// check-blog-links всегда гонялись по настоящему репозиторию, не по
// фикстуре, поэтому битая ссылка внутри временной директории теста не
// попадала в поле зрения гейта вообще.
/* Тело фикстуры должно проходить гейты, а не только парситься.
 *
 * Раньше здесь было тринадцать слов и одна ссылка: этого хватало, пока
 * релиз гонял четыре проверки своим списком. Теперь он зовёт тот же
 * `gates.mjs`, что и все остальные, и объём, внутренние ссылки и
 * frontmatter стали его условиями. Это не издержка теста, а ровно то,
 * ради чего список убрали: релиз больше не знает набора проверок «для
 * себя». */
const GOOD_BODY = [
  'Текст статьи со ссылками [сюда](/category/kkt), [туда](/category/ts-piot) и [ещё](/category/markirovka).',
  '',
  '## Что проверяет касса',
  '',
  /* Ни чисел, ни дат: любое значение здесь потребует утверждения в
   * отчёте, а отчёт фикстуры разбирает ровно один факт. */
  Array.from({ length: 900 }, (_, i) => `слово${i % 40}`).join(' ') + '.',
  '',
  '## Что делать дальше',
  '',
  '- Администратор перед первой сменой проверяет модуль; убедитесь, что он активен.',
  '- Кассир заранее разбирает сценарий отказа; результат — порядок действий без подсказки.',
  '',
  '## Вопрос-ответ',
  '',
  'Что-то конкретное про кассу и маркировку, чего выше не было.',
  '',
].join('\n');

const GOOD_FM = {
  title: 'Тестовая статья про ТС ПИоТ и штрафы',
  description:
    'Описание статьи достаточной длины для прохождения проверки SEO, не короче ста символов и не длиннее ста шестидесяти пяти символов ровно.',
  draft: 'true',
  pubDate: '2026-01-01',
  reviewDate: '2026-07-01',
};

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'release-article-test-'));
  mkdirSync(join(dir, 'src/content/blog'), { recursive: true });
  mkdirSync(join(dir, 'src/data/analyze'), { recursive: true });
  mkdirSync(join(dir, '.claude/factchecked'), { recursive: true });
  // npa-audit и check-blog-links (T-01) теперь реально гоняются по
  // DATA_ROOT фикстуры, не по настоящему репозиторию — но npa-audit
  // читает src/data/factcheck/sources.json безусловно, файл обязан
  // существовать хотя бы в минимальной форме.
  mkdirSync(join(dir, 'src/data/factcheck'), { recursive: true });
  writeFileSync(
    join(dir, 'src/data/factcheck/sources.json'),
    JSON.stringify({ npaWhitelist: { fz: {}, pp: {}, prikaz: {} } }),
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeArticle(dir, slug, { fm = GOOD_FM, body = GOOD_BODY, extra = '' } = {}) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(k === 'draft' ? `draft: ${v}` : `${k}: "${v}"`);
  }
  const text = `${lines.join('\n')}\ncategories:\n  - ts-piot\ntags:\n  - тег1\n  - тег2\n  - тег3\n  - тег4\nseo:\n  keywords:\n    - тестовый ключ\n${extra}---\n${body}`;
  const p = join(dir, 'src/content/blog', `${slug}.md`);
  writeFileSync(p, text);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'article'], { cwd: dir });
  return p;
}

/* Запись оценки — общая сборка из scripts/analysis-fixture.mjs: она
 * привязывает балл к версии текста, как того требует контракт. 95 по
 * умолчанию, а не 85: 85 — ровно порог, и тест «нормальной статьи» не
 * должен стоять на границе. */
function writeAnalysis(dir, slug, opts = {}) {
  return writeAnalysisFixture(dir, slug, opts);
}

/* Утверждение неопасного типа: у GOOD_BODY нет ни сумм, ни норм, а
 * пустой список claims считается «проверять было нечего». Так фикстура
 * остаётся про релиз, а не про факчек. */
const PLAIN_CLAIM = {
  id: 'c1', type: 'FACT', raw: 'ТС ПИоТ',
  statement: 'ТС ПИоТ — технические средства проверки и обработки данных, применяемые при продаже',
  status: 'match', severity: 'minor', confidence: 0.9,
  quote: 'технические средства проверки и обработки данных',
  sources: ['http://publication.pravo.gov.ru/document/0001202301010001'],
  action: 'keep',
};

/* `report: null` даёт ровно тот старый вид маркера (без отчёта), который
 * раньше проходил релиз. */
function writeMarker(dir, slug, opts = {}) {
  return writeBundle(dir, slug, { claims: [PLAIN_CLAIM], ...opts });
}

function writeAccepted(dir, slug, status = 'accepted') {
  writeFileSync(
    join(dir, 'src/data/editorial-cycle.json'),
    JSON.stringify({ cycleId: 't', state: 'running', plan: [{ slug, status }], batches: [], log: [] }),
  );
}

function today(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function run(dir, args, { expectFail = false } = {}) {
  const env = { ...process.env, RELEASE_DATA_ROOT: dir };
  try {
    const out = execFileSync('node', [SCRIPT, ...args, '--json'], { encoding: 'utf8', env });
    if (expectFail) assert.fail('ожидался ненулевой exit code');
    return JSON.parse(out);
  } catch (e) {
    if (!expectFail) throw e;
    return JSON.parse(e.stdout || '{}');
  }
}

/** Полностью готовая к выпуску фикстура — используется как база в тестах. */
function fullyReady(dir, slug = 'a', articleOpts = {}) {
  writeArticle(dir, slug, articleOpts);
  writeAccepted(dir, slug);
  writeAnalysis(dir, slug);
  writeMarker(dir, slug);
  return slug;
}

test('нет статьи — ошибка', () => {
  withFixture((dir) => {
    const env = { ...process.env, RELEASE_DATA_ROOT: dir };
    assert.throws(() => execFileSync('node', [SCRIPT, 'nope', '--json'], { encoding: 'utf8', env }));
  });
});

/* Уже опубликованная статья, у которой всё в порядке: та же
 * фикстура, что и у готовой к выпуску, только draft уже снят, а тема в
 * цикле — в статусе released. */
function alreadyPublished(dir, slug = 'a') {
  writeArticle(dir, slug, { fm: { ...GOOD_FM, draft: 'false' } });
  writeAccepted(dir, slug, 'released');
  writeAnalysis(dir, slug);
  writeMarker(dir, slug);
  return slug;
}

test('уже draft: false и все гейты зелёные — ALREADY_RELEASED, файл не трогает', () => {
  withFixture((dir) => {
    const slug = alreadyPublished(dir);
    const before = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    const out = run(dir, [slug]);
    assert.equal(out.status, 'ALREADY_RELEASED');
    assert.equal(readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8'), before);
  });
});

/* B-01. Ровно та дыра, которую нашёл внешний аудит: инструкция рутины B
 * просила снять draft при переносе тела из дока, и после этого release
 * возвращал ALREADY_RELEASED кодом 0, не проверив ни одного гейта. Так
 * штатный выпуск через Google Docs шёл мимо приёмки, НПА, ссылок, SEO,
 * AI, оценки и факчека. */
test('B-01: уже опубликованная статья без факчека — BLOCKED, а не безусловный успех', () => {
  withFixture((dir) => {
    writeArticle(dir, 'a', { fm: { ...GOOD_FM, draft: 'false' } });
    const out = run(dir, ['a'], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.equal(out.alreadyReleased, true);
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек')),
      `опубликованная статья без факчека прошла проверку: ${JSON.stringify(out.blockers)}`);
  });
});

test('B-01: провальный факчек блокирует независимо от значения draft', () => {
  for (const draft of ['true', 'false']) {
    withFixture((dir) => {
      const slug = 'a';
      writeArticle(dir, slug, { fm: { ...GOOD_FM, draft } });
      writeAccepted(dir, slug, draft === 'false' ? 'released' : 'accepted');
      writeAnalysis(dir, slug);
      writeMarker(dir, slug, { result: 'needs-rewrite', criticalMismatches: 3 });
      const out = run(dir, [slug], { expectFail: true });
      assert.equal(out.status, 'BLOCKED', `draft: ${draft}`);
      assert.ok(out.blockers.some((b) => b.startsWith('Фактчек')), `draft: ${draft}`);
    });
  }
});

test('B-01: у опубликованной статьи приёмка засчитывается по статусу released', () => {
  withFixture((dir) => {
    const slug = alreadyPublished(dir);
    const out = run(dir, [slug]);
    assert.ok(out.findings.some((f) => f.name === 'Приёмка редактором' && f.status === 'ok' && f.detail === 'released'),
      `приёмка не засчитана: ${JSON.stringify(out.findings)}`);
  });
});

test('темы нет в цикле — блокер без --confirm-no-cycle, проходит с флагом+причиной', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    // Затираем cycle-state, чтобы темы там не было вообще.
    writeFileSync(join(dir, 'src/data/editorial-cycle.json'), JSON.stringify({ plan: [] }));

    const blocked = run(dir, [slug], { expectFail: true });
    assert.equal(blocked.status, 'BLOCKED');
    assert.ok(blocked.blockers.some((b) => b.includes('--confirm-no-cycle')));

    // Без причины — ошибка использования, не молчаливый проход.
    assert.throws(() =>
      execFileSync('node', [SCRIPT, slug, '--confirm-no-cycle', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, RELEASE_DATA_ROOT: dir },
      }),
    );

    const ok = run(dir, [slug, '--confirm-no-cycle', 'тема написана вне Drive-цикла, обкатка пайплайна']);
    assert.equal(ok.status, 'RELEASED');

    const analysis = JSON.parse(readFileSync(join(dir, 'src/data/analyze', `${slug}.json`), 'utf8'));
    assert.equal(analysis.cycleReleaseOverride.reason, 'тема написана вне Drive-цикла, обкатка пайплайна');
  });
});

test('тема в цикле, но не accepted — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeFileSync(
      join(dir, 'src/data/editorial-cycle.json'),
      JSON.stringify({ plan: [{ slug, status: 'review' }] }),
    );
    const out = run(dir, [slug], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.startsWith('Приёмка редактором') && b.includes('review')));
  });
});

test('нет оценки /analyze-article — блокер', () => {
  withFixture((dir) => {
    const slug = 'a';
    writeArticle(dir, slug);
    writeAccepted(dir, slug);
    writeMarker(dir, slug);
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Оценка')));
  });
});

test('оценка старше 30 дней — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeAnalysis(dir, slug, { checkedAt: today(-31) });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Оценка') && b.includes('устарела')));
  });
});

test('балл ниже порога — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeAnalysis(dir, slug, { score: 55 });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Оценка')));
  });
});

test('--override-score без причины — ошибка использования, ничего не трогает', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeAnalysis(dir, slug, { score: 55 });
    assert.throws(() =>
      execFileSync('node', [SCRIPT, slug, '--override-score', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, RELEASE_DATA_ROOT: dir },
      }),
    );
    const text = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    assert.match(text, /^draft: true$/m, 'без валидной причины файл не должен меняться');
  });
});

test('балл ниже порога, но --override-score с причиной — RELEASED, причина записана в audit-trail', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeAnalysis(dir, slug, { score: 55, blocker: true });

    const out = run(dir, [slug, '--override-score', 'редактор: короткая тема, глубже раскрывать некуда']);
    assert.equal(out.status, 'RELEASED');
    assert.ok(out.findings.some((f) => f.status === 'info' && f.name === 'Оценка /analyze-article'));

    const analysis = JSON.parse(readFileSync(join(dir, 'src/data/analyze', `${slug}.json`), 'utf8'));
    assert.equal(analysis.releaseOverride.reason, 'редактор: короткая тема, глубже раскрывать некуда');
    assert.equal(analysis.releaseOverride.score, 55);
    assert.equal(analysis.releaseOverride.blocker, true);

    const text = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    assert.match(text, /^draft: false$/m);
  });
});

test('--override-score не снимает остальные гейты (SEO P0 всё равно блокирует)', () => {
  withFixture((dir) => {
    const slug = 'a';
    const p = join(dir, 'src/content/blog', `${slug}.md`);
    writeFileSync(p, `---\ntitle: "T"\ndraft: true\n---\nПусто.\n`);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'x'], { cwd: dir });
    writeAccepted(dir, slug);
    writeAnalysis(dir, slug, { score: 55 });
    writeMarker(dir, slug);
    const out = run(dir, [slug, '--override-score', 'причина'], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.startsWith('SEO')));
  });
});

// T-01: npa-audit и check-blog-links теперь реально гоняются по фикстуре
// (DATA_ROOT), а не по настоящему репозиторию — эти два теста были
// физически невозможны до фикса runGate(cwd).
test('битая /blog/ ссылка в статье фикстуры — блокирует (check-blog-links реально по фикстуре)', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir, 'a', {
      body: 'Ссылка на [несуществующую статью](/blog/no-such-slug-here) внутри фикстуры.',
    });
    const out = run(dir, [slug], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    assert.ok(out.blockers.some((b) => b.startsWith('Внутренние ссылки')));
  });
});

test('незнакомый номер ПП в тексте статьи — блокирует npa-audit по фикстуре, не по реальному sources.json', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir, 'a', {
      body: 'Согласно постановлению Правительства № 8765 это разрешено.',
    });
    const out = run(dir, [slug], { expectFail: true });
    assert.equal(out.status, 'BLOCKED');
    /* В гейте проверка называется «Нормы»: релиз зовёт общий прогон,
     * а не свой npa-audit. Блокировать обязана по-прежнему. */
    assert.ok(out.blockers.some((b) => b.startsWith('Нормы')), JSON.stringify(out.blockers));
  });
});

test('нет маркера факчека — блокер', () => {
  withFixture((dir) => {
    const slug = 'a';
    writeArticle(dir, slug);
    writeAccepted(dir, slug);
    writeAnalysis(dir, slug);
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('нет маркера')));
  });
});

test('статья менялась после факчека (хеш не совпал) — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeMarker(dir, slug, { hashOf: 'совсем другое содержимое' });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('правили после факчека')));
  });
});

// Регрессия 12.08.2026: пять из шести выпущенных статей имели маркер с
// result: null — процедура факчека писала маркер, но не писала отчёт
// results/<slug>.json. Гейт смотрел только хеш и дату и пропускал.
test('маркер факчека без результата (отчёта нет) — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeMarker(dir, slug, { result: null, criticalMismatches: null });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('без результата')));
  });
});

test('маркер факчека с критичными расхождениями — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeMarker(dir, slug, { result: 'passed', criticalMismatches: 2 });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('критических расхождений')));
  });
});

test('маркер факчека старше 180 дней — блокер', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeMarker(dir, slug, { date: today(-181) });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('старше')));
  });
});

test('SEO P0-ошибка (нет категории/тегов) — блокер', () => {
  withFixture((dir) => {
    const slug = 'a';
    const p = join(dir, 'src/content/blog', `${slug}.md`);
    writeFileSync(p, `---\ntitle: "T"\ndraft: true\n---\nПусто.\n`);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'x'], { cwd: dir });
    writeAccepted(dir, slug);
    writeAnalysis(dir, slug);
    writeMarker(dir, slug);
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('SEO')));
  });
});

test('AI-маркеры выше порога — блокер', () => {
  withFixture((dir) => {
    const slug = 'a';
    // rawScore = min(10, round(totalWeight/3)); порог по умолчанию 6.
    // Каждое повторение «важно отметить» / «следует отметить» — вес 2,
    // семи повторов (14 общим весом ×2 фразы = 28) с запасом хватает.
    const cliche = 'Важно отметить, что необходимо отметить это. '.repeat(7);
    const aiHeavyBody = `${GOOD_BODY}\n${cliche}\n`;
    writeArticle(dir, slug, { body: aiHeavyBody });
    writeAccepted(dir, slug);
    writeAnalysis(dir, slug);
    writeMarker(dir, slug, { hashOf: readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8') });
    const out = run(dir, [slug], { expectFail: true });
    /* Имя проверки в общем гейте — «Машинный текст». */
    assert.ok(out.blockers.some((b) => b.startsWith('Машинный текст')), JSON.stringify(out.blockers));
  });
});

test('--dry-run проходит все гейты, но файл не меняет', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    const before = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    const out = run(dir, [slug, '--dry-run']);
    assert.equal(out.status, 'WOULD_RELEASE');
    const after = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    assert.equal(before, after);
  });
});

test('все гейты пройдены — RELEASED, draft снят без кавычек, reviewDate пересчитан', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    const out = run(dir, [slug]);
    assert.equal(out.status, 'RELEASED');
    const text = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    assert.match(text, /^draft: false$/m);
    assert.doesNotMatch(text, /draft: "false"/);
    assert.match(text, /^reviewDate: "\d{4}-\d{2}-\d{2}"$/m);
  });
});

test('после RELEASED маркер факчека обновлён под новый хеш статьи (draft:false её меняет)', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    const before = JSON.parse(readFileSync(join(dir, '.claude/factchecked', slug), 'utf8'));

    const out = run(dir, [slug]);
    assert.equal(out.status, 'RELEASED');

    const articleText = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
    const actualHash = createHash('sha256').update(articleText).digest('hex');
    const after = JSON.parse(readFileSync(join(dir, '.claude/factchecked', slug), 'utf8'));

    assert.equal(after.hash, actualHash, 'маркер должен указывать на пост-релизное содержимое статьи');
    assert.notEqual(before.hash, after.hash, 'draft:true→false меняет файл, значит и хеш обязан смениться');
    assert.equal(after.date, before.date, 'дата факчека — когда проверялись факты, релиз это не переверяет');

    // Если файл больше не тронуть, повторный прогон гейта фактчека
    // (тот же код, что в pre-commit guard) обязан пройти чисто.
    const rerun = run(dir, [slug]);
    assert.equal(rerun.status, 'ALREADY_RELEASED');
  });
});

function writeContentPlan(dir, rows) {
  mkdirSync(join(dir, 'src/content/wiki'), { recursive: true });
  const header = '| Slug | Заголовок | Priority | Целевой запрос | Status | Blocker |\n|---|---|---|---|---|---|\n';
  const body = rows.map((r) => `| ${r.slug} | Т | ${r.priority ?? 'P0'} | ключ | ${r.status} | — |`).join('\n');
  writeFileSync(join(dir, 'src/content/wiki/content-plan-2026.md'), header + body + '\n');
}

test('F-02: release переводит строку темы в контент-плане в done', () => {
  withFixture((dir) => {
    // fullyReady пишет полный slug с датой — контент-план хранит короткий.
    const slug = fullyReady(dir, 'a');
    writeContentPlan(dir, [{ slug: 'a', status: 'planned' }, { slug: 'b', status: 'planned' }]);

    const out = run(dir, [slug]);
    assert.equal(out.status, 'RELEASED');
    assert.ok(out.findings.some((f) => f.name === 'Контент-план' && f.detail.includes('done')));

    const plan = readFileSync(join(dir, 'src/content/wiki/content-plan-2026.md'), 'utf8');
    assert.match(plan, /\| a \| Т \| P0 \| ключ \| done \| — \|/);
    assert.match(plan, /\| b \| Т \| P0 \| ключ \| planned \| — \|/, 'чужая строка не тронута');
  });
});

test('F-02: темы нет в контент-плане — RELEASED без заметки, файл не создаётся', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir, 'a');
    const out = run(dir, [slug]);
    assert.equal(out.status, 'RELEASED');
    assert.ok(!out.findings.some((f) => f.name === 'Контент-план'));
  });
});

test('F-02: тема уже done в плане — не трогаем, заметки нет', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir, 'a');
    writeContentPlan(dir, [{ slug: 'a', status: 'done' }]);
    const out = run(dir, [slug]);
    assert.equal(out.status, 'RELEASED');
    assert.ok(!out.findings.some((f) => f.name === 'Контент-план'));
  });
});

/* Граница порога. До 13.08.2026 её не проверял никто: порог стоял на 70
 * при реальном разбросе баллов 84–100, то есть шлюз не срабатывал ни
 * разу, и подъём порога прошёл бы мимо тестов. */
test('балл ровно на пороге проходит, на балл ниже — нет', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeAnalysis(dir, slug, { score: PASS });
    run(dir, [slug]);
  });
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeAnalysis(dir, slug, { score: PASS - 1 });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Оценка')), 'балл под порогом обязан блокировать');
  });
});

/* Старая оценка выглядит проходной — там 100 набиралось с бонусом и
 * нормировкой отсутствующего pillar. Пропустить её значит выпустить
 * статью по той самой шкале, ради починки которой всё и затевалось. */
test('оценка по старой шкале не пускает статью в выпуск', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeFileSync(join(dir, 'src/data/analyze', `${slug}.json`), JSON.stringify({
      slug, score: 100, blocker: false, checkedAt: today(),
      categories: { quality: { score: 20, issues: [] }, ai_citation: { score: 10, issues: [] } },
    }));
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.includes('старой шкале')), `ожидался блокер про старую шкалу:\n${JSON.stringify(out.blockers)}`);
  });
});

/* ── Гейт, который не запустился, — блокер, а не «пройдено» ───────── */

/* Копия scripts/ с одним под-чекером, подменённым на «код 0, ни слова».
 * Это ровно поведение сломанного main-guard: девять чекеров годами
 * завершались успехом, ничего не проверив, и релиз считал их зелёными.
 * Копия обязательно лежит в каталоге с пробелом — на нём и ломался
 * старый guard. */
function withStubbedGate(script, fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'release-stub-')));
  const root = join(base, 'Claude Local · Контур', 'repo');
  mkdirSync(root, { recursive: true });
  cpSync(dirname(SCRIPT), join(root, 'scripts'), {
    recursive: true,
    filter: (src) => !/\.test\.mjs$/.test(src) && !/node_modules|\.git$/.test(src),
  });
  writeFileSync(join(root, 'scripts', script), 'process.exit(0);\n');
  try { return fn(join(root, 'scripts', 'release-article.mjs')); } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('молчащий AI-гейт блокирует релиз, а не проходит его', () => {
  withStubbedGate('check-ai-markers.mjs', (script) => {
    withFixture((dir) => {
      const slug = fullyReady(dir);
      const env = { ...process.env, RELEASE_DATA_ROOT: dir };
      let out;
      try {
        execFileSync('node', [script, slug, '--json'], { encoding: 'utf8', env });
        assert.fail('релиз прошёл на гейте, который не выполнялся');
      } catch (e) { out = JSON.parse(e.stdout || '{}'); }
      /* Проверка называется «Машинный текст»: релиз больше не держит
       * своего списка и зовёт `gates.mjs`. Правило прежнее и оно
       * важнее имени — молчащий чекер обязан блокировать выпуск и
       * называть причиной молчание, а не содержание статьи. */
      const ai = (out.blockers || []).find((b) => b.startsWith('Машинный текст'));
      assert.ok(ai, `AI-гейт не заблокировал релиз: ${JSON.stringify(out.blockers)}`);
      assert.match(ai, /не состоялась/, 'причина обязана называть молчание гейта, а не содержание статьи');
    });
  });
});

test('обычный прогон той же копии релиз пропускает — стенд не ломает всё подряд', () => {
  withStubbedGate('нет-такого-файла.mjs', (script) => {
    withFixture((dir) => {
      const slug = fullyReady(dir);
      const env = { ...process.env, RELEASE_DATA_ROOT: dir };
      const out = JSON.parse(execFileSync('node', [script, slug, '--dry-run', '--json'], { encoding: 'utf8', env }));
      assert.equal(out.status, 'WOULD_RELEASE');
    });
  });
});

/* ── B-02: маркер — утверждение о проверке, а не сама проверка ────── */

/* Раньше релиз читал из маркера hash, date и result — и всё. Отчёт мог
 * отсутствовать, а доказательства в нём — не выдерживать текущего
 * контракта: все десять отчётов корпуса стояли passed, хотя
 * checkReport() отвергает каждый. Теперь релиз перепроверяет связку на
 * месте, тем же валидатором, что и гейт. */

test('B-02: маркер старого образца (без отчёта) релиз не проходит', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    writeMarker(dir, slug, { report: null, reportLink: false });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('без отчёта')),
      `старый маркер прошёл релиз: ${JSON.stringify(out.blockers)}`);
  });
});

test('B-02: отчёт есть, но доказательств не предъявляет — блокер', () => {
  withFixture((dir) => {
    const body = `${GOOD_BODY}\nЗа это статья 14.5 КоАП РФ грозит штрафом 10 000 ₽ для должностных лиц.\n`;
    const slug = 'a';
    writeArticle(dir, slug, { body });
    writeAccepted(dir, slug);
    writeAnalysis(dir, slug);
    writeMarker(dir, slug, {
      report: {
        claims: [{
          // Критичное утверждение про деньги — и ни цитаты, ни источника.
          id: 'c1', type: 'MONEY', raw: '10 000 ₽',
          statement: 'штраф по ст. 14.5 КоАП РФ для должностных лиц — 10 000 ₽',
          status: 'match', severity: 'critical', confidence: 0.95,
        }],
        summary: { overallStatus: 'ok', criticalIssues: 0 },
      },
    });
    const out = run(dir, [slug], { expectFail: true });
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('не доказывает проверку')),
      `отчёт без доказательств прошёл релиз: ${JSON.stringify(out.blockers)}`);
  });
});

test('B-02: значение из статьи, которого нет в отчёте, — блокер', () => {
  withFixture((dir) => {
    const body = `${GOOD_BODY}\nШтраф составит 10 000 ₽.\n`;
    const slug = 'a';
    writeArticle(dir, slug, { body });
    writeAccepted(dir, slug);
    writeAnalysis(dir, slug);
    writeMarker(dir, slug); // отчёт валидный, но про другое
    const out = run(dir, [slug], { expectFail: true });
    /* Причина может быть двух видов, и обе верные: значения нет в
     * отчёте вовсе («не разбирались») либо утверждение про него есть,
     * но говорит про другое («расходится со статьёй»). Требовать
     * конкретную формулировку значит проверять текст сообщения, а не
     * то, что выпуск остановлен. */
    assert.ok(
      out.blockers.some((b) => /^Факчек/.test(b) && /не разбирались|расходится со статьёй/.test(b)),
      `непокрытое значение прошло релиз: ${JSON.stringify(out.blockers)}`,
    );
  });
});

/* ── выпуск откатывается целиком ─────────────────────────────────────── */

/* Выпуск пишет статью, маркер, файл оценки и контент-план. Записи шли
 * подряд: сбой на любой оставлял статью выпущенной, а маркер — про
 * прежний текст. Такого состояния не бывает при нормальной работе, и
 * чинить его приходилось руками, зная, какие шаги успели пройти. */
test('сбой посреди выпуска не оставляет полувыпущенной статьи', () => {
  withFixture((dir) => {
    const slug = fullyReady(dir);
    const articlePath = join(dir, 'src/content/blog', `${slug}.md`);
    const before = readFileSync(articlePath, 'utf8');

    const markerPath = join(dir, '.claude/factchecked', slug);
    const markerBefore = readFileSync(markerPath, 'utf8');

    /* Ломаем последний шаг, а не первый: гейты к этому моменту уже
     * пройдены, статья и маркер переписаны. Контент-план делаем
     * каталогом — чтение его как файла неизбежно падает. */
    mkdirSync(join(dir, 'src/content/wiki/content-plan-2026.md'), { recursive: true });

    const r = run(dir, [slug], { expectFail: true });
    assert.equal(r.status, 'FAILED', 'сбой обязан быть назван сбоем, а не выпуском');
    assert.equal(readFileSync(articlePath, 'utf8'), before,
      'статья обязана остаться невыпущенной — иначе маркер относится к другому тексту');
    assert.equal(readFileSync(markerPath, 'utf8'), markerBefore,
      'маркер обязан вернуться к прежнему хешу');
    assert.deepEqual(r.rollbackFailed, [], 'откат обязан пройти целиком');
  });
});
