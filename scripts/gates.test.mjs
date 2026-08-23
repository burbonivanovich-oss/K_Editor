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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundle } from './factcheck/bundle-fixture.mjs';
import { runTopicGate, verdict } from './gates.mjs';

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
  // Связка по текущему контракту — общая сборка, не копия здесь:
  // scripts/factcheck/bundle-fixture.mjs.
  if (marker) writeBundle(dir, SLUG, { date: '2026-08-13' });
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
    assert.notEqual(r.checks.words.ok, false, 'сателлит не блокируется');
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
    writeBundle(dir, SLUG, { date: '2026-08-13', report: null, reportLink: false, result: 'passed', criticalMismatches: 0 });
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
    // Решение — третье состояние: не зелёное, но и не блокер (E-02).
    assert.equal(r.checks.pillar.decide, true);
    assert.equal(r.checks.pillar.ok, undefined, 'у решения не должно быть ok');
    assert.notEqual(r.checks.pillar.ok, false, 'решение — не провал');
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
    assert.equal(r.checks.duplication.decide, true);
    assert.equal(r.checks.duplication.ok, undefined, 'у решения не должно быть ok');
    assert.notEqual(r.checks.duplication.ok, false, 'решение — не провал');
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
    assert.equal(r.checks.market.decide, true);
    assert.equal(r.checks.market.ok, undefined, 'у решения не должно быть ok');
    assert.notEqual(r.checks.market.ok, false, 'решение — не провал');
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
    writeBundle(dir, SLUG, { date: '2026-08-13', result: 'failed', criticalMismatches: 0 });
    const r = run(dir);
    assert.equal(r.checks.factcheck.ok, false);
    assert.match(r.checks.factcheck.note, /«failed»/);
  });
});

test('критические расхождения в факчеке — блокер', () => {
  withRepo((dir) => {
    writeBundle(dir, SLUG, { date: '2026-08-13', result: 'passed', criticalMismatches: 2 });
    assert.match(run(dir).checks.factcheck.note, /критических расхождений 2/);
  });
});

test('отчёт факчека прописан, но его нет на диске — блокер', () => {
  withRepo((dir) => {
    // Маркер по контракту, но ссылка ведёт в никуда.
    const mp = join(dir, '.claude/factchecked', SLUG);
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    writeFileSync(mp, JSON.stringify({ ...m, report: 'src/data/factcheck/results/нет-такого.json' }));
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

/* ------------------------------------------- гейт до работы (--topic) */

// Стадия 1 требовала двух вызовов с разными форматами вывода на один
// вопрос «не написано ли это уже». Здесь они сведены в один гейт с тем
// же словарём исходов.

/* Гоняем подпроцессом, а не импортом: корень ROOT вычисляется в модуле
 * один раз при импорте, и подмена переменных окружения в уже
 * загруженном модуле ничего не меняет — под-скрипты пошли бы в живой
 * репозиторий. Первая версия этих тестов упала именно так. */
function topic(query, dir) {
  try {
    const out = execFileSync('node', [SCRIPT, '--topic', query, '--json'],
      { encoding: 'utf8', env: { ...process.env, GATES_ROOT: dir } });
    return { code: 0, ...JSON.parse(out) };
  } catch (e) {
    return { code: e.status, ...(e.stdout ? JSON.parse(e.stdout) : { checks: {} }) };
  }
}

const st = (c) => (c?.applicable === false ? 'na'
  : c?.decide === true ? 'decide'
    : c?.ok === false ? 'fail' : 'ok');

test('свободная тема — зелёное по обеим проверкам', () => {
  withRepo((dir) => {
    const r = topic('Электронный документооборот для стройки', dir);
    assert.equal(st(r.checks.duplication), 'ok');
    assert.equal(st(r.checks.market), 'ok');
  });
});

/* Главное отличие двух гейтов, и его легко потерять при правке: до
 * ресёрча дубль блокирует, после написания — только советует. Работа
 * ещё не сделана, и её не жалко; после написания механическим «нельзя»
 * работу уже не вернуть. */
test('до ресёрча дубль блокирует, после написания — нет', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/blog', '2026-08-01-pohozhaya.md'),
      `${frontmatter({ title: 'Тестовая статья про кассы' })}\n\n${body()}`);

    const before = topic('Тестовая статья про кассы', dir);
    assert.equal(st(before.checks.duplication), 'fail', 'до работы — блокер');

    const after = run(dir);
    assert.equal(st(after.checks.duplication), 'decide', 'после работы — только решение');
  });
});

