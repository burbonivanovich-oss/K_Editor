/**
 * Автоматическая проверка текста на AI-маркеры (русский язык).
 *
 * Запуск:
 *   node scripts/check-ai-markers.mjs <файл.md>
 *   node scripts/check-ai-markers.mjs src/content/blog/   # вся папка
 *   node scripts/check-ai-markers.mjs <файл> --llm        # + LLM-оценка
 *
 * Флаги:
 *   --llm              включить LLM-анализ через OpenRouter (требует OPENROUTER_API_KEY)
 *   --model=<id>       модель для LLM (по умолчанию: anthropic/claude-haiku-4-5)
 *   --threshold=N      порог скора для exit(1) (по умолчанию 6)
 *   --json             вывод в JSON
 */
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Regex-маркеры: [regex, вес, замена] ──────────────────────────────────────

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
  [/\bявляется\b/gi,                            1, 'заменить на тире или живой глагол'],
  [/\bявляются\b/gi,                            1, 'заменить на тире или живой глагол'],
  [/\bосуществля[ея]тся\b/gi,                  2, 'заменить на конкретный глагол'],
  [/\bосуществлять\b/gi,                        1, 'заменить: делать, вести, проводить'],
  [/\bреализуется\b/gi,                         1, 'выполняется, работает'],
  [/\bпроизводится\b/gi,                        1, 'делается, происходит'],
  [/\bприменяется\b/gi,                         1, 'используется, действует'],

  // Канцелярные существительные
  [/\bданный\b/gi,                              1, '→ этот'],
  [/\bданная\b/gi,                              1, '→ эта'],
  [/\bданное\b/gi,                              1, '→ это'],
  [/\bданные\b(?!\s+(?:из|о|по|за|в|от))/gi,   1, '→ эти (если не «данные» как существительное)'],
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
  const body = stripMarkdown(stripFrontmatter(text));

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
  return { filename, hits, totalWeight, rawScore, uniformParagraphs, body };
}

// ── LLM-анализ через OpenRouter ───────────────────────────────────────────────

const LLM_SYSTEM = `Ты эксперт по редактуре русскоязычных деловых текстов.
Твоя задача — определить, написан ли текст нейросетью или живым автором.
Отвечай строго в формате JSON, без markdown, без пояснений вне JSON.`;

const LLM_PROMPT = (text) => `Оцени следующий текст на признаки нейросетевого происхождения.

Признаки AI-текста на русском языке:
- Однородная длина абзацев и предложений (нет ритмических перепадов)
- Шаблонные переходы: «следует отметить», «таким образом», «важно понимать»
- Пассивные конструкции с «является», «осуществляется», «применяется»
- Канцеляризмы: «данный», «в настоящее время», «в рамках»
- Обобщения без конкретных примеров, кейсов, цифр из практики
- Все H2-секции одинаковой структуры и заканчиваются выводом
- Отсутствие авторского голоса: нет мнения, нет иронии, нет акцентов
- Слишком гладкий и правильный синтаксис без живых разговорных вкраплений

Верни JSON в точности такой структуры:
{
  "score": <число 0-10, где 0=точно человек, 10=точно AI>,
  "confidence": <"low"|"medium"|"high">,
  "verdict": "<одно предложение — главная причина оценки>",
  "passages": [
    { "quote": "<цитата до 80 символов>", "reason": "<почему это AI-признак>" }
  ],
  "suggestions": [
    "<конкретный совет по улучшению>"
  ]
}

Массив passages — максимум 4 самых показательных фрагмента.
Массив suggestions — максимум 3 совета.

Текст для анализа:
---
${text.slice(0, 4000)}
---`;

async function callLLM(body, model, apiKey) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://reglament-biznes.ru',
      'X-Title': 'Регламент.Бизнес AI Detector',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: LLM_SYSTEM },
        { role: 'user',   content: LLM_PROMPT(body) },
      ],
      temperature: 0.1,
      max_tokens: 800,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content ?? '';

  try {
    return JSON.parse(raw);
  } catch {
    // Иногда модель оборачивает JSON в ```json ... ```
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return JSON.parse(m[1]);
    throw new Error('Не удалось распарсить JSON от LLM: ' + raw.slice(0, 200));
  }
}

// ── Итоговый скор ─────────────────────────────────────────────────────────────

function combineScores(regexScore, llmScore) {
  // LLM весит больше — семантика точнее паттернов
  return Math.round(0.35 * regexScore + 0.65 * llmScore);
}

function scoreLabel(s) {
  if (s <= 2) return 'Публиковать без правок';
  if (s <= 5) return 'Заменить стоп-фразы, проверить структуру';
  if (s <= 8) return 'Переписать проблемные секции';
  return 'Переписать статью целиком';
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const THRESHOLD  = parseInt(flags.threshold ?? '6', 10);
const AS_JSON    = flags.json === true;
const USE_LLM    = flags.llm === true;
const LLM_MODEL  = flags.model ?? 'anthropic/claude-haiku-4-5';
const API_KEY    = process.env.OPENROUTER_API_KEY;

if (!args[0]) {
  console.error('Использование: node scripts/check-ai-markers.mjs <файл.md или папка> [--llm]');
  process.exit(1);
}

if (USE_LLM && !API_KEY) {
  console.error('OPENROUTER_API_KEY не задан — LLM-анализ недоступен');
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

  let llm = null;
  if (USE_LLM) {
    process.stderr.write(`LLM: анализирую ${label}... `);
    try {
      llm = await callLLM(regex.body, LLM_MODEL, API_KEY);
      process.stderr.write('готово\n');
    } catch (e) {
      process.stderr.write(`ошибка: ${e.message}\n`);
    }
  }

  const finalScore = llm
    ? combineScores(regex.rawScore, llm.score)
    : regex.rawScore;

  results.push({ label, regex, llm, finalScore });
}

// ── Вывод ─────────────────────────────────────────────────────────────────────

if (AS_JSON) {
  console.log(JSON.stringify(results.map(r => ({
    file: r.label,
    regexScore: r.regex.rawScore,
    llmScore: r.llm?.score ?? null,
    finalScore: r.finalScore,
    verdict: r.llm?.verdict ?? null,
    hits: r.regex.hits.length,
  })), null, 2));
  process.exit(results.some(r => r.finalScore >= THRESHOLD) ? 1 : 0);
}

let anyAboveThreshold = false;

for (const { label, regex, llm, finalScore } of results) {
  if (finalScore >= THRESHOLD) anyAboveThreshold = true;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Файл:        ${label}`);

  if (llm) {
    console.log(`Regex-скор:  ${regex.rawScore}/10`);
    console.log(`LLM-скор:    ${llm.score}/10  (${llm.confidence} confidence)`);
    console.log(`Итог:        ${finalScore}/10  — ${scoreLabel(finalScore)}`);
    console.log(`Вердикт:     ${llm.verdict}`);
  } else {
    console.log(`Скор:        ${finalScore}/10  — ${scoreLabel(finalScore)}`);
  }

  if (regex.uniformParagraphs) {
    console.log('Структура:   абзацы однородной длины (признак AI)');
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
  if (llm) {
    if (llm.passages?.length) {
      console.log('\nПоказательные фрагменты (LLM):');
      for (const p of llm.passages) {
        console.log(`  «${p.quote}»`);
        console.log(`   → ${p.reason}`);
      }
    }
    if (llm.suggestions?.length) {
      console.log('\nСоветы:');
      for (const s of llm.suggestions) console.log(`  • ${s}`);
    }
  }
}

console.log('');
process.exit(anyAboveThreshold ? 1 : 0);
