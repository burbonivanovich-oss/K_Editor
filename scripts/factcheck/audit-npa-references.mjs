#!/usr/bin/env node
// Регрессионный аудит: пробегает по всем опубликованным статьям и сравнивает
// упоминания НПА (ПП, Приказы, ФЗ) с whitelist из sources.json. Помечает
// незнакомые номера для ручной проверки. Это страховка против повторения
// случая с фейковыми ПП (№ 257, № 2456, № 2457).
//
// Использование:
//   node scripts/factcheck/audit-npa-references.mjs           # отчёт
//   node scripts/factcheck/audit-npa-references.mjs --strict  # exit 1 если есть неизвестные (для CI)

import fs from 'node:fs';
import path from 'node:path';

const BLOG_DIR = 'src/content/blog';
const SOURCES = JSON.parse(fs.readFileSync('src/data/factcheck/sources.json', 'utf8'));

const knownFz = new Set(Object.keys(SOURCES.npaWhitelist.fz));
const knownPp = new Set(Object.keys(SOURCES.npaWhitelist.pp));
const knownPrikaz = new Set(Object.keys(SOURCES.npaWhitelist.prikaz));

const FZ_RE = /(?<!\d)(\d{1,4})[\-‑]ФЗ/g;
const PP_RE = /(?:[Пп]остановлен[а-я]+\s+[Пп]равительства(?:\s+РФ)?|ПП(?:\s+РФ)?)\s*(?:от\s+\d{1,2}[.\/]\d{1,2}[.\/]\d{4}\s+)?№\s*(\d{1,4})/giu;
const PRIKAZ_RE = /[Пп]риказ[а-я]*\s+(?:Минфина|ФНС|Минпромторга|Роспотребнадзора|Минцифры|Минтруда|ЦБ\s+РФ|Минсельхоза)[а-я\s]*(?:№|N)\s*([\w\-\/]+)/giu;

const findings = { fz: [], pp: [], prikaz: [] };
const seenByType = { fz: new Set(), pp: new Set(), prikaz: new Set() };

function parseBody(text) {
  const m = text.match(/^---\n[\s\S]*?\n---/);
  return m ? text.slice(m[0].length) : text;
}

const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));

for (const f of files) {
  const text = fs.readFileSync(path.join(BLOG_DIR, f), 'utf8');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch && /^draft:\s*true/m.test(fmMatch[1])) continue;
  const body = parseBody(text);
  const slug = f.replace(/\.(md|mdx)$/, '');

  for (const m of body.matchAll(FZ_RE)) {
    const num = m[1];
    seenByType.fz.add(num);
    if (!knownFz.has(num)) findings.fz.push({ slug, num, raw: m[0] });
  }
  for (const m of body.matchAll(PP_RE)) {
    const num = m[1];
    seenByType.pp.add(num);
    if (!knownPp.has(num)) findings.pp.push({ slug, num, raw: m[0] });
  }
  for (const m of body.matchAll(PRIKAZ_RE)) {
    const num = m[1];
    seenByType.prikaz.add(num);
    if (!knownPrikaz.has(num)) findings.prikaz.push({ slug, num, raw: m[0] });
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

if (totalUnknown === 0) {
  console.log('\n✓ Все упоминания НПА в whitelist.');
} else {
  console.log(`\n⚠ Незнакомых НПА: ${totalUnknown}. Проверь и добавь в src/data/factcheck/sources.json.npaWhitelist или исправь статьи.`);
}

fs.mkdirSync('src/data/factcheck/audit', { recursive: true });
fs.writeFileSync(
  'src/data/factcheck/audit/npa-references.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        files: files.length,
        unknownFz: findings.fz.length,
        unknownPp: findings.pp.length,
        unknownPrikaz: findings.prikaz.length,
      },
      findings,
    },
    null,
    2,
  ) + '\n',
);

if (strict && totalUnknown > 0) process.exit(1);
