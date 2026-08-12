/**
 * Автоматическая проверка текста на AI-маркеры (русский язык).
 *
 * Запуск:
 *   node scripts/check-ai-markers.mjs <файл.md>
 *   node scripts/check-ai-markers.mjs src/content/blog/   # вся папка
 *
 * Флаги:
 *   --threshold=N      порог скора для exit(1) (по умолчанию 6)
 *   --json             вывод в JSON
 */
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Меняется при смене формулы regex-скора, порогов structuralSuggestions
// или схемы profile-файла — AI-01: профиль без версии анализатора
// нельзя честно сравнить с прогоном после следующей правки скрипта.
const ANALYZER_VERSION = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Regex-маркеры: [regex, вес, замена] ──────────────────────────────────────

/* Граница слова для русского текста.
 *
 * `\b` в JS считает границей переход между [A-Za-z0-9_] и всем
 * остальным, а кириллица в \w не входит. Поэтому /\bявляется\b/ не
 * совпадает НИКОГДА: перед «я» нет перехода «не-слово → слово».
 * Одиннадцать паттернов ниже — «является», «данный», «осуществляется» и
 * их родня, то есть ровно то, что в редполитике стоит первым номером, —
 * молчали с самого начала (найдено аудитом 12.08.2026).
 *
 * Заменяем на явные просмотры: слева и справа не должно быть буквы. */
const B = '(?<![а-яёА-ЯЁa-zA-Z])';
const E = '(?![а-яёА-ЯЁa-zA-Z])';
const ru = (body, flags = 'gi') => new RegExp(B + body + E, flags);

const MARKERS = [
  // Вводные клише
  [/следует\s+отметить/gi,                    2, 'удалить или переформулировать'],
  [/важно\s+(?:понимать|отметить|учитывать)/gi, 2, 'удалить или конкретизировать'],
  [/необходимо\s+(?:учитывать|отметить)/gi,   2, 'удалить'],
  [/в\s+заключени[ие]\s+(?:можно|следует)/gi, 3, 'просто написать вывод без вводного'],
  [/подводя\s+итог/gi,                         2, 'удалить'],
  [/таким\s+образом[,\s]/gi,                   1, 'убрать или заменить конкретным выводом'],
  [/вместе\s+с\s+тем/gi,                       1, 'удалить или «но»'],
  [/помимо\s+этого/gi,                          1, 'удалить или «ещё»'],
  [/в\s+данном\s+контексте/gi,                 2, 'удалить'],
  [/одним\s+из\s+ключевых/gi,                  2, 'сказать конкретно что именно'],
  [/ключевым\s+аспектом\s+является/gi,         2, 'переформулировать'],

  // Пассивные глаголы
  [ru('является'),                              1, 'заменить на тире или живой глагол'],
  [ru('являются'),                              1, 'заменить на тире или живой глагол'],
  [ru('осуществля[ея]тся'),                     2, 'заменить на конкретный глагол'],
  [ru('осуществлять'),                          1, 'заменить: делать, вести, проводить'],
  [ru('реализуется'),                           1, 'выполняется, работает'],
  [ru('производится'),                          1, 'делается, происходит'],
  [ru('применяется'),                           1, 'используется, действует'],

  // Канцелярные существительные
  [ru('данный'),                                1, '→ этот'],
  [ru('данная'),                                1, '→ эта'],
  [ru('данное'),                                1, '→ это'],
  [ru('данные(?!\\s+(?:из|о|по|за|в|от))'),      1, '→ эти (если не «данные» как существительное)'],
  [/актуальным\s+является/gi,                   2, 'удалить'],
  [/немаловажным\s+является/gi,                 2, 'удалить'],
  [/в\s+настоящее\s+время/gi,                   1, '→ сейчас'],
  [/на\s+сегодняшний\s+день/gi,                 1, '→ сейчас или конкретная дата'],
  [/надлежащим\s+образом/gi,                    2, '→ как положено или удалить'],
  [/в\s+полном\s+объёме/gi,                     1, '→ полностью или удалить'],
  [/конечн(?:ый|ого|ому)\s+потребител/gi,       2, '→ покупатель'],
  [/в\s+рамках\s+(?:данной|настоящей)/gi,       2, '→ в статье, здесь'],

  // Оценочные клише
  [/играет\s+(?:важную|ключевую|значительную)\s+роль/gi, 2, 'сказать конкретно что и как'],
  [/оказывает\s+(?:существенное|значительное|важное)\s+влияние/gi, 2, 'как именно влияет?'],
  [/в\s+целом\s+можно\s+сказать/gi,             2, 'удалить'],
  [/как\s+правило[,\s]/gi,                       1, 'проверить: это всегда так? если да — убрать'],
];

