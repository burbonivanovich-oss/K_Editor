#!/usr/bin/env node
/**
 * Исходные данные для ТЗ дизайнеру — детерминированная часть
 * `/design-brief`.
 *
 * Само ТЗ пишет сессия: выбрать сюжет обложки и решить, какой раздел
 * разгрузит схема, — это рассуждение. А вот структуру статьи, её таблицы,
 * даты и суммы можно достать разбором, и это лучше делать скриптом:
 * иначе агент перечитывает статью глазами и половину пропускает, а
 * дизайнер получает ТЗ с картинкой к разделу, которого в тексте нет.
 *
 * Запуск:
 *   node scripts/design-brief.mjs <slug>
 *   node scripts/design-brief.mjs <slug> --json
 *
 * Код возврата 1 — статьи нет или в ней нечего иллюстрировать.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(ROOT, 'src', 'content', 'blog');
const VISUALS_DIR = join(ROOT, 'src', 'data', 'visuals');

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const asJson = args.includes('--json');

if (!slug) {
  console.error('Использование: node scripts/design-brief.mjs <slug> [--json]');
  process.exit(1);
}

/* Slug принимаем и с датой, и без неё: в таблице плана тема живёт под
   голым slug, а файл статьи называется YYYY-MM-DD-slug. Ровно то место,
   где release-article.mjs раньше не находил тему цикла. */
const files = existsSync(BLOG_DIR) ? readdirSync(BLOG_DIR).filter((f) => /\.mdx?$/.test(f)) : [];
const file = files.find((f) => f.replace(/\.mdx?$/, '') === slug)
  || files.find((f) => f.replace(/\.mdx?$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '') === slug);

if (!file) {
  console.error(`Нет статьи для «${slug}» в src/content/blog/`);
  process.exit(1);
}

const raw = readFileSync(join(BLOG_DIR, file), 'utf8');
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
const fm = fmMatch ? fmMatch[1] : '';
const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

const field = (name) => {
  const m = fm.match(new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, 'm'));
  return m ? m[1] : null;
};
/** Первый элемент YAML-списка вида "categories:\n  - kkt". */
const firstListItem = (name) => {
  const m = fm.match(new RegExp(`^${name}:\\n((?:\\s+-\\s+.*\\n)+)`, 'm'));
  return m ? m[1].trim().replace(/^-\s+/, '').split('\n')[0].trim() : null;
};

const words = body.split(/\s+/).filter(Boolean).length;
if (words < 300) {
  console.error(`В статье ${file} всего ${words} слов — иллюстрировать нечего.`);
  process.exit(1);
}

const sections = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());

/* Кандидаты на схемы: разделы, где уже есть таблица или нумерованный
   список. Ровно они чаще всего и просятся в инфографику, а разделы со
   сплошным текстом — наоборот, картинкой не спасаются. */
const blocks = body.split(/^##\s+/m).slice(1);
const enriched = blocks.map((b) => {
  const [head, ...rest] = b.split('\n');
  const text = rest.join('\n');
  return {
    section: head.trim(),
    hasTable: /^\|.+\|$/m.test(text),
    hasNumberedList: /^\d+\.\s+/m.test(text),
    hasBulletList: /^[-*]\s+/m.test(text),
    words: text.split(/\s+/).filter(Boolean).length,
  };
});

/* Даты и суммы — материал для врезок и таймлайнов. Дизайнеру их нужно
   отдать выписанными: искать их в тексте статьи — не его работа. */
const dates = [...new Set(body.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || [])];
const money = [...new Set(body.match(/\b\d[\d\s  ]*(?:₽|рубл\w*)/g) || [])].map((s) =>
  s.replace(/\s+/g, ' ').trim(),
);
const percents = [...new Set(body.match(/\b\d+(?:[.,]\d+)?\s?%/g) || [])];

const visualsDraft = join(VISUALS_DIR, `${file.replace(/\.mdx?$/, '')}.md`);

const out = {
  slug: file.replace(/\.mdx?$/, ''),
  file: `src/content/blog/${file}`,
  title: field('title'),
  description: field('description'),
  cluster: firstListItem('categories'),
  draft: /^draft:\s*true/m.test(fm),
  words,
  sections,
  candidates: {
    // Схема просится туда, где есть структура и много текста разом.
    forDiagram: enriched.filter((s) => s.hasNumberedList || s.hasTable).map((s) => s.section),
    // Раздел без структуры и длинный — кандидат на разгрузку картинкой.
    heavyText: enriched.filter((s) => !s.hasTable && !s.hasNumberedList && s.words > 200).map((s) => s.section),
    // Таблица уже работает — иллюстрация туда обычно лишняя.
    alreadyTabular: enriched.filter((s) => s.hasTable).map((s) => s.section),
  },
  facts: { dates, money, percents },
  visualsDraft: existsSync(visualsDraft) ? `src/data/visuals/${file.replace(/\.mdx?$/, '')}.md` : null,
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`Статья:      ${out.title}`);
  console.log(`Файл:        ${out.file}${out.draft ? '  ⚠ ещё draft: true' : ''}`);
  console.log(`Кластер:     ${out.cluster ?? '—'}   Слов: ${out.words}`);
  console.log(`\nРазделы (${sections.length}):`);
  for (const s of enriched) {
    const marks = [
      s.hasTable ? 'таблица' : null,
      s.hasNumberedList ? 'шаги' : null,
      s.hasBulletList ? 'список' : null,
    ].filter(Boolean);
    console.log(`  • ${s.section}  [${s.words} сл.${marks.length ? ', ' + marks.join(', ') : ''}]`);
  }
  console.log('\nПод схему:   ' + (out.candidates.forDiagram.join('; ') || '—'));
  console.log('Разгрузить:  ' + (out.candidates.heavyText.join('; ') || '—'));
  console.log('Таблица уже есть (картинка скорее лишняя): ' + (out.candidates.alreadyTabular.join('; ') || '—'));
  console.log('\nДаты:        ' + (dates.join(', ') || '—'));
  console.log('Суммы:       ' + (money.join(', ') || '—'));
  console.log('Проценты:    ' + (percents.join(', ') || '—'));
  console.log('\nЧерновик визуала: ' + (out.visualsDraft ?? 'нет — писать ТЗ с нуля'));
  if (out.draft) {
    console.log('\n⚠ Статья ещё черновик. ТЗ делается по принятому редактором тексту:');
    console.log('  после правок разделы часто меняются, и иллюстрация повиснет на исчезнувшем H2.');
  }
}
