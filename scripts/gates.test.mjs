// Тесты единого гейта.
//
// Гейт заменил шесть чек-листов, которые проверялись глазами. Цена
// ошибки поэтому выше обычной: пока пункты были в тексте процедуры,
// их хотя бы читали. Теперь их не читает никто — считает скрипт.
//
// Гоняем на временном репозитории (GATES_ROOT), а не на живом корпусе:
// иначе «дубль найден» зависит от того, что редакция написала вчера.
//
// Запуск: node --test scripts/gates.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gates.mjs');
const SLUG = '2026-08-13-test-article';

const body = (words = 1600, links = 3) => {
  const link = Array.from({ length: links }, (_, i) => `[текст](/blog/2026-01-0${i + 1}-drugaya/)`).join(' ');
  return `${link}\n\n` + Array.from({ length: words }, (_, i) => `слово${i % 50}`).join(' ');
};

const frontmatter = (over = {}) => {
  const f = {
    title: 'Тестовая статья про кассы', description: 'Описание тестовой статьи для проверки гейтов.',
    pubDate: '2026-08-13', reviewDate: '2027-02-13',
    tags: ['касса', 'ккт', 'розница', 'ндс'], categories: ['kkt'], keywords: ['тестовый ключ'],
    ...over,
  };
  return ['---', `title: "${f.title}"`, `description: "${f.description}"`,
    `pubDate: "${f.pubDate}"`, `reviewDate: "${f.reviewDate}"`,
    'tags:', ...f.tags.map((x) => `  - ${x}`),
    'categories:', ...f.categories.map((x) => `  - ${x}`),
    'draft: true', 'seo:', '  keywords:', ...f.keywords.map((x) => `    - ${x}`), '---'].join('\n');
};

function withRepo(fn, { fm = frontmatter(), text = body(), marker = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gates-test-'));
  for (const d of ['src/content/blog', 'src/content/pillars', '.claude/factchecked',
    'src/data/factcheck/results', 'src/data/audit', 'src/data/interlinking']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  const raw = `${fm}\n\n${text}`;
  writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), raw);
  writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'),
    JSON.stringify({ generatedFrom: 'test', articles: [] }));
  if (marker) {
    writeFileSync(join(dir, 'src/data/factcheck/results', `${SLUG}.json`), '{}');
    writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify({
      date: '2026-08-13', hash: createHash('sha256').update(raw).digest('hex'),
      result: 'passed', criticalMismatches: 0,
      report: `src/data/factcheck/results/${SLUG}.json`,
    }));
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* Проверки, которые гейт считает сам. Под-скрипты (check-seo,
 * check-blog-links, audit-npa-references) на синтетической фикстуре
 * законно краснеют: текст из «слово1 слово2» не может пройти SEO, а
 * ссылки ведут на несуществующие статьи. У них свои тесты — здесь
 * проверяем только то, за что отвечает сам гейт. */
const OWN = ['frontmatter', 'words', 'internalLinks', 'factcheck', 'duplication', 'market', 'pillar', 'graph'];
const ownRed = (r) => OWN.filter((k) => r.checks[k]?.ok === false);

function run(dir) {
  try {
    const out = execFileSync('node', [SCRIPT, SLUG, '--json'], {
      encoding: 'utf8', env: { ...process.env, GATES_ROOT: dir },
    });
    return { code: 0, ...JSON.parse(out) };
  } catch (e) {
    return { code: e.status, ...(e.stdout ? JSON.parse(e.stdout) : { checks: {} }) };
  }
}

test('гейт отдаёт блок checks в том виде, в каком его ждёт /analyze-article', () => {
  withRepo((dir) => {
    const r = run(dir);
    for (const k of ['frontmatter', 'words', 'internalLinks', 'seo', 'ai', 'links',
      'npa', 'factcheck', 'duplication', 'market', 'graph', 'pillar']) {
      assert.ok(k in r.checks, `нет проверки ${k}`);
    }
  });
});

test('неполный frontmatter — блокер, поля названы', () => {
  withRepo((dir) => {
    const r = run(dir);
    assert.equal(r.checks.frontmatter.ok, false);
    assert.match(r.checks.frontmatter.note, /reviewDate/);
  }, { fm: frontmatter().replace(/reviewDate:.*\n/, '') });
});