// ── Вспомогательные функции ───────────────────────────────────────────────────

function stripFrontmatter(content) {
  return content.replace(/^---[\s\S]*?---\n/, '');
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/#{1,6}\s/g, '');
}

// ── Regex-анализ ──────────────────────────────────────────────────────────────

function analyzeRegex(text, filename) {
  const withoutFrontmatter = stripFrontmatter(text);
  const body = stripMarkdown(withoutFrontmatter);

  const hits = [];
  let totalWeight = 0;

  for (const [re, weight, fix] of MARKERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const lineNo = body.slice(0, m.index).split('\n').length;
      hits.push({ line: lineNo, phrase: m[0], fix, weight });
      totalWeight += weight;
    }
  }

  const paragraphs = body.split(/\n\n+/).filter(p => p.trim().length > 50);
  const paraLengths = paragraphs.map(p => p.split(/[.!?]/).filter(s => s.trim()).length);
  const avgLen = paraLengths.reduce((a, b) => a + b, 0) / (paraLengths.length || 1);
  const variance = paraLengths.reduce((a, b) => a + Math.abs(b - avgLen), 0) / (paraLengths.length || 1);
  const uniformParagraphs = variance < 0.8 && paragraphs.length > 4;

  const rawScore = Math.min(10, Math.round(totalWeight / 3));
  // sectionSymmetry ищет заголовки ## — stripMarkdown их уже вырезал
  // (нужно для чистых regex-совпадений клише), поэтому считаем секции
  // по тексту без frontmatter, но с исходной markdown-разметкой.
  const structure = {
    rhythm: sentenceRhythm(body),
    sections: sectionSymmetry(withoutFrontmatter),
    ngrams: ngramRepetition(body),
  };
  return { filename, hits, totalWeight, rawScore, uniformParagraphs, structure, body };
}

// ── Структурные измерения (без клише, без внешнего корпуса) ──────────────
//
// Внешний аудит проекта (2026-08-05) предложил многомерную оценку
// «AI-likeness» с калибровкой на размеченном редакторами корпусе. Блог
// пока пуст — калибровать не на чем. Эти три измерения посчитаны, но
// сознательно НЕ участвуют в rawScore/threshold и не несут вердикт
// «это AI»: без корпуса любой порог — угадывание, а не измерение.
// Печатаются как справочные числа; когда наберётся корпус статей,
// здесь можно подобрать пороги и завести их в общий скор.

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Однородность длины предложений (в словах) — коэффициент вариации. */
function sentenceRhythm(body) {
  const sentences = splitSentences(body).filter((s) => s.split(/\s+/).filter(Boolean).length >= 3);
  if (sentences.length < 8) return null;
  const lengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const m = mean(lengths);
  const sd = stdDev(lengths);
  return { sentenceCount: sentences.length, meanWords: Number(m.toFixed(1)), cv: Number((m > 0 ? sd / m : 0).toFixed(2)) };
}

