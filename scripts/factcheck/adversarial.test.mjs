/**
 * I-01. Корпус известных подмен: каждая обязана быть заблокирована.
 *
 * Зачем отдельно от остальных тестов. «`npm test` зелёный» ничего не
 * говорит о том, ловится ли смысловая подмена: тесты проверяют, что код
 * делает то, что задумано, а здесь проверяется другое — что задуманного
 * достаточно. Критерий не «все тесты прошли», а «100 % известных мутаций
 * не проходят».
 *
 * Каждая запись списка — реальный класс ошибки, который в этом
 * репозитории уже случался либо был найден аудитом. Список только
 * растёт: новую мутацию добавляют вместе с защитой от неё, а не вместо.
 *
 * Устройство. Берётся заведомо здоровая связка (статья + реестр + отчёт
 * + маркер), к ней применяется ровно одна подмена, и результат
 * прогоняется через `validateFactcheckBundle` — тот самый валидатор,
 * которым пользуются гейт, релиз, CI и health. Мутация считается
 * пойманной, если валидатор сказал «не ок» **и** назвал причину: молча
 * покраснеть мало, по такому сообщению никто не починит.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFactcheckBundle } from './validate-bundle.mjs';
import { writeBundle, GOOD_EVIDENCE } from './bundle-fixture.mjs';
import { computeOutcome } from './report-schema.mjs';
import { reportHash, claimsHash } from './hashes.mjs';

const SLUG = '2026-08-13-adversarial';

/* Статья с тем набором фактов, на котором ломаются все интересные
 * случаи: сумма для ИП, сумма для юрлица, диапазон, дата вступления,
 * норма с частью, строка таблицы и короткая врезка. */
const ARTICLE = `---
title: "Проба на подмену"
description: "Тестовая статья для корпуса известных подмен фактчека."
pubDate: "2026-08-13"
draft: true
---

Организация обязана заплатить 10 000 ₽ штрафа по ч. 2 ст. 14.5 КоАП РФ.

Требование действует с 01.10.2026 и продлений больше не будет.

| Кто | Штраф |
| --- | --- |
| ИП | 10 000 ₽ |
| Юрлицо | 30 000 ₽ |

Врезка: 30 000 ₽.
`;

const ev = (over = {}) => ({ ...GOOD_EVIDENCE, ...over });

const CLAIMS = [
  {
    id: 'r1', claimId: 'cx1', type: 'MONEY', raw: '10 000 ₽',
    statement: 'организация обязана заплатить 10 000 ₽ по ч. 2 ст. 14.5 КоАП РФ',
    subject: 'юридическое лицо', modality: 'obligation', negated: false,
    status: 'match', severity: 'critical', confidence: 0.95, action: 'keep',
    evidence: [ev({ quote: 'влечёт наложение административного штрафа в размере не менее 10 000 рублей' })],
    sources: [GOOD_EVIDENCE.url],
  },
  {
    id: 'r2', claimId: 'cx2', type: 'DATE_DMY', raw: '01.10.2026',
    statement: 'требование действует с 01.10.2026, продлений не предусмотрено',
    subject: 'пользователь ККТ', modality: 'obligation', negated: false, effectiveFrom: '2026-10-01',
    status: 'match', severity: 'critical', confidence: 0.9, action: 'keep',
    evidence: [ev({ quote: 'вступает в силу с 01.10.2026' })],
    sources: [GOOD_EVIDENCE.url],
  },
  {
    id: 'r3', claimId: 'cx3', type: 'MONEY', raw: '30 000 ₽',
    statement: 'для юридического лица штраф составляет 30 000 ₽',
    subject: 'юридическое лицо', modality: 'statement', negated: false,
    status: 'match', severity: 'critical', confidence: 0.9, action: 'keep',
    evidence: [ev({ quote: 'на юридических лиц — в размере 30 000 рублей' })],
    sources: [GOOD_EVIDENCE.url],
  },
];

/* Реестр извлечения: ровно те места статьи, которые разбирает отчёт.
 * Записи с одинаковой цитатой разведены по номеру повторения — так же,
 * как это делает extract-claims. */
const EXTRACTION = [
  { id: 'cx1', type: 'MONEY', raw: '10 000 ₽', offset: 0, line: 8 },
  { id: 'cx2', type: 'DATE_DMY', raw: '01.10.2026', offset: 0, line: 10 },
  { id: 'cx3', type: 'MONEY', raw: '30 000 ₽', offset: 0, line: 15 },
];

