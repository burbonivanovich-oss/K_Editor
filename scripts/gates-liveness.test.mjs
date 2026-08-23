// Каждая проверка гейта умеет сказать «нет».
//
// Проверка каталога Маркета не срабатывала ни разу: гейт разбирал её
// вывод не тем шаблоном и на каждой статье сообщал «совпадений нет».
// Отчёт выглядел зелёным и правдоподобным. Раньше такое ловилось тем,
// что пункт читали глазами, — плохо, но читали. После перехода на
// скрипт не читает никто, и мёртвая проверка живёт вечно.
//
// Здесь для каждой проверки есть вход, на котором она ОБЯЗАНА ответить
// не «зелёное». Проверка, которую нельзя вывести из зелёного, — мёртвая,
// и тест падает с её именем.
//
// Это доказательство, а не наблюдение. Наблюдение — распределение
// ответов по корпусу (`gates.mjs --audit`), и оно намеренно не выдаёт
// предупреждений: на здоровом корпусе девять проверок из двенадцати
// зелёные везде, и «подозрительных» там было бы девять.
//
// Обратное направление — что проверка умеет сказать «да» — закрывает
// прогон по живому корпусу: сегодня все двенадцать где-то зелёные.
//
// Запуск: node --test scripts/gates-liveness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_CHECKS } from './gates.mjs';
import { writeBundle } from './factcheck/bundle-fixture.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gates.mjs');
const SLUG = '2026-08-13-liveness';

const text = (words = 1600, links = 3) =>
  Array.from({ length: links }, (_, i) => `[текст](/blog/2026-01-0${i + 1}-x/)`).join(' ')
  + '\n\n' + Array.from({ length: words }, (_, i) => `слово${i % 50}`).join(' ');

const fm = (over = {}) => {
  const f = {
    title: 'Тестовая статья про кассы', description: 'Описание тестовой статьи для проверки живости гейтов.',
    pubDate: '2026-08-13', reviewDate: '2027-02-13',
    tags: ['касса', 'ккт', 'розница', 'ндс'], categories: ['kkt'], keywords: ['тестовый ключ'], ...over,
  };
  return ['---', `title: "${f.title}"`, `description: "${f.description}"`,
    `pubDate: "${f.pubDate}"`, `reviewDate: "${f.reviewDate}"`,
    'tags:', ...f.tags.map((x) => `  - ${x}`), 'categories:', ...f.categories.map((x) => `  - ${x}`),
    'draft: true', 'seo:', '  keywords:', ...f.keywords.map((x) => `    - ${x}`), '---'].join('\n');
};

/** Здоровая фикстура, из которой каждый случай ломает ровно одну вещь. */
function build(dir, { head = fm(), body = text(), marker = true, catalog = [], pillar = null, extra = null, facts = null } = {}) {
  for (const d of ['src/content/blog', 'src/content/pillars', '.claude/factchecked',
    'src/data/factcheck/results', 'src/data/audit', 'src/data/interlinking']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  const raw = `${head}\n\n${body}`;
  writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), raw);
  writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'),
    JSON.stringify({ generatedFrom: 'test', articles: catalog }));
  if (pillar !== null) writeFileSync(join(dir, 'src/content/pillars/kkt.md'), pillar);
  if (extra) writeFileSync(join(dir, 'src/content/blog', extra.name), extra.content);
  if (facts) {
    writeFileSync(join(dir, 'src/data/factcheck/facts.json'), JSON.stringify({ facts }));
  }
  if (marker) writeBundle(dir, SLUG, { date: '2026-08-13' });
}

