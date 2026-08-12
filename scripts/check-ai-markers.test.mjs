import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRegex,
  sentenceRhythm,
  sectionSymmetry,
  ngramRepetition,
  structuralSuggestions,
} from './check-ai-markers.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-ai-markers.mjs');

/* ------------------------------------------------------------ sentenceRhythm */

test('sentenceRhythm: null при менее чем 8 предложениях', () => {
  assert.equal(sentenceRhythm('Раз. Два. Три.'), null);
});

test('sentenceRhythm: одинаковая длина предложений даёт низкий cv', () => {
  const sentences = Array(10).fill('Слово слово слово слово слово.').join(' ');
  const r = sentenceRhythm(sentences);
  assert.equal(r.sentenceCount, 10);
  assert.ok(r.cv < 0.1, `ожидался низкий cv, получено ${r.cv}`);
});

test('sentenceRhythm: разная длина предложений даёт высокий cv', () => {
  // Короткое предложение — не меньше 3 слов, иначе sentenceRhythm сам
  // его отфильтрует и до порога в 8 валидных предложений не наберётся.
  const short = 'Да, я согласен.';
  const long = 'Это очень длинное предложение с большим количеством разных слов подряд без остановки.';
  const sentences = Array(5).fill(`${short} ${long}`).join(' ');
  const r = sentenceRhythm(sentences);
  assert.ok(r.sentenceCount >= 8, `мало предложений для теста: ${r?.sentenceCount}`);
  assert.ok(r.cv > 0.5, `ожидался высокий cv, получено ${r.cv}`);
});

/* ------------------------------------------------------------ sectionSymmetry */

test('sectionSymmetry: null при менее чем 4 секциях', () => {
  const text = '## Раздел 1\nТекст.\n\n## Раздел 2\nТекст.\n';
  assert.equal(sectionSymmetry(text), null);
});

test('sectionSymmetry: одинаковый объём секций даёт низкий cv', () => {
  const section = 'слово '.repeat(20).trim();
  const text = Array(5).fill(0).map((_, i) => `## Раздел ${i}\n${section}\n`).join('\n');
  const r = sectionSymmetry(text);
  assert.equal(r.sectionCount, 5);
  assert.ok(r.cv < 0.1, `ожидался низкий cv, получено ${r.cv}`);
});

test('sectionSymmetry: разный объём секций даёт высокий cv', () => {
  const text = [
    '## A\n' + 'слово '.repeat(5),
    '## B\n' + 'слово '.repeat(100),
    '## C\n' + 'слово '.repeat(3),
    '## D\n' + 'слово '.repeat(80),
  ].join('\n\n');
  const r = sectionSymmetry(text);
  assert.ok(r.cv > 0.5, `ожидался высокий cv, получено ${r.cv}`);
});

/* ---------------------------------------------------------- ngramRepetition */

test('ngramRepetition: null на слишком коротком тексте', () => {
  assert.equal(ngramRepetition('раз два три'), null);
});

test('ngramRepetition: повторяющаяся фраза снижает уникальность и попадает в topRepeats', () => {
  // Три РАЗНЫХ филлера — иначе сам филлер, повторённый целиком, забивает
  // topRepeats своими n-граммами вместо целевой фразы.
  const filler = (offset) => Array(40).fill(0).map((_, i) => `слово${offset}-${i}`).join(' ');
  const text = `${filler(1)} важно отметить что бизнес растёт ${filler(2)} важно отметить что бизнес растёт ${filler(3)}`;
  const r = ngramRepetition(text);
  assert.ok(r.uniqueRatio < 1);
  assert.ok(r.topRepeats.some((t) => t.phrase === 'важно отметить что бизнес' && t.count >= 2));
});

test('ngramRepetition: текст без повторов даёт уникальность, близкую к 1', () => {
  const words = Array(60).fill(0).map((_, i) => `уникальноеслово${i}`).join(' ');
  const r = ngramRepetition(words);
  assert.equal(r.uniqueRatio, 1);
  assert.deepEqual(r.topRepeats, []);
});

/* ---------------------------------------------------------------- analyzeRegex */

// Регрессия: sectionSymmetry ищет markdown-заголовки ##, а
// stripMarkdown(body) их вырезает для чистых regex-совпадений клише.
// analyzeRegex обязан считать секции по тексту до вырезания заголовков,
// иначе sections всегда null независимо от реальной структуры статьи.
test('analyzeRegex: structure.sections не null, если в статье есть ## заголовки', () => {
  const section = 'слово '.repeat(20).trim() + '.';
  const md = `---\ntitle: "T"\n---\n${Array(5).fill(0).map((_, i) => `## Раздел ${i}\n${section}\n`).join('\n')}`;
  const { structure } = analyzeRegex(md, 'test.md');
  assert.notEqual(structure.sections, null);
  assert.equal(structure.sections.sectionCount, 5);
});

test('analyzeRegex: structure не влияет на totalWeight/rawScore (справочно, не в скоре)', () => {
  const clean = '## A\nСлово слово слово.\n\n## B\nСлово слово слово.\n\n## C\nСлово слово слово.\n\n## D\nСлово слово слово.\n';
  const { rawScore, hits } = analyzeRegex(clean, 'test.md');
  assert.equal(hits.length, 0);
  assert.equal(rawScore, 0);
});

/* ------------------------------------------------------- structuralSuggestions */