/** Здоровая связка во временном корне. */
function withBundle(fn, { article = ARTICLE, claims = CLAIMS, extraction = EXTRACTION } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adversarial-')));
  mkdirSync(join(root, 'src/content/blog'), { recursive: true });
  const path = join(root, 'src/content/blog', `${SLUG}.md`);
  writeFileSync(path, article);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/editorial-policy.md'), '# Редполитика фикстуры\n');
  writeBundle(root, SLUG, { claims: structuredClone(claims), extraction: structuredClone(extraction) });

  const api = {
    root,
    /** Переписать статью — так же, как это делает редактор в доке. */
    setArticle: (text) => writeFileSync(path, text),
    /** Поправить отчёт и пересобрать печати, чтобы правка не ловилась по хешу. */
    patchReport: (fn2, { resign = true } = {}) => {
      const rp = join(root, 'src/data/factcheck/results', `${SLUG}.json`);
      const report = JSON.parse(readFileSync(rp, 'utf8'));
      fn2(report);
      report.summary = computeOutcome(report.claims);
      const text = JSON.stringify(report);
      writeFileSync(rp, text);
      if (!resign) return;
      const mp = join(root, '.claude/factchecked', SLUG);
      const marker = JSON.parse(readFileSync(mp, 'utf8'));
      marker.reportHash = reportHash(text);
      marker.claimsHash = claimsHash(report.claims);
      writeFileSync(mp, JSON.stringify(marker));
    },
    /* Текущий отчёт — мутациям иногда нужно посмотреть, что там лежит. */
    report: () => JSON.parse(readFileSync(join(root, 'src/data/factcheck/results', `${SLUG}.json`), 'utf8')),
    patchExtraction: (fn2) => {
      const ep = join(root, 'src/data/factcheck/claims', `${SLUG}.json`);
      const data = JSON.parse(readFileSync(ep, 'utf8'));
      fn2(data);
      writeFileSync(ep, JSON.stringify(data, null, 2));
    },
    validate: () => validateFactcheckBundle({
      root, slug: SLUG, articleRaw: readFileSync(path, 'utf8'), staleDays: null,
    }),
  };
  try { return fn(api); } finally { rmSync(root, { recursive: true, force: true }); }
}

/* ── Список мутаций ─────────────────────────────────────────────────── */

/**
 * @typedef {{name: string, why: string, mutate: (api) => void, expect: RegExp}} Mutation
 */
