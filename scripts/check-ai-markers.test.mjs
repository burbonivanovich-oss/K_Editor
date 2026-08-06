import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRegex, sentenceRhythm, sectionSymmetry, ngramRepetition } from './check-ai-markers.mjs';

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