test('тегов вне нормы 4–7 — блокер', () => {
  withRepo((dir) => {
    assert.match(run(dir).checks.frontmatter.note, /тегов 2/);
  }, { fm: frontmatter({ tags: ['касса', 'ккт'] }) });
});

test('объём ниже 800 слов — блокер', () => {
  withRepo((dir) => {
    const r = run(dir);
    assert.equal(r.checks.words.ok, false);
    assert.equal(r.code, 1);
  }, { text: body(300) });
});

// 800–1500 — законный сателлит, но для опорной мало. Это выбор автора,
// а не ошибка: гейт спрашивает, а не запрещает.
test('объём между 800 и 1500 — требует решения, а не блокер', () => {
  withRepo((dir) => {
    const r = run(dir);
    assert.equal(r.checks.words.ok, true, 'сателлит не блокируется');
    assert.match(r.checks.words.note, /сателлит/);
  }, { text: body(1000) });
});

test('меньше трёх внутренних ссылок — блокер', () => {
  withRepo((dir) => {
    assert.equal(run(dir).checks.internalLinks.ok, false);
  }, { text: body(1600, 1) });
});

test('нет маркера факчека — блокер с внятной причиной', () => {
  withRepo((dir) => {
    const r = run(dir);
    assert.equal(r.checks.factcheck.ok, false);
    assert.match(r.checks.factcheck.note, /факчек не проводился/);
  }, { marker: false });
});

// Ровно тот случай, ради которого в маркере есть хеш: статью правили
// после проверки, и маркер больше ничего не подтверждает.
test('статью правили после факчека — маркер недействителен', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), `${frontmatter()}\n\n${body()}\n\nДописанный абзац.`);
    const r = run(dir);
    assert.equal(r.checks.factcheck.ok, false);
    assert.match(r.checks.factcheck.note, /правили после факчека/);
  });
});

test('маркер без отчёта не считается проверкой', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify({ date: '2026-08-13', result: 'passed' }));
    assert.match(run(dir).checks.factcheck.note, /без отчёта/);
  });
});

// Опорного материала нет у 20 кластеров из 25. Раньше это нормировалось
// в плюс и давало полный балл; теперь — честное «неприменимо».
test('нет опорного материала кластера — неприменимо, а не провал', () => {
  withRepo((dir) => {
    const r = run(dir);
    assert.equal(r.checks.pillar.applicable, false);
    assert.match(r.checks.pillar.note, /нет опорного материала/);
    assert.deepEqual(ownRed(r), [], 'отсутствие pillar не должно давать красное');
  });
});

test('pillar есть и ссылается — зелёное', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/pillars/kkt.md'), `Ссылка на /blog/${SLUG}/`);
    assert.equal(run(dir).checks.pillar.ok, true);
  });
});

test('pillar есть, но не ссылается — решение, не блокер', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/pillars/kkt.md'), 'Ничего про эту статью.');
    const r = run(dir);
    assert.equal(r.checks.pillar.ok, true, 'не блокер');
    assert.match(r.checks.pillar.note, /не ссылается/);
  });
});

// Дубль после написания — редакционное решение, а не механический
// запрет: работу уже сделали, и блокировать её поздно. Блокирующая
// проверка стоит до ресёрча.
test('дубль на этой стадии не блокирует, а требует решения', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/blog', '2026-08-01-pohozhaya.md'),
      `${frontmatter({ title: 'Тестовая статья про кассы и ккт' })}\n\n${body()}`);
    const r = run(dir);
    assert.equal(r.checks.duplication.ok, true, 'не блокер');
    assert.match(r.checks.duplication.note, /объединить|сузить/);
  });
});

test('статьи нет — гейт говорит об этом, а не падает молча', () => {
  withRepo((dir) => {
    try {
      execFileSync('node', [SCRIPT, 'нет-такой-статьи'], { encoding: 'utf8', env: { ...process.env, GATES_ROOT: dir } });
      assert.fail('ожидался ненулевой код');
    } catch (e) {
      assert.match(e.stderr, /нет/);
    }
  });
});

test('корректная статья не даёт красного по проверкам самого гейта', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/pillars/kkt.md'), `Ссылка на /blog/${SLUG}/`);
    assert.deepEqual(ownRed(run(dir)), []);
  });
});