test('выпущенная и черновик разводятся в подсказке', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/blog', '2026-08-01-pohozhaya.md'),
      `${frontmatter({ title: 'Тестовая статья про кассы' }).replace('draft: true', 'draft: false')}\n\n${body()}`);
    assert.match(topic('Тестовая статья про кассы', dir).checks.duplication.note, /выпущена — тему снять/);
  });
});

test('пограничное совпадение — решение, а не запрет', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/content/blog', '2026-08-01-pohozhaya.md'),
      `${frontmatter({ title: 'Онлайн-касса для общепита: выбор и подключение' })}\n\n${body()}`);
    const r = topic('Онлайн-касса для розницы', dir);
    assert.notEqual(st(r.checks.duplication), 'fail', 'пограничное не блокирует');
  });
});

// Маркет никогда не блокирует: у модуля другая задача, и пересечение —
// повод сослаться, а не отказаться (AGENTS.md).
test('каталог Маркета не блокирует ни при каком совпадении', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'), JSON.stringify({
      generatedFrom: 'test',
      articles: [{ url: 'https://kontur.ru/market/spravka/1-x', title: 'Тестовая статья про кассы', viewsTotal: 100 }],
    }));
    const r = topic('Тестовая статья про кассы', dir);
    assert.notEqual(st(r.checks.market), 'fail');
    assert.match(r.checks.market.note, /сузить угол или дополнить/);
  });
});

test('слабое совпадение с Маркетом просит только ссылку', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'src/data/interlinking/market-articles.json'), JSON.stringify({
      generatedFrom: 'test',
      articles: [{ url: 'https://kontur.ru/market/spravka/1-x', title: 'Тестовая статья про кассы и склад в общепите', viewsTotal: 100 }],
    }));
    const note = topic('Тестовая статья про кассы', dir).checks.market.note;
    if (!/совпадений с каталогом нет/.test(note)) assert.match(note, /поставить ссылку в тексте|сузить угол/);
  });
});

/* ── молчащая дочерняя проверка ──────────────────────────────────────── */

/* Гейт перед работой звал два под-скрипта и оба читал оптимистично:
 * разбор JSON стоял под пустым `catch`, а отсутствие чисел в выводе
 * каталога давало ноль совпадений. Чем сильнее сломан под-скрипт, тем
 * чище выглядела тема. Ошибка того же рода, что молчащий main-guard, —
 * и лечится тем же правилом: не отработала не значит прошла. */
test('тема не считается чистой, если проверка дублей не отработала', () => {
  const silent = () => ({ code: 0, out: '', silent: true });
  const r = runTopicGate('любая тема', { run: silent });
  assert.equal(r.checks.duplication.status, 'decide', 'молчание не «дублей нет»');
  assert.equal(r.checks.market.status, 'decide', 'молчание не «совпадений нет»');
  assert.match(r.checks.tooling.note, /не отработали/);
  assert.equal(verdict(r), 2, 'вердикт обязан требовать решения человека');
});

test('испорченный JSON дочерней проверки не читается как «дублей нет»', () => {
  const garbled = (script) => (script.includes('draft-duplication')
    ? { code: 0, out: '{ это не json' }
    : { code: 0, out: 'совпадений нет' });
  const r = runTopicGate('любая тема', { run: garbled });
  assert.equal(r.checks.duplication.status, 'decide');
  assert.match(r.checks.tooling.note, /не разбирается/);
});

test('обычный прогон с находками остаётся прежним', () => {
  const found = (script) => (script.includes('draft-duplication')
    ? { code: 1, out: JSON.stringify({ hits: [{ score: 0.7, title: 'Старая статья', draft: false }] }) }
    : { code: 0, out: 'совпадений нет' });
  const r = runTopicGate('любая тема', { run: found });
  assert.equal(r.checks.duplication.status, 'fail', 'дубль по-прежнему блокирует');
  assert.equal(r.checks.tooling, undefined, 'исправная работа лишних строк не добавляет');
});
