/**
 * Кластер → сегмент аудитории.
 *
 * Кластер отвечает на вопрос «про что статья», сегмент — «для кого».
 * Это разные вопросы, и редактору нужен второй: тема «касса для аптеки»
 * из кластера `apteka` интересна не аптечному изданию, а рознице с
 * лекарствами. В ручном списке редакции (август 2026) колонка «Сегмент»
 * была, у скрипта её не было — и нишевые темы в таблице выглядели
 * случайным набором, потому что связывающий их признак не показывался.
 *
 * Раскладка снята с того же ручного списка, а не придумана: там 40 тем
 * разложены по четырём сегментам, и соответствия кластерам однозначны.
 * Кластеры, которых в списке не было, размечены по смыслу — там, где
 * смысл однозначен; где нет, честнее вернуть null, чем угадать.
 */

const SEGMENTS = {
  // Розница с физическим товаром — ядро аудитории модуля
  "ts-piot": "roznica",
  markirovka: "roznica",
  "markirovka-2026": "roznica",
  egais: "roznica",
  merkuriy: "roznica",
  oborudovanie: "roznica",
  roznica: "roznica",
  apteka: "roznica",
  ekvairing: "roznica",

  // Всё, что про саму кассу и её обвязку
  kkt: "kassy",
  "ofd-fn": "kassy",
  "nalogi-kassa": "kassy",

  // Общепит
  horeca: "obshchepit",

  // Услуги, самозанятые, малый сервис
  uslugi: "uslugi",
  avtoservis: "uslugi",

  // Сегмент не определяется кластером: эти темы одинаково нужны всем.
  // Пусто честнее выдуманного — тот же принцип, что у productFor().
  zakonodatelstvo: null,
  nalogi: null,
  buhgalteriya: null,
  "otchetnost-edo": null,
  kadry: null,
  banki: null,
  start: null,
  logistika: null,
  marketplace: null,
  nichi: null,
};

const LABELS = {
  roznica: "Розница",
  kassy: "Кассы и ОФД",
  obshchepit: "Общепит",
  uslugi: "Услуги и самозанятые",
};

export function segmentFor(cluster) {
  const seg = cluster ? SEGMENTS[cluster] ?? null : null;
  return { segment: seg, segmentLabel: seg ? LABELS[seg] : null };
}

export { SEGMENTS, LABELS };
