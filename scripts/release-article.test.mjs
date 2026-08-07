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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release-article.mjs');

// /category/ — не /blog/: этой ссылки check-blog-links.mjs не проверяет
// вообще (только /blog/<slug>/), а check-seo.mjs (P0: ≥1 внутренняя
// ссылка) принимает оба. Раньше ссылка была на /blog/other-article —
// несуществующий файл, который до T-01 никто не замечал: npa-audit и
// check-blog-links всегда гонялись по настоящему репозиторию, не по
// фикстуре, поэтому битая ссылка внутри временной директории теста не
// попадала в поле зрения гейта вообще.
const GOOD_BODY = `Текст статьи со ссылкой [сюда](/category/kkt) на другую тему.

## Вопрос-ответ

Что-то конкретное.
`;

const GOOD_FM = {
  title: 'Тестовая статья про ТС ПИоТ и штрафы',
  description:
    'Описание статьи достаточной длины для прохождения проверки SEO, не короче ста символов и не длиннее ста шестидесяти пяти символов ровно.',
  draft: 'true',
  pubDate: '2026-01-01',
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

function writeAnalysis(dir, slug, { score = 85, blocker = false, checkedAt = today() } = {}) {
  writeFileSync(join(dir, 'src/data/analyze', `${slug}.json`), JSON.stringify({ score, blocker, checkedAt }));
}

function writeMarker(dir, slug, { date = today(), hashOf = null } = {}) {
  const content = readFileSync(join(dir, 'src/content/blog', `${slug}.md`), 'utf8');
  const hash = createHash('sha256').update(hashOf ?? content).digest('hex');
  writeFileSync(join(dir, '.claude/factchecked', slug), JSON.stringify({ date, hash }));
}

function writeAccepted(dir, slug) {
  writeFileSync(
    join(dir, 'src/data/editorial-cycle.json'),
    JSON.stringify({ cycleId: 't', state: 'running', plan: [{ slug, status: 'accepted' }], batches: [], log: [] }),
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

test('уже draft: false — ALREADY_RELEASED, ничего не трогает', () => {
  withFixture((dir) => {
    writeArticle(dir, 'a', { fm: { ...GOOD_FM, draft: 'false' } });
    const out = run(dir, ['a']);
    assert.equal(out.status, 'ALREADY_RELEASED');
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

test('score < 70 — блокер', () => {
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

test('score < 70, но --override-score с причиной — RELEASED, причина записана в audit-trail', () => {
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
    assert.ok(out.blockers.some((b) => b.startsWith('НПА-аудит')));
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
    assert.ok(out.blockers.some((b) => b.startsWith('Фактчек') && b.includes('менялась после факчека')));
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
    assert.ok(out.blockers.some((b) => b.startsWith('AI-маркеры')));
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
