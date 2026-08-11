/**
 * Разворачивание внутренних ссылок статьи в адреса, по которым можно кликнуть.
 *
 * В статьях перелинковка записана от корня: «/blog/<слаг>». Своего сайта у
 * модуля нет, поэтому в Google Doc такая ссылка превращалась в
 * «http:///blog/…» — битую в каждом документе, который открывает редактор.
 *
 * Но данные для нормальной ссылки в проекте есть, и я их сначала не
 * посмотрел: `src/data/interlinking/market-articles.json` — выгрузка 1348
 * материалов Контур.Маркета с реальными URL. Если статья, на которую
 * ссылаемся, уже покрыта материалом Маркета, ссылка должна вести туда:
 * редактор и читатель попадают на живой текст, а не в пустоту.
 *
 * Порядок разрешения:
 *   1. BLOG_BASE_URL — если принимающий проект назвал свой домен, он главнее
 *      всего: это и есть место, где статья появится.
 *   2. Каталог Маркета — по совпадению заголовка целевой статьи с заголовком
 *      материала Контура. Порог намеренно высокий: ссылка «примерно на ту же
 *      тему» хуже отсутствия ссылки, потому что выглядит правильной.
 *   3. Ничего не нашли — ссылки нет, текст остаётся текстом.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize, jaccard } from './text-similarity.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const BLOG_DIR = join(ROOT, 'src/content/blog');
const CATALOG = join(ROOT, 'src/data/interlinking/market-articles.json');

// Порог совпадения заголовков. 0.5 — это уже «та же тема другими словами»,
// ниже начинается «про то же вообще»: там ссылку ставить нельзя.
export const MATCH_THRESHOLD = 0.5;

let catalogCache = null;
function catalog() {
  if (catalogCache) return catalogCache;
  if (!existsSync(CATALOG)) return (catalogCache = []);
  const raw = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const items = Array.isArray(raw) ? raw : (raw.articles ?? []);
  catalogCache = items.map((a) => ({ ...a, tokens: tokenize(a.title || '') }));
  return catalogCache;
}

/** Заголовок статьи репозитория по слагу из ссылки. */
function titleOfLocalArticle(slug) {
  if (!existsSync(BLOG_DIR)) return null;
  const bare = slug.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const file = readdirSync(BLOG_DIR).find((f) => {
    const name = f.replace(/\.mdx?$/, '');
    return name === slug || name.replace(/^\d{4}-\d{2}-\d{2}-/, '') === bare;
  });
  if (!file) return null;
  const md = readFileSync(join(BLOG_DIR, file), 'utf8');
  return md.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? null;
}

/**
 * @returns {{url: string, via: 'base'|'market'} | null} — null означает
 *          «ссылку не ставить», а не ошибку.
 */
export function resolveInternalLink(href, { blogBase = process.env.BLOG_BASE_URL || '' } = {}) {
  if (!href.startsWith('/')) return { url: href, via: 'external' };
  if (blogBase) return { url: blogBase.replace(/\/$/, '') + href, via: 'base' };

  const slug = href.replace(/^\/blog\//, '').replace(/^\//, '');
  const title = titleOfLocalArticle(slug);
  if (!title) return null;

  const q = tokenize(title);
  let best = null;
  for (const a of catalog()) {
    const score = jaccard(q, a.tokens);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { ...a, score };
  }
  return best ? { url: best.url, via: 'market', score: best.score, title: best.title } : null;
}