function statusOf(check, setup) {
  const dir = mkdtempSync(join(tmpdir(), 'liveness-'));
  try {
    build(dir, setup);
    let out;
    try {
      out = execFileSync('node', [SCRIPT, SLUG, '--json'],
        { encoding: 'utf8', env: { ...process.env, GATES_ROOT: dir } });
    } catch (e) { out = e.stdout; }
    const c = JSON.parse(out).checks[check];
    if (!c) return 'нет такой проверки';
    if (c.applicable === false) return 'na';
    return c.ok === false ? 'fail' : 'ok';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* Вход, на котором проверка обязана выйти из зелёного.
 *
 * `expect: 'fail'` — обязана покраснеть. `expect: 'note'` — блокером не
 * бывает по устройству (дубль после написания, промах по Маркету,
 * pillar без ссылки), поэтому проверяем, что она хотя бы меняет
 * формулировку: сказать «нет» она умеет, просто не блокирует. */
const CASES = {
  frontmatter: { expect: 'fail', setup: { head: fm().replace(/reviewDate:.*\n/, '') } },
  words: { expect: 'fail', setup: { body: text(300) } },
  internalLinks: { expect: 'fail', setup: { body: text(1600, 0) } },
  factcheck: { expect: 'fail', setup: { marker: false } },
  // Под-скрипты: синтетический текст «слово1 слово2» не проходит SEO, а
  // ссылки ведут в никуда. Если гейт перестанет их звать и зашьёт «ok»,
  // эти строки упадут.
  seo: { expect: 'fail', setup: {} },
  ai: { expect: 'fail', setup: { body: 'Является важным. Следует отметить. Таким образом. '.repeat(200) } },
  links: { expect: 'fail', setup: {} },
  npa: { expect: 'fail', setup: {} },
  duplication: {
    expect: 'note', match: /объединить|сузить/,
    setup: { extra: { name: '2026-08-01-pohozhaya.md', content: `${fm({ title: 'Тестовая статья про кассы и ккт' })}\n\n${text()}` } },
  },
  market: {
    expect: 'note', match: /без ссылки на Маркет/,
    setup: { catalog: [{ url: 'https://kontur.ru/market/spravka/1-x', title: 'Тестовая статья про кассы', viewsTotal: 100 }] },
  },
  pillar: { expect: 'note', match: /не ссылается/, setup: { pillar: 'Ничего про эту статью.' } },
  // Строгая формулировка намеренно: шаблон, совпадающий и с зелёным
  // ответом, — это тест, который пропустит мёртвую проверку. Так и
  // вышло в первой версии: /никто не ссылается|входящие/ проходил на
  // ответе «входящие ссылки есть», и то, что проверка мертва,
  // обнаружилось только при попытке ужесточить.
  graph: { expect: 'note', match: /никто не ссылается/, setup: {} },
  /* J-02. Статья спорит с реестром повторяемых фактов. Блокер, а не
   * «требует решения»: расхождение двух статей по одной норме — ошибка
   * в одной из них, а не редакционный выбор. */
  corpus: {
    expect: 'fail',
    setup: {
      body: `Порог — от 2 250 000 ₽ для непродовольственных товаров.\n\n${text()}`,
      facts: [{
        id: 'porog', kind: 'value',
        statement: 'Крупный размер по главе 22 УК РФ — свыше 3 500 000 ₽.',
        scope: 'ч. 1–2 ст. 171.1 УК РФ', value: '3 500 000',
        supersedes: [{ value: '2 250 000', until: '2024-04-06', by: 'ФЗ от 06.04.2024 № 79-ФЗ' }],
        effectiveFrom: '2024-04-06', effectiveTo: null,
        evidence: { url: 'https://www.consultant.ru/x/', quote: 'превышающая три миллиона пятьсот тысяч рублей' },
      }],
    },
  },
  /* J-03. Плановая проверка назначена позже, чем статья устареет: в
   * тексте событие 01.10.2026, в frontmatter — февраль 2027-го. */
  freshness: {
    expect: 'fail',
    setup: { body: `Временный токен закрывается 01.10.2026.\n\n${text()}` },
  },
  /* K-01. Контракта нет — проверять нечего, и это блокер: без него
   * непонятно, что статья обязана закрыть. Фикстура контракт не
   * пишет, поэтому случай живости — она сама. */
  contract: { expect: 'fail', setup: {} },
  /* L-03…L-05. Требует решения, а не блокирует: ответить «здесь
   * категоричность уместна» может только редактор. */
  editorial: {
    expect: 'note', match: /категоричных утверждений без условий/,
    setup: { body: `Продавец обязан пробить чек.\n\n${text()}` },
  },
};

test('для каждой проверки гейта есть случай, который выводит её из зелёного', () => {
  const missing = Object.keys(GATE_CHECKS).filter((k) => !(k in CASES));
  assert.deepEqual(missing, [], `нет случая живости для: ${missing.join(', ')} — добавь его вместе с проверкой`);
});

for (const [check, { expect, setup, match }] of Object.entries(CASES)) {
  test(`${GATE_CHECKS[check] || check}: умеет сказать «нет»`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'liveness-'));
    let checkResult;
    try {
      build(dir, setup);
      let out;
      try {
        out = execFileSync('node', [SCRIPT, SLUG, '--json'],
          { encoding: 'utf8', env: { ...process.env, GATES_ROOT: dir } });
      } catch (e) { out = e.stdout; }
      checkResult = JSON.parse(out).checks[check];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(checkResult, `проверки «${check}» нет в выводе гейта`);
    if (expect === 'fail') {
      assert.equal(checkResult.ok, false,
        `«${GATE_CHECKS[check]}» осталась зелёной на входе, который обязан её уронить — проверка мертва. Ответ: ${checkResult.note}`);
    } else {
      assert.match(checkResult.note || '', match,
        `«${GATE_CHECKS[check]}» не заметила того, ради чего написана. Ответ: ${checkResult.note}`);
    }
  });
}

/* Обратное направление для гейт-собственных проверок: на здоровом входе
 * они обязаны быть зелёными. Проверка, которая красная всегда, ломает
 * пайплайн так же надёжно, как мёртвая, — только громче. */
test('на здоровой статье собственные проверки гейта зелёные', () => {
  for (const check of ['frontmatter', 'words', 'internalLinks', 'factcheck', 'duplication', 'market']) {
    assert.equal(statusOf(check, {}), 'ok', `«${GATE_CHECKS[check]}» красная на здоровом входе`);
  }
});