const MUTATIONS = [
  {
    name: 'отрицание',
    why: 'инъекция аудита: «обязана заплатить 10 000 ₽» → «не обязана платить 10 000 ₽» '
      + 'при неизменном наборе чисел',
    mutate: (a) => a.setArticle(ARTICLE.replace(
      'Организация обязана заплатить 10 000 ₽',
      'Организация не обязана платить 10 000 ₽',
    )),
    expect: /менялся|смысл|отрицани/i,
  },
  {
    name: 'смена субъекта',
    why: 'ИП и юрлицо в ч. 2 ст. 14.5 КоАП РФ отличаются втрое по сумме',
    mutate: (a) => a.setArticle(ARTICLE.replace(
      'Организация обязана заплатить',
      'Индивидуальный предприниматель обязан заплатить',
    )),
    expect: /менялся|смысл|субъект/i,
  },
  {
    name: 'смена модальности',
    why: '«обязана» → «вправе»: обязанность и возможность — разные факты',
    mutate: (a) => a.setArticle(ARTICLE.replace('обязана заплатить', 'вправе заплатить')),
    expect: /менялся|смысл|модальност/i,
  },
  {
    name: 'то же число в другом контексте',
    why: 'загрязнение отчёта по разрешительному режиму: дата совпала, утверждение из другой статьи',
    mutate: (a) => a.patchReport((r) => {
      const c = r.claims.find((x) => x.claimId === 'cx2');
      c.statement = 'с 01.10.2026 добавлены способы подачи заявления через изготовителя ККТ и Госуслуги';
    }),
    expect: /расходится|смысл|реестр|цитат/i,
  },
  {
    name: 'сдвиг границы диапазона',
    why: 'нижняя граница «от 10 000 до 30 000 ₽» — отдельное значение, а не украшение',
    mutate: (a) => a.setArticle(ARTICLE.replace('| ИП | 10 000 ₽ |', '| ИП | от 15 000 до 30 000 ₽ |')),
    expect: /менялся|разбирал|смысл/i,
  },
  {
    name: 'другая дата вступления при том же номере нормы',
    why: 'номер нормы прежний, срок другой — набор «проверенных» ссылок не меняется',
    mutate: (a) => a.setArticle(ARTICLE.replace('с 01.10.2026', 'с 01.01.2027')),
    expect: /менялся|разбирал|смысл/i,
  },
  {
    name: 'другая часть той же статьи',
    why: 'у частей ст. 14.5 КоАП РФ разные санкции; «ст. 14.5» без части их не различает',
    mutate: (a) => a.setArticle(ARTICLE.replace('ч. 2 ст. 14.5', 'ч. 4 ст. 14.5')),
    expect: /менялся|разбирал|смысл|целиком/i,
  },
  {
    name: 'разрешённый домен, нерелевантная страница',
    why: 'домен из белого списка не доказывает, что цитата про этот случай',
    mutate: (a) => a.patchReport((r) => {
      r.claims[0].evidence = [ev({
        quote: 'настоящий приказ вступает в силу по истечении десяти дней',
        locator: 'пункт 12',
      })];
    }),
    expect: /цитате первоисточника нет значения|не доказывает/i,
  },
  {
    name: 'выдуманная цитата',
    why: 'цитата без отпечатка страницы невоспроизводима — сверить не с чем',
    mutate: (a) => a.patchReport((r) => {
      const e = { ...r.claims[0].evidence[0] };
      delete e.snapshotHash;
      r.claims[0].evidence = [e];
    }),
    expect: /snapshotHash|отпечаток/i,
  },
  {
    name: 'вторичный источник вместо первоисточника',
    why: 'открытая обзорная статья — по-прежнему обзорная статья (случай эквайринга)',
    mutate: (a) => a.patchReport((r) => {
      r.claims[0].evidence = [ev({ sourceRole: 'secondary' })];
    }),
    expect: /вторичн/i,
  },
  {
    name: 'правка одной строки таблицы',
    why: 'строка таблицы — целый факт, а не форматирование',
    mutate: (a) => a.setArticle(ARTICLE.replace('| Юрлицо | 30 000 ₽ |', '| Юрлицо | 300 000 ₽ |')),
    expect: /менялся|разбирал|смысл/i,
  },
  {
    name: 'правка внутри блока короче 40 символов',
    why: 'врезки и подписи отбрасывались из diff по длине — правка не оставляла следа',
    mutate: (a) => a.setArticle(ARTICLE.replace('Врезка: 30 000 ₽.', 'Врезка: 300 000 ₽.')),
    expect: /менялся|разбирал|смысл/i,
  },
  {
    name: 'старый отчёт при новом тексте',
    why: 'маркер переживал смену смысла, если набор чисел не менялся',
    mutate: (a) => a.setArticle(ARTICLE.replace(
      'продлений больше не будет',
      'срок может быть продлён решением оператора',
    )),
    expect: /менялся|смысл/i,
  },
  {
    name: 'вердикт спорит с правкой',
    why: '«значение верное» и «текст надо переписать» — два ответа в одном утверждении',
    mutate: (a) => a.patchReport((r) => { r.claims[0].action = 'rewrite-bullet'; }),
    expect: /правк|не подтверждено|не проходит/i,
  },
  {
    name: 'ссылка в реестр указывает на чужое место',
    why: 'ровно так 159 утверждений корпуса «резолвились» в другое утверждение',
    mutate: (a) => a.patchReport((r) => { r.claims[0].claimId = 'cx3'; }),
    expect: /реестр|другое место|уже разобран/i,
  },
  {
    name: 'извлечённое утверждение без исхода',
    why: 'отсутствующее не оставляет следа — 134 утверждения корпуса были нигде',
    mutate: (a) => a.patchExtraction((d) => {
      d.claims.push({ id: 'cx9', type: 'MONEY', raw: '10 000 ₽', offset: 0, line: 13 });
    }),
    expect: /без исхода|реестр/i,
  },
  {
    name: 'реестра извлечения нет вовсе',
    why: 'полноту разбора не с чем сверять, и это не «нечего проверять»',
    mutate: (a) => rmSync(join(a.root, 'src/data/factcheck/claims', `${SLUG}.json`), { force: true }),
    expect: /нет реестра|извлечен/i,
  },
  {
    name: 'отчёт подменён после выписки маркера',
    why: 'связка версионирована: отчёт, к которому маркер не относится, — не проверка',
    mutate: (a) => a.patchReport((r) => { r.claims[0].confidence = 0.5; }, { resign: false }),
    expect: /менялся после выписки|утверждения в отчёте менялись/i,
  },
  {
    name: 'отпечаток без снимка',
    why: 'до хранилища snapshotHash проверялся на форму — любые 64 hex проходили, и «отпечаток страницы» ничего не доказывал',
    mutate: (a) => a.patchReport((r) => { r.claims[0].evidence[0].snapshotHash = 'f'.repeat(64); }),
    expect: /снимка нет в хранилище|не подтверждено снимком/i,
  },
  {
    name: 'снимок под чужим именем',
    why: 'положить любой файл с нужным именем — очевидный обход, если имя не пересчитывается из содержимого',
    mutate: (a) => {
      const hash = a.report().claims[0].evidence[0].snapshotHash;
      writeFileSync(join(a.root, 'src/data/factcheck/snapshots', `${hash}.txt`), 'подменённое содержимое');
    },
    expect: /не соответствует имени|не подтверждено снимком/i,
  },
  {
    name: 'цитаты нет в сохранённом снимке',
    why: 'снимок есть и он настоящий, но цитата выписана не из него',
    mutate: (a) => a.patchReport((r) => { r.claims[0].evidence[0].quote = 'фраза, которой в документе нет'; }),
    expect: /цитаты нет в снимке|не подтверждено снимком|цитате первоисточника/i,
  },
  {
    name: 'редполитику правили после проверки',
    why: 'policyVersion был датой файла: её поднимали, не перепроверяя ничего, и старый разбор выглядел сделанным по свежим правилам',
    mutate: (a) => writeFileSync(join(a.root, 'docs/editorial-policy.md'), '# Другая редполитика\n'),
    expect: /редполитика изменилась|policyHash/i,
  },
  {
    name: 'отчёт по прежнему контракту проверок',
    why: 'форма артефактов не менялась, когда проверки стали строже, — старые отчёты проходили как современные',
    mutate: (a) => a.patchReport((r) => { r.contractVersion = 1; }),
    expect: /контракту проверок|повторный факчек/i,
  },
  {
    name: 'строгое утверждение без доказательств',
    why: 'воспроизведение из аудита: маркер выписывался со статусом passed, а полный валидатор затем отвергал связку как weak-evidence',
    mutate: (a) => a.patchReport((r) => { r.claims[0].evidence = []; }),
    expect: /нет доказательств|не доказывает проверку/i,
  },
  {
    name: 'пустой список утверждений',
    why: 'exit 0 без результата — «проверка не состоялась», а не успех (регресс A-02)',
    mutate: (a) => a.patchReport((r) => { r.claims = []; }),
    expect: /пуст|не доказывает|разбирал/i,
  },
];