/* Вердикт — не «сколько красных», а «есть ли хоть одно». Одна упавшая
 * проверка обязана перевесить одиннадцать зелёных: до 13.08.2026 шлюзы
 * были чек-листом, где одно непройденное место терялось среди пройденных. */
test('одна упавшая проверка перевешивает все зелёные', () => {
  withRepo((dir) => {
    assert.equal(run(dir).code, 1);
  }, { text: body(300) });
});

/* --------------------------------------- ветки, которые легко обойти молча */

// Пересечение с Маркетом — не блокер, но и не «всё в порядке»: у модуля
// нет своего сайта, и статья должна вести на Маркет, а не соревноваться
// с ним за тот же запрос (AGENTS.md).
test('сильное совпадение с Маркетом без ссылки — требует решения', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'), JSON.stringify({
      generatedFrom: 'test',
      articles: [{ url: 'https://kontur.ru/market/spravka/1-x', title: 'Тестовая статья про кассы', viewsTotal: 100 }],
    }));
    const r = run(dir);
    assert.equal(r.checks.market.ok, true, 'не блокер');
    assert.match(r.checks.market.note, /без ссылки на Маркет/);
  });
});

test('то же совпадение со ссылкой на Маркет в тексте — зелёное', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'), JSON.stringify({
      generatedFrom: 'test',
      articles: [{ url: 'https://kontur.ru/market/spravka/1-x', title: 'Тестовая статья про кассы', viewsTotal: 100 }],
    }));
    writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`),
      `${frontmatter()}\n\n${body()}\n\nПодробнее в [справке](https://kontur.ru/market/spravka/1-x).`);
    assert.match(run(dir).checks.market.note, /ссылка на Маркет в тексте есть/);
  });
});

// Маркер с проваленным факчеком выглядит как маркер: файл есть, дата
// есть. Разница только в поле result — и её легко не заметить глазами.
test('маркер с непройденным факчеком — блокер', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify({
      date: '2026-08-13', result: 'failed', criticalMismatches: 0,
      report: `src/data/factcheck/results/${SLUG}.json`,
    }));
    const r = run(dir);
    assert.equal(r.checks.factcheck.ok, false);
    assert.match(r.checks.factcheck.note, /«failed»/);
  });
});

test('критические расхождения в факчеке — блокер', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify({
      date: '2026-08-13', result: 'passed', criticalMismatches: 2,
      report: `src/data/factcheck/results/${SLUG}.json`,
    }));
    assert.match(run(dir).checks.factcheck.note, /критических расхождений 2/);
  });
});

test('отчёт факчека прописан, но его нет на диске — блокер', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.claude/factchecked', SLUG), JSON.stringify({
      date: '2026-08-13', result: 'passed', criticalMismatches: 0,
      report: 'src/data/factcheck/results/нет-такого.json',
    }));
    assert.match(run(dir).checks.factcheck.note, /нет на диске/);
  });
});

test('повреждённый маркер не роняет гейт', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.claude/factchecked', SLUG), 'не json');
    const r = run(dir);
    assert.equal(r.checks.factcheck.ok, false);
    assert.match(r.checks.factcheck.note, /повреждён/);
  });
});

// Ссылки считаются по уникальным адресам: три ссылки на одну и ту же
// статью — это одна связь, а не три.
test('повторные ссылки на одну статью не считаются тремя', () => {
  withRepo((dir) => {
    const same = '[раз](/blog/2026-01-01-a/) [два](/blog/2026-01-01-a/) [три](/blog/2026-01-01-a/)';
    writeFileSync(join(dir, 'src/content/blog', `${SLUG}.md`), `${frontmatter()}\n\n${same}\n\n${body(1600, 0)}`);
    const r = run(dir);
    assert.equal(r.checks.internalLinks.ok, false);
    assert.match(r.checks.internalLinks.note, /1 внутренних/);
  });
});

test('две категории вместо одной — блокер', () => {
  withRepo((dir) => {
    assert.match(run(dir).checks.frontmatter.note, /категорий 2/);
  }, { fm: frontmatter({ categories: ['kkt', 'markirovka'] }) });
});

test('нет seo.keywords — блокер, поле названо', () => {
  withRepo((dir) => {
    assert.match(run(dir).checks.frontmatter.note, /seo\.keywords/);
  }, { fm: frontmatter().replace(/\n\s*keywords:[\s\S]*?(?=\n---)/, '') });
});