test('structuralSuggestions: пустой массив, если метрики null или выше порога', () => {
  assert.deepEqual(structuralSuggestions({ rhythm: null, sections: null, ngrams: null }), []);
  assert.deepEqual(
    structuralSuggestions({
      rhythm: { cv: 0.5, sentenceCount: 10, meanWords: 12 },
      sections: { cv: 0.5, sectionCount: 5, meanWords: 100 },
      ngrams: { uniqueRatio: 1, topRepeats: [] },
    }),
    [],
  );
});

test('structuralSuggestions: низкий cv ритма даёт совет по предложениям', () => {
  const out = structuralSuggestions({
    rhythm: { cv: 0.05, sentenceCount: 10, meanWords: 12 },
    sections: null,
    ngrams: null,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].signal, 'ритм предложений');
});

test('structuralSuggestions: низкий cv секций даёт совет по разделам', () => {
  const out = structuralSuggestions({
    rhythm: null,
    sections: { cv: 0.1, sectionCount: 5, meanWords: 100 },
    ngrams: null,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].signal, 'симметрия секций');
});

test('structuralSuggestions: низкая уникальность n-грамм с повторами даёт совет по фразам', () => {
  const out = structuralSuggestions({
    rhythm: null,
    sections: null,
    ngrams: { uniqueRatio: 0.8, topRepeats: [{ phrase: 'важно отметить что бизнес', count: 3 }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].signal, 'повтор словосочетаний');
  assert.match(out[0].action, /важно отметить что бизнес/);
});

test('structuralSuggestions: низкая уникальность без topRepeats не даёт совет (нечего процитировать)', () => {
  const out = structuralSuggestions({
    rhythm: null,
    sections: null,
    ngrams: { uniqueRatio: 0.8, topRepeats: [] },
  });
  assert.equal(out.length, 0);
});

/* --------------------------------------------------------------- --save-profile */

const ARTICLE_MD = `---
title: "T"
---
## Раздел один

${'Слово слово слово слово слово. '.repeat(6)}

## Раздел два

${'Слово слово слово слово слово. '.repeat(6)}

## Раздел три

${'Слово слово слово слово слово. '.repeat(6)}

## Раздел четыре

${'Слово слово слово слово слово. '.repeat(6)}
`;

function withProfileFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'check-ai-markers-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--save-profile: без флага src/data/ai-profile/ не создаётся', () => {
  withProfileFixture((dir) => {
    const file = join(dir, 'article.md');
    writeFileSync(file, ARTICLE_MD);
    execFileSync('node', [SCRIPT, file, '--json'], { env: { ...process.env, AI_PROFILE_ROOT: dir } });
    assert.equal(existsSync(join(dir, 'src/data/ai-profile')), false);
  });
});

test('--save-profile: с флагом пишет профиль ожидаемой формы', () => {
  withProfileFixture((dir) => {
    const file = join(dir, 'article.md');
    writeFileSync(file, ARTICLE_MD);
    execFileSync('node', [SCRIPT, file, '--json', '--save-profile'], {
      env: { ...process.env, AI_PROFILE_ROOT: dir },
    });
    const profilePath = join(dir, 'src/data/ai-profile/article.json');
    assert.ok(existsSync(profilePath));
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    assert.equal(profile.slug, 'article');
    assert.equal(typeof profile.analyzerVersion, 'number');
    assert.equal(typeof profile.finalScore, 'number');
    assert.deepEqual(profile.history, []);
  });
});

test('--save-profile: повторный запуск переносит предыдущий срез в history', () => {
  withProfileFixture((dir) => {
    const file = join(dir, 'article.md');
    writeFileSync(file, ARTICLE_MD);
    execFileSync('node', [SCRIPT, file, '--json', '--save-profile'], {
      env: { ...process.env, AI_PROFILE_ROOT: dir },
    });
    execFileSync('node', [SCRIPT, file, '--json', '--save-profile'], {
      env: { ...process.env, AI_PROFILE_ROOT: dir },
    });
    const profilePath = join(dir, 'src/data/ai-profile/article.json');
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    assert.equal(profile.history.length, 1);
  });
});

// Аудит 12.08.2026: одиннадцать паттернов молчали с самого начала — `\b`
// в JS не считает границей край кириллического слова, потому что кириллица
// не входит в \w. Молчали как раз главные слова редполитики.
test('канцелярит с кириллицей ловится (регрессия по \\b)', () => {
  const r = analyzeRegex('Контроль осуществляется автоматически. Данный подход является рабочим.');
  const found = r.hits.map((m) => m.phrase.toLowerCase());
  assert.ok(found.includes('осуществляется'), `«осуществляется» не поймано: ${found}`);
  assert.ok(found.includes('является'), `«является» не поймано: ${found}`);
  assert.ok(found.includes('данный'), `«данный» не поймано: ${found}`);
});

test('«данные» как существительное не считается канцеляритом', () => {
  const r = analyzeRegex('Данные из кассы уходят в ОФД без задержки.');
  assert.equal(r.hits.filter((m) => m.phrase.toLowerCase() === 'данные').length, 0);
});

test('слово внутри другого слова не ловится', () => {
  // «поданные», «преданные» — не канцелярит: граница слова должна работать
  const r = analyzeRegex('Поданные заявления и преданные пользователи остаются с нами.');
  assert.equal(r.hits.filter((m) => m.phrase.toLowerCase() === 'данные').length, 0);
});