/* ── Прогон ─────────────────────────────────────────────────────────── */

test('здоровая связка проходит — иначе ловить нечего', () => {
  withBundle((a) => {
    const r = a.validate();
    assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
  });
});

for (const m of MUTATIONS) {
  test(`подмена «${m.name}» блокируется`, () => {
    withBundle((a) => {
      m.mutate(a);
      const r = a.validate();
      const said = r.problems.map((p) => `${p.code}: ${p.message}`).join(' | ');
      assert.equal(r.ok, false, `подмена прошла: ${m.why}`);
      assert.match(said, m.expect,
        `подмена поймана, но причина не названа так, чтобы по ней починили.\n  ${m.why}\n  сказано: ${said}`);
    });
  });
}

test('список мутаций не съёживается незаметно', () => {
  /* Мутацию можно только добавить. Удалить её из списка значит объявить,
   * что этот класс ошибки больше не считается ошибкой, — и такое решение
   * должно быть заметным, а не тихой правкой массива. */
  assert.ok(MUTATIONS.length >= 25, `мутаций стало ${MUTATIONS.length}, было 25 — что удалили и почему?`);
  const names = MUTATIONS.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, 'мутации с одинаковым именем');
  for (const m of MUTATIONS) {
    assert.ok(m.why?.length > 20, `у мутации «${m.name}» не написано, откуда она взялась`);
  }
});