/** Структурная симметрия H2-секций: разброс объёма между соседними разделами. */
function sectionSymmetry(body) {
  const parts = body.split(/^##\s+.+$/m).slice(1);
  if (parts.length < 4) return null;
  const wordCounts = parts.map((p) => p.trim().split(/\s+/).filter(Boolean).length);
  const m = mean(wordCounts);
  const sd = stdDev(wordCounts);
  return { sectionCount: parts.length, meanWords: Math.round(m), cv: Number((m > 0 ? sd / m : 0).toFixed(2)) };
}

/** Повтор словосочетаний (n-грамм из n слов) — дословные клише-переходы. */
function ngramRepetition(body, n = 4) {
  const words = body.toLowerCase().replace(/[«»"'.,:;!?()]/g, '').split(/\s+/).filter(Boolean);
  if (words.length < n * 10) return null;
  const counts = new Map();
  for (let i = 0; i <= words.length - n; i++) {
    const g = words.slice(i, i + n).join(' ');
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const total = words.length - n + 1;
  const repeatedOccurrences = [...counts.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);
  const topRepeats = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([phrase, count]) => ({ phrase, count }));
  return { totalNgrams: total, uniqueRatio: Number((1 - repeatedOccurrences / total).toFixed(2)), topRepeats };
}

// ── Редакторские действия по структурным сигналам (AI-05) ────────────────────
//
// Регэксп-хиты уже несут конкретное действие (поле fix — «удалить»,
// «заменить конкретным выводом» и т.п.), структурные метрики раньше
// были просто числами без совета. Пороги — эвристика, не калибровка:
// та же оговорка, что у самих метрик (см. комментарий у sentenceRhythm
// и соседей) — «справочно», не блокер, ничего не решают за автора.
function structuralSuggestions({ rhythm, sections, ngrams }) {
  const out = [];
  if (rhythm && rhythm.cv < 0.2) {
    out.push({
      signal: 'ритм предложений',
      action: 'перестроить: объединить часть коротких предложений и разбить часть длинных',
      why: `сейчас cv=${rhythm.cv} — предложения почти одинаковой длины (${rhythm.sentenceCount} шт., в среднем ${rhythm.meanWords} слов); разброс поднимет cv выше 0.2`,
    });
  }
  if (sections && sections.cv < 0.2) {
    out.push({
      signal: 'симметрия секций',
      action: 'сжать одни H2-разделы и раскрыть другие конкретными примерами/кейсами',
      why: `сейчас cv=${sections.cv} — все ${sections.sectionCount} секции почти одного объёма (в среднем ${sections.meanWords} слов), как будто написаны по шаблону`,
    });
  }
  if (ngrams && ngrams.uniqueRatio < 0.9 && ngrams.topRepeats.length) {
    const top = ngrams.topRepeats[0];
    out.push({
      signal: 'повтор словосочетаний',
      action: `добавить авторское решение: заменить часть повторов «${top.phrase}» (×${top.count}) синонимом или конкретикой`,
      why: `уникальность 4-грамм ${ngrams.uniqueRatio} (1.0 — повторов нет); частые дословные повторы читаются как шаблонность`,
    });
  }
  return out;
}

// ── Профиль AI-маркеров по статье (AI-01) ─────────────────────────────────────
//
// Опционально, только по флагу --save-profile (main()). Нужен, чтобы сравнить
// «до» и «после» редакторской правки одной и той же статьи — без сохранённой
// истории каждый прогон видит только текущий срез и не может сказать, стало
// ли лучше. ANALYZER_VERSION в профиле — чтобы после смены формулы скора
// не сравнивать несравнимое между собой.

function profilePath(root, slug) {
  return path.join(root, 'src', 'data', 'ai-profile', `${slug}.json`);
}

// AI_PROFILE_ROOT — тот же паттерн, что RELEASE_DATA_ROOT/HEALTH_CHECK_ROOT/
// CYCLE_STATE_PATH: позволяет тестам подставить временную директорию, чтобы
// --save-profile не писал в src/data/ai-profile/ настоящего репозитория
// (T-01 — тесты не должны трогать рабочее дерево).
function saveProfile(file, { regex, finalScore, suggestions }) {
  const root = process.env.AI_PROFILE_ROOT || path.join(__dirname, '..');
  const base = path.basename(file).replace(/\.mdx?$/, '');
  const dir  = path.join(root, 'src', 'data', 'ai-profile');
  const target = profilePath(root, base);

  let history = [];
  if (fs.existsSync(target)) {
    try {
      const prev = JSON.parse(fs.readFileSync(target, 'utf8'));
      history = prev.history ?? [];
      history.push({
        checkedAt: prev.checkedAt,
        analyzerVersion: prev.analyzerVersion,
        finalScore: prev.finalScore,
        regexScore: prev.regexScore,
        hits: prev.hits,
      });
    } catch {
      // Битый/несовместимый старый профиль — не блокируем сохранение нового,
      // просто теряем историю до этой точки.
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    slug: base,
    analyzerVersion: ANALYZER_VERSION,
    checkedAt: new Date().toISOString().slice(0, 10),
    regexScore: regex.rawScore,
    finalScore,
    hits: regex.hits.length,
    structure: regex.structure,
    suggestions,
    history,
  }, null, 2) + '\n');
}


// ── Итоговый скор ─────────────────────────────────────────────────────────────

function scoreLabel(s) {
  if (s <= 2) return 'Публиковать без правок';
  if (s <= 5) return 'Заменить стоп-фразы, проверить структуру';
  if (s <= 8) return 'Переписать проблемные секции';
  return 'Переписать статью целиком';
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Обёрнуто в main() и запускается только при прямом вызове, не при
// импорте — тесты импортируют analyzeRegex/sentenceRhythm/etc. напрямую,
// без побочных эффектов вроде process.exit() или чтения файлов по argv.

async function main() {

const args  = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const THRESHOLD  = parseInt(flags.threshold ?? '6', 10);
const AS_JSON    = flags.json === true;
// Опционально (AI-01) — не по умолчанию: release-article.mjs гоняет
// этот скрипт как P0-гейт на каждом релизе, и гейт не должен обзаводиться
// побочными эффектами (запись в src/data/ai-profile/) без явного запроса.
// /create-article Стадия 4 включает флаг сама, когда нужен профиль.
const SAVE_PROFILE = flags['save-profile'] === true;

if (!args[0]) {
  console.error('Использование: node scripts/check-ai-markers.mjs <файл.md или папка>');
  process.exit(1);
}

const target = path.resolve(args[0]);
const files  = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(f => f.endsWith('.md')).map(f => path.join(target, f))
  : [target];

const results = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const label   = path.relative(process.cwd(), file);
  const regex   = analyzeRegex(content, label);

  const finalScore = regex.rawScore;

  const suggestions = structuralSuggestions(regex.structure);

  results.push({ label, regex, finalScore, suggestions });

  if (SAVE_PROFILE) {
    saveProfile(file, { regex, finalScore, suggestions });
  }
}

// ── Вывод ─────────────────────────────────────────────────────────────────────

if (AS_JSON) {
  console.log(JSON.stringify(results.map(r => ({
    file: r.label,
    regexScore: r.regex.rawScore,
    finalScore: r.finalScore,
    hits: r.regex.hits.length,
    structure: r.regex.structure, // справочно, не в finalScore — см. комментарий в analyzeRegex
    suggestions: r.suggestions,
  })), null, 2));
  process.exit(results.some(r => r.finalScore >= THRESHOLD) ? 1 : 0);
}

let anyAboveThreshold = false;

for (const { label, regex, finalScore, suggestions } of results) {
  if (finalScore >= THRESHOLD) anyAboveThreshold = true;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Файл:        ${label}`);
  console.log(`Скор:        ${finalScore}/10  — ${scoreLabel(finalScore)}`);

  if (regex.uniformParagraphs) {
    console.log('Структура:   абзацы однородной длины (признак AI)');
  }

  // Справочные метрики без порога — см. комментарий у analyzeRegex.
  const { rhythm, sections, ngrams } = regex.structure;
  if (rhythm || sections || ngrams) {
    console.log('\nСтруктурные метрики (не откалибровано, справочно):');
    if (rhythm) console.log(`  Ритм предложений:  cv=${rhythm.cv}, ${rhythm.sentenceCount} предл., в среднем ${rhythm.meanWords} слов`);
    if (sections) console.log(`  Симметрия секций:  cv=${sections.cv}, ${sections.sectionCount} секций, в среднем ${sections.meanWords} слов`);
    if (ngrams) {
      console.log(`  Повтор словосочетаний: уникальность ${ngrams.uniqueRatio} (1.0 = повторов нет)`);
      for (const t of ngrams.topRepeats) console.log(`    ×${t.count}  «${t.phrase}»`);
    }
  }

  if (suggestions.length > 0) {
    console.log('\nЧто сделать по структурным сигналам (AI-05, эвристика, не блокер):');
    for (const s of suggestions) {
      console.log(`  → [${s.signal}] ${s.action}`);
      console.log(`     ${s.why}`);
    }
  }

  // Regex-хиты
  if (regex.hits.length > 0) {
    console.log(`\nСтоп-фразы (${regex.hits.length} вхождений):\n`);
    console.log('Стр.'.padEnd(6) + 'Фраза'.padEnd(45) + 'Замена');
    console.log('─'.repeat(90));
    for (const h of regex.hits.sort((a, b) => a.line - b.line)) {
      console.log(String(h.line).padEnd(6) + h.phrase.padEnd(45) + h.fix);
    }
  }

  // LLM-пассажи и советы
}

console.log('');
process.exit(anyAboveThreshold ? 1 : 0);

}

export { analyzeRegex, sentenceRhythm, sectionSymmetry, ngramRepetition, scoreLabel, structuralSuggestions };

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
