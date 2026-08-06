// Простое токен-сравнение (Jaccard) для сопоставления тем/заголовков без
// внешних сервисов эмбеддингов — история п.42 в бэклоге (embeddings
// пробовали и откатили, JINA/OPENAI ключи не использовались). Общий модуль
// для check-market-duplication.mjs и generate-backlog.mjs, чтобы не
// разъезжались два независимых определения одного и того же сравнения.

// Минимальный стоп-лист — не претендует на полноту, только убирает самый
// частый шум, который иначе раздувает пересечение между несвязанными темами.
const STOPWORDS = new Set([
  'и', 'в', 'на', 'с', 'по', 'для', 'от', 'до', 'из', 'к', 'о', 'об', 'у',
  'а', 'но', 'или', 'не', 'же', 'ли', 'бы', 'то', 'это', 'эти', 'этот', 'эта',
  'что', 'как', 'какой', 'какие', 'кто', 'кому', 'чего', 'все', 'всё', 'вся',
  'при', 'за', 'уже', 'если', 'нужно', 'нужен', 'нужна', 'можно', 'года',
  'году', 'год',
]);

export function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[«»"'.,:;!?()–—/№]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a, b) {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Топ-N совпадений title'а запроса с каталогом статей ({title, ...}[]). */
export function topMatches(query, catalog, { threshold = 0.3, limit = 5, titleKey = 'title' } = {}) {
  const queryTokens = tokenize(query);
  return catalog
    .map((item) => ({ ...item, score: jaccard(queryTokens, tokenize(item[titleKey] || '')) }))
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
