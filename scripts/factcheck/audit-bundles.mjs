#!/usr/bin/env node
/**
 * Аудит факчек-связок по всему корпусу — тем же валидатором, что у гейта
 * и релиза.
 *
 * Раньше CI проверял маркер по трём полям: есть ли он, сходится ли хеш,
 * стоит ли в нём `passed` (`audit-marker-hashes.mjs`,
 * `audit-marker-results.mjs`). Это проверка утверждения о проверке.
 * Поэтому все десять отчётов корпуса числились зелёными, хотя текущий
 * контракт отвергает каждый: у трёх опубликованных статей 32–33
 * нарушения доказательного формата.
 *
 * Здесь связка перепроверяется целиком: контракт артефактов, версия
 * текста, вердикт из утверждений, доказательства, покрытие.
 *
 * Про список исключений. Десять статей были зафакчеканы по предыдущему
 * контракту, и до их перепроверки (задача C-04) строгий прогон означал
 * бы красный CI на любой ветке, включая ту, в которой их и чинят.
 * Поэтому есть `legacy-allowlist.json`: явный, датированный, лежащий в
 * git список. Он не делает эти статьи зелёными — их состояние печатается
 * каждым прогоном, а `release-article.mjs` их всё равно не выпускает.
 * Он лишь отделяет «известный долг» от «новой поломки»: статья, которой
 * в списке нет, обязана проходить контракт.
 *
 * Запуск:
 *   node scripts/factcheck/audit-bundles.mjs                # весь блог
 *   node scripts/factcheck/audit-bundles.mjs --released     # только выпущенные
 *   node scripts/factcheck/audit-bundles.mjs --strict       # exit 1 при находках
 *   node scripts/factcheck/audit-bundles.mjs --json
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.mjs';
import { validateFactcheckBundle } from './validate-bundle.mjs';

const ROOT = process.env.FACTCHECK_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOG = join(ROOT, 'src/content/blog');
const ALLOWLIST = join(ROOT, 'src/data/factcheck/legacy-allowlist.json');

/** Статьи, ждущие перепроверки по новому контракту (C-04). */
export function legacyAllowlist(root = ROOT) {
  const p = join(root, 'src/data/factcheck/legacy-allowlist.json');
  if (!existsSync(p)) return { slugs: new Set(), meta: null };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return { slugs: new Set((data.articles || []).map((a) => a.slug)), meta: data };
  } catch {
    return { slugs: new Set(), meta: null };
  }
}

/**
 * I-03. Список исключений может только сокращаться.
 *
 * Правило «добавлять новые строки нельзя» было записано в поле `note`
 * того же файла — то есть держалось на дисциплине, а проверялось ничем.
 * Между тем весь смысл списка в том, что он отделяет **известный** долг
 * от новой поломки: список, который растёт, перестаёт отделять что-либо
 * и превращается в способ красить красное в зелёное.
 *
 * Сверка идёт с `baseline` в том же файле. Убрать строку из `articles`
 * можно свободно — это и есть закрытый долг. Добавить новую можно
 * только правкой `baseline`, и в диффе это видно, в отличие от тихого
 * дописывания в `articles`.
 *
 * @returns {Array<{slug: string, problem: string}>}
 */
export function allowlistGrowth(root = ROOT) {
  const { meta } = legacyAllowlist(root);
  if (!meta) return [];
  const baseline = Array.isArray(meta.baseline) ? new Set(meta.baseline) : null;
  const articles = (meta.articles || []).map((a) => a.slug);
  if (!baseline) {
    return articles.length
      ? [{ slug: '—', problem: 'в legacy-allowlist.json нет baseline — сверять рост списка не с чем' }]
      : [];
  }
  return articles
    .filter((slug) => !baseline.has(slug))
    .map((slug) => ({ slug, problem: 'статьи нет в baseline — список исключений вырос, а он может только сокращаться' }));
}

/**
 * Разбор всего корпуса.
 * @returns {{slug: string, draft: boolean, legacy: boolean, ok: boolean, problems: Array}[]}
 */
export function auditBundles({ root = ROOT, releasedOnly = false } = {}) {
  const blog = join(root, 'src/content/blog');
  if (!existsSync(blog)) return [];
  const { slugs: legacy } = legacyAllowlist(root);

  return readdirSync(blog)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => {
      const slug = f.replace(/\.mdx?$/, '');
      const raw = readFileSync(join(blog, f), 'utf8');
      const draft = !/^draft:\s*false\s*$/m.test(raw);
      const r = validateFactcheckBundle({ root, slug, articleRaw: raw });
      /* Опубликованную статью список исключений не прикрывает.
       *
       * Смысл списка — отделить известный долг от новой поломки, и для
       * черновика это работает: он лежит в репозитории и никого не
       * вводит в заблуждение. Опубликованный материал читают прямо
       * сейчас. «Известный долг» на нём означает «мы знаем, что читатель
       * видит непроверенное, и договорились не считать это красным», —
       * договорённость, которую нельзя заключать молча в JSON-файле.
       *
       * Замер 21.08.2026: из трёх опубликованных статей у двух связки не
       * было вовсе, и CI был зелёным. */
      const shielded = legacy.has(slug) && !draft;
      return {
        slug, draft, legacy: legacy.has(slug) && draft, ok: r.ok,
        problems: r.blocking,
        shielded: shielded && !r.ok,
      };
    })
    .filter((r) => !releasedOnly || !r.draft);
}

