#!/usr/bin/env node
// Регрессионный аудит: пробегает по всем статьям (включая черновики — см.
// ниже, почему) и сравнивает упоминания НПА (ПП, Приказы, ФЗ) с whitelist
// из sources.json. Помечает незнакомые номера для ручной проверки. Это
// страховка против повторения случая с фейковыми ПП (№ 257, № 2456, № 2457).
//
// Использование:
//   node scripts/factcheck/audit-npa-references.mjs           # отчёт
//   node scripts/factcheck/audit-npa-references.mjs --strict  # exit 1 если есть неизвестные (для CI)

import fs from 'node:fs';
import { writeReportIfChanged } from '../lib/write-report.mjs';
import path from 'node:path';

const BLOG_DIR = 'src/content/blog';
const SOURCES = JSON.parse(fs.readFileSync('src/data/factcheck/sources.json', 'utf8'));

const knownFz = new Set(Object.keys(SOURCES.npaWhitelist.fz));
const knownPp = new Set(Object.keys(SOURCES.npaWhitelist.pp));
const knownPrikaz = new Set(Object.keys(SOURCES.npaWhitelist.prikaz));

const WHITELIST_BY_TYPE = {
  fz: SOURCES.npaWhitelist.fz,
  pp: SOURCES.npaWhitelist.pp,
  prikaz: SOURCES.npaWhitelist.prikaz,
};

// Какие topic'и из npaWhitelist уместны в статье этой категории. Ловит класс
// ошибки из постмортема 2026-05-19: номер настоящий и есть в whitelist, но
// норма из чужой темы (ПП № 2099 про маркировку молочки — в статье про ТС ПИоТ).
// Категория, которой тут нет, проверку не проходит — считаем topic == категории.
const TOPICS_BY_CATEGORY = {
  'ts-piot': ['ts-piot', 'kkt'],
  kkt: ['kkt', 'ts-piot'],
  markirovka: ['markirovka', 'merkuriy'],
  egais: ['egais'],
  zakonodatelstvo: [
    'nalogi',
    'kadry',
    'buh',
    'edo-kedo',
    'personal-data',
    'marketplace',
    'kkt',
    'markirovka',
    'ts-piot',
    'egais',
  ],
};

function allowedTopics(categories) {
  const allowed = new Set();
  for (const c of categories) {
    for (const t of TOPICS_BY_CATEGORY[c] ?? [c]) allowed.add(t);
  }
  return allowed;
}

