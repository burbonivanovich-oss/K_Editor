#!/usr/bin/env python3
"""Sync content-plan-2026.md statuses with actual files in src/content/blog/."""
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'src/content/wiki/content-plan-2026.md'
BLOG = ROOT / 'src/content/blog'

# 1. Канонизация slug-ов: план → файл
SLUG_RENAMES = {
    'gashenie-vsd':                'gashenie-vsd-merkuriy',
    'markirovka-piva-rozdrobnoye': 'markirovka-piva-roznica',
    'razreshitelnyj-rezhim':       'razreshitelnyj-rezhim-markirovka',
    'markirovka-shtrafy-praktika': 'shtraf-za-markirovku',
}

# 2. Собираем slug → draft из файлов
file_state = {}
for f in BLOG.glob('*.md'):
    slug = re.sub(r'^\d{4}-\d{2}-\d{2}-', '', f.stem)
    text = f.read_text(encoding='utf-8')
    m = re.search(r'^draft:\s*(\w+)', text, re.M)
    file_state[slug] = m.group(1) if m else 'false'

PUBLISHED = '✅ опубликовано'
IN_PROGRESS = '🟡 в работе'

def status_for(slug: str) -> str | None:
    s = SLUG_RENAMES.get(slug, slug)
    if s not in file_state:
        return None  # тема ещё не начата — оставить приоритет
    return PUBLISHED if file_state[s] == 'false' else IN_PROGRESS

# 3. Парсим план построчно, обновляем таблицы
text = PLAN.read_text(encoding='utf-8')
lines = text.split('\n')
out = []
changed = renamed = added_status = 0
ofd_added = False

for line in lines:
    # строка таблицы вида: | 5 | slug | название | запрос | приоритет |
    m = re.match(r'^\|\s*(\d+)\s*\|\s*([\w\-]+)\s*\|(.*)\|(.*)\|\s*(.*?)\s*\|$', line)
    if not m:
        out.append(line)
        continue
    num, slug, name, query, prio = m.groups()
    new_slug = SLUG_RENAMES.get(slug, slug)
    if new_slug != slug:
        renamed += 1
        slug = new_slug
    new_status = status_for(slug)
    if new_status and new_status != prio.strip():
        prio = new_status
        added_status += 1
    out.append(f'| {num} | {slug} |{name}|{query}| {prio} |')
    if line != out[-1]:
        changed += 1

# 4. Добавляем ofd-dlya-ts-piot в Кластер 4 (если ещё нет)
new_text = '\n'.join(out)
if 'ofd-dlya-ts-piot' not in new_text:
    # Находим конец таблицы Кластера 4 (до пустой строки или следующего ##)
    pattern = r'(## Кластер 4\. ОФД и фискальные накопители.*?\n(\| .* \|\n)+)'
    def add_row(match):
        global ofd_added
        ofd_added = True
        block = match.group(1)
        # Считаем номер последней строки
        nums = re.findall(r'^\|\s*(\d+)\s*\|', block, re.M)
        next_num = (int(nums[-1]) + 1) if nums else 1
        new_row = f'| {next_num} | ofd-dlya-ts-piot | ОФД и ТС ПИоТ: что выбрать в 2026 | ОФД для ТС ПИоТ | {PUBLISHED} |\n'
        return block + new_row
    new_text = re.sub(pattern, add_row, new_text, count=1, flags=re.S)

PLAN.write_text(new_text, encoding='utf-8')

print(f'Переименовано slug-ов: {renamed}')
print(f'Обновлено статусов:    {added_status}')
print(f'Изменено строк:        {changed}')
print(f'Добавлено в Кластер 4: {"да" if ofd_added else "нет"}')

# Сводка по статусам
new_pub = new_text.count(PUBLISHED)
new_wip = new_text.count(IN_PROGRESS)
print(f'\nИтого в плане:')
print(f'  ✅ опубликовано: {new_pub}')
print(f'  🟡 в работе:     {new_wip}')