if (isMain(import.meta.url)) {
  const releasedOnly = process.argv.includes('--released');
  const strict = process.argv.includes('--strict');
  const rows = auditBundles({ releasedOnly });

  /* Итог считается один раз и до ветвления по формату вывода.
   *
   * Раньше `--json` считал свой: он не знал ни про пустой корпус, ни
   * про рост списка исключений. Достаточно было попросить JSON, чтобы
   * два из трёх отказов исчезли — то есть формат вывода менял вердикт.
   * Формат не должен участвовать в решении вообще. */
  const grown = allowlistGrowth();
  const shieldedRows = rows.filter((r) => r.shielded);
  const emptyCorpus = !rows.length;
  const failing = strict && (
    emptyCorpus
    || grown.length
    || shieldedRows.length
    || rows.some((r) => !r.ok && !r.legacy)
  );

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      articles: rows.length,
      rows,
      allowlistGrown: grown,
      shielded: shieldedRows.map((r) => r.slug),
      emptyCorpus,
    }, null, 2));
    process.exit(failing ? 1 : 0);
  }

  /* Пустой корпус — не «всё проверено», а «проверять нечего».
   *
   * Разница видна ровно в строгом режиме: прогон по пустому каталогу
   * возвращал ноль и читался как успех. Так выглядит битый checkout,
   * неверный путь и рутина, отработавшая не там; выдавать за них
   * зелёный CI значит согласиться не заметить ни одного из трёх. */
  if (!rows.length) {
    const what = releasedOnly ? 'Выпущенных статей нет' : 'Статей нет';
    if (strict) {
      console.error(`✖ ${what} — проверять нечего. В строгом режиме это отказ, а не успех:`);
      console.error('  пустой корпус означает битый checkout или неверный путь, а не чистое состояние.');
      process.exit(1);
    }
    console.log(`${what}.`);
    process.exit(0);
  }

  const bad = rows.filter((r) => !r.ok);
  const debt = bad.filter((r) => r.legacy);
  const regressions = bad.filter((r) => !r.legacy);
  const shielded = shieldedRows;

  console.log(`Проверено связок факчека: ${rows.length}${releasedOnly ? ' (только выпущенные)' : ''}\n`);
  for (const r of rows.filter((x) => x.ok)) console.log(`  ✓ ${r.slug}`);

  const { meta } = legacyAllowlist();
  if (debt.length) {
    console.log(`\n  Ждут перепроверки по новому контракту — ${debt.length} (${meta?.reason || 'legacy-allowlist.json'}):`);
    for (const r of debt) {
      console.log(`    • ${r.slug} — ${r.problems.length} замечаний: ${r.problems[0]?.message ?? ''}`);
    }
  }

  /* Динамика долга. Без неё список выглядит одинаково и когда он тает,
   * и когда стоит на месте: «10 статей ждут» второй месяц подряд — это
   * другая новость, чем «было 10, осталось 4». */
  const baseline = Array.isArray(meta?.baseline) ? meta.baseline.length : null;
  const current = (meta?.articles || []).length;
  if (baseline !== null) {
    console.log(`\n  Долг по списку исключений: ${current} из ${baseline} (закрыто ${baseline - current}).`);
  }

  if (shielded.length) {
    console.log(`\n✖ Опубликованные статьи в списке исключений — ${shielded.length}:`);
    for (const r of shielded) console.log(`  ${r.slug}: ${r.problems[0]?.message ?? ''}`);
    console.log('  Список отделяет известный долг от новой поломки, и на черновике это работает.');
    console.log('  Опубликованный материал читают сейчас: либо перепроверить, либо снять с публикации.');
  }

  if (grown.length) {
    console.log(`\n✖ Список исключений вырос — ${grown.length}:`);
    for (const g of grown) console.log(`  ${g.slug}: ${g.problem}`);
    console.log('  Новая статья обязана проходить контракт сразу. Если строка добавлена');
    console.log('  осознанно — правьте baseline, чтобы это было видно в диффе.');
  }

  if (regressions.length) {
    console.log(`\n✖ Связка не проходит контракт — ${regressions.length}:`);
    for (const r of regressions) {
      console.log(`  ${r.slug}:`);
      for (const p of r.problems.slice(0, 5)) console.log(`    [${p.code}] ${p.message}`);
      if (r.problems.length > 5) console.log(`    … и ещё ${r.problems.length - 5}`);
    }
  } else {
    console.log('\n✓ Новых поломок нет: всё, чего нет в списке исключений, проходит контракт.');
  }

  process.exit(failing ? 1 : 0);
}
