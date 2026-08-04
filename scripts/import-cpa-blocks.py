#!/usr/bin/env python3
"""Выгрузка CPA-блоков из админки Контура -> src/data/cpa-blocks.json.

Админка отдаёт .xlsx со всеми креативами: продукт, тип блока, заголовок,
описание в HTML, текст и адрес ссылки. Пайплайну нужен не сам файл, а
каталог, по которому агент подберёт блок под конкретный раздел статьи —
поэтому здесь описание чистится от разметки, а по адресу посадочной
проставляется кластер.

Запуск:
    python3 scripts/import-cpa-blocks.py <выгрузка.xlsx>
    python3 scripts/import-cpa-blocks.py <выгрузка.xlsx> --dry-run

Требует openpyxl (pip install openpyxl). Скрипт разовый: гоняется, когда
из админки приходит свежая выгрузка, а не в каждом прогоне пайплайна.
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("Нужен openpyxl: pip install openpyxl")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "cpa-blocks.json"

# Кластер определяется по адресу посадочной. Порядок важен: более
# частные адреса проверяются раньше общих, иначе /market/features/egais
# уедет в тот же кластер, что и /market.
URL_CLUSTER = [
    ("/features/marking", "markirovka"),
    ("/features/egais", "egais"),
    ("/features/mercury", "merkuriy"),
    ("/obshepit", "horeca"),
    ("/roznitsa", "marketplace"),
    ("/features/sbp-i-ekvairing", "banki"),
    ("/ofd", "ofd-fn"),
    ("/kkt", "kkt"),
    ("/market", "kkt"),
]


def strip_html(value):
    if value is None:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    text = text.replace("\xa0", " ").replace("&nbsp;", " ")
    text = text.replace("&mdash;", "—").replace("&laquo;", "«").replace("&raquo;", "»")
    return re.sub(r"\s+", " ", text).strip()


def cluster_for(url):
    low = (url or "").lower()
    for needle, cluster in URL_CLUSTER:
        if needle in low:
            return cluster
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if not args:
        sys.exit("Укажите путь к .xlsx выгрузке из админки.")

    wb = openpyxl.load_workbook(args[0])
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(c).strip() if c else "" for c in rows[0]]

    blocks, skipped = [], 0
    for raw in rows[1:]:
        if not any(raw):
            continue
        row = dict(zip(header, raw))

        url = strip_html(row.get("Ссылка"))
        title = strip_html(row.get("Заголовок"))
        description = strip_html(row.get("Описание"))
        cta = strip_html(row.get("Текст ссылки"))

        # Блок без посадочной вести некуда. А вот заголовок с описанием
        # есть не у всех: у трети выгрузки это голая кнопка вида
        # «Смотреть тарифы» со ссылкой, и такой блок вполне рабочий —
        # требовать заголовок значило бы выбросить их зря.
        if not url or not (title or description or cta):
            skipped += 1
            continue

        # В заголовках админки встречается служебный хвост вида «[coza]».
        title = re.sub(r"\[[a-z]+\]\s*$", "", title).strip()

        blocks.append({
            "id": str(row.get("ID") or "").strip(),
            "product": strip_html(row.get("Продукт")),
            "format": strip_html(row.get("Тип")),
            "cluster": cluster_for(url),
            "title": title,
            "description": description,
            "cta": cta,
            "ctaKind": strip_html(row.get("Тип ссылки")),
            "url": url,
        })

    # Один и тот же креатив может выгрузиться дважды — считаем дублем
    # совпадение текста и посадочной, id при этом разные.
    seen, unique = set(), []
    for b in blocks:
        key = (b["title"], b["description"], b["url"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(b)

    payload = {
        "_source": Path(args[0]).name,
        "_generated": date.today().isoformat(),
        "_note": "Каталог CPA-блоков. Обновляется скриптом scripts/import-cpa-blocks.py "
                 "по свежей выгрузке из админки, руками не редактируется.",
        "count": len(unique),
        "blocks": unique,
    }

    by_cluster = {}
    for b in unique:
        by_cluster[b["cluster"] or "—"] = by_cluster.get(b["cluster"] or "—", 0) + 1

    print(f"Строк в выгрузке: {len(rows) - 1}")
    print(f"Пропущено (нет ссылки или текста): {skipped}")
    print(f"Дублей схлопнуто: {len(blocks) - len(unique)}")
    print(f"Блоков в каталоге: {len(unique)}")
    print("По кластерам:")
    for cluster, n in sorted(by_cluster.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d}  {cluster}")

    if dry_run:
        print("\nDry-run: файл не записан.")
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n✓ {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