function parseCategories(frontmatter) {
  const inline = frontmatter.match(/^categories:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  const block = frontmatter.match(/^categories:\s*\n((?:\s*-\s*.+\n?)+)/m);
  if (block) {
    return block[1]
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

const FZ_RE = /(?<!\d)(\d{1,4})[\-‑]ФЗ/g;
const PP_RE = /(?:[Пп]остановлен[а-я]+\s+[Пп]равительства(?:\s+РФ)?|ПП(?:\s+РФ)?)\s*(?:от\s+\d{1,2}[.\/]\d{1,2}[.\/]\d{4}\s+)?№\s*(\d{1,4})/giu;
// Ведомство — отдельная захватывающая группа, не (?:...). Номер приказа не
// уникален между ведомствами: приказ № 2044 у ФНС (2017, реестр ОФД) и у
// Минпромторга (2025, правила совместимости ТС ПИоТ) — разные документы под
// одним номером. Без ведомства whitelist не может их различить.
const PRIKAZ_RE = /[Пп]риказ[а-я]*\s+(Минфина|ФНС|Минпромторга|Роспотребнадзора|Минцифры|Минтруда|ЦБ\s+РФ|Минсельхоза)[а-я\s]*(?:№|N)\s*([\w\-\/]+)/giu;

const findings = { fz: [], pp: [], prikaz: [], topicMismatch: [], ambiguousPrikaz: [] };
const seenByType = { fz: new Set(), pp: new Set(), prikaz: new Set() };

function parseBody(text) {
  const m = text.match(/^---\n[\s\S]*?\n---/);
  return m ? text.slice(m[0].length) : text;
}

const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));

for (const f of files) {
  const text = fs.readFileSync(path.join(BLOG_DIR, f), 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  // Черновики не пропускаем: /create-article Стадия 3 гоняет этот же
  // скрипт на статье, которая ещё draft: true, — пропуск драфтов делал
  // бы этот шлюз молчаливым no-op именно там, где он нужнее всего:
  // до публикации, пока номер ещё можно поправить без второго коммита.
  const body = parseBody(text);
  const slug = f.replace(/\.(md|mdx)$/, '');
  const categories = fmMatch ? parseCategories(fmMatch[1]) : [];
  const allowed = allowedTopics(categories);

  // Номер есть в whitelist, но норма из чужой темы — не ошибка номера,
  // а повод для ручной проверки: тот ли НПА процитирован.
  function checkTopicEntry(type, num, entry) {
    if (!categories.length || !entry?.topic) return;
    if (allowed.has(entry.topic)) return;
    findings.topicMismatch.push({
      slug,
      type,
      num,
      topic: entry.topic,
      title: entry.title,
      categories,
    });
  }
  function checkTopic(type, num) {
    const entry = WHITELIST_BY_TYPE[type]?.[num];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    checkTopicEntry(type, num, entry);
  }

  for (const m of body.matchAll(FZ_RE)) {
    const num = m[1];
    seenByType.fz.add(num);
    if (!knownFz.has(num)) findings.fz.push({ slug, num, raw: m[0] });
    else checkTopic('fz', num);
  }
  for (const m of body.matchAll(PP_RE)) {
    const num = m[1];
    seenByType.pp.add(num);
    if (!knownPp.has(num)) findings.pp.push({ slug, num, raw: m[0] });
    else checkTopic('pp', num);
  }
  for (const m of body.matchAll(PRIKAZ_RE)) {
    const issuerRaw = m[1];
    const num = m[2];
    seenByType.prikaz.add(num);
    if (!knownPrikaz.has(num)) {
      findings.prikaz.push({ slug, num, raw: m[0] });
      continue;
    }
    const entry = WHITELIST_BY_TYPE.prikaz[num];
    if (!Array.isArray(entry)) {
      checkTopic('prikaz', num);
      continue;
    }
    // Номер общий на несколько ведомств — сопоставляем по ведомству, которое
    // сама статья и назвала. Регэксп ведомства фиксированный список, поэтому
    // точное совпадение (без учёта регистра), а не догадка по подстроке.
    const match = entry.find((e) => e.issuer.toLowerCase() === issuerRaw.toLowerCase());
    if (!match) {
      // Не должно происходить: issuerRaw пришёл из той же альтернативы, что
      // и entry.issuer. Если всё же не совпало — не глотаем молча.
      findings.ambiguousPrikaz.push({
        slug, num, issuer: issuerRaw, raw: m[0],
        candidates: entry.map((e) => `${e.issuer} — ${e.title}`),
      });
      continue;
    }
    checkTopicEntry('prikaz', num, match);
  }
}

const strict = process.argv.includes('--strict');
const totalUnknown = findings.fz.length + findings.pp.length + findings.prikaz.length;

console.log(`Просмотрено статей: ${files.length}`);
console.log(`Уникальных ФЗ:      ${seenByType.fz.size} (whitelist: ${knownFz.size})`);
console.log(`Уникальных ПП:      ${seenByType.pp.size} (whitelist: ${knownPp.size})`);
console.log(`Уникальных Приказов:${seenByType.prikaz.size} (whitelist: ${knownPrikaz.size})`);
console.log('');

const sections = [
  ['ФЗ', findings.fz],
  ['ПП', findings.pp],
  ['Приказы', findings.prikaz],
];

for (const [name, items] of sections) {
  if (!items.length) continue;
  console.log(`\n=== ${name}: ${items.length} незнакомых упоминаний ===`);
  const byNum = new Map();
  for (const it of items) {
    if (!byNum.has(it.num)) byNum.set(it.num, []);
    byNum.get(it.num).push(it.slug);
  }
  for (const [num, slugs] of [...byNum.entries()].sort()) {
    console.log(`  № ${num} → ${slugs.length} упоминаний:`);
    for (const s of [...new Set(slugs)].slice(0, 3)) console.log(`    ${s}`);
    if (new Set(slugs).size > 3) console.log(`    ...и ещё ${new Set(slugs).size - 3}`);
  }
}

if (files.length === 0) {
  // Не «всё чисто» — проверять было нечего. На пустом src/content/blog/
  // exit 0 в --strict молча проходит CI, ничего не подтвердив (см.
  // docs/audit-2026-08-04.md — тот же класс ложно-зелёного результата).
  console.log('\n⚠ Статей нет — аудит НПА ничего не проверил.');
} else if (totalUnknown === 0) {
  console.log('\n✓ Все упоминания НПА в whitelist.');
} else {
  console.log(`\n⚠ Незнакомых НПА: ${totalUnknown}. Проверь и добавь в src/data/factcheck/sources.json.npaWhitelist или исправь статьи.`);
}

// Одно и то же несовпадение повторяется на каждое упоминание в тексте —
// в отчёт выводим по одному разу на связку статья+норма.
const uniqueMismatch = [
  ...new Map(findings.topicMismatch.map((it) => [`${it.slug}|${it.type}|${it.num}`, it])).values(),
];

if (uniqueMismatch.length) {
  console.log(`\n=== needs-decision: тема нормы не совпадает с категорией статьи (${uniqueMismatch.length}) ===`);
  console.log('Номер настоящий и есть в whitelist — проверь вручную, тот ли НПА процитирован.\n');
  for (const it of uniqueMismatch.sort((a, b) => a.slug.localeCompare(b.slug))) {
    console.log(`  ${it.slug} [${it.categories.join(', ')}]`);
    console.log(`    ${it.type.toUpperCase()} № ${it.num} — topic: ${it.topic}${it.title ? ` (${it.title})` : ''}`);
  }
}

if (findings.ambiguousPrikaz.length) {
  console.log(`\n=== needs-decision: ведомство не сматчилось со whitelist (${findings.ambiguousPrikaz.length}) ===`);
  for (const it of findings.ambiguousPrikaz) {
    console.log(`  ${it.slug}: «${it.raw}» — ведомство «${it.issuer}» не найдено среди вариантов номера ${it.num}:`);
    for (const c of it.candidates) console.log(`    - ${c}`);
  }
}

writeReportIfChanged(
  'src/data/factcheck/audit/npa-references.json',
  {
    generatedAt: new Date().toISOString(),
    totals: {
      files: files.length,
      unknownFz: findings.fz.length,
      unknownPp: findings.pp.length,
      unknownPrikaz: findings.prikaz.length,
      topicMismatch: uniqueMismatch.length,
      ambiguousPrikaz: findings.ambiguousPrikaz.length,
    },
    findings: { ...findings, topicMismatch: uniqueMismatch },
  },
);

if (strict && totalUnknown > 0) process.exit(1);
