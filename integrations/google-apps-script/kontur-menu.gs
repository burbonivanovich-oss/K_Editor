/**
 * Меню «Контур» для таблицы редакции.
 * Запросы пишутся прямо в колонку «Комментарий»; задача B читает её
 * через Google API. Внешний диспетчер и токен не нужны.
 */

var FIRST_DATA_ROW = 5;
var COL_TOPIC = 2;   // B — Тема
var COL_STATUS = 3;  // C — Статус
var COL_NOTE = 10;   // J — Комментарий
var EDITORS_KEY = 'EDITOR_EMAILS';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Контур')
    .addItem('Срочная правка', 'requestUrgent')
    .addItem('Вопрос по теме', 'requestQuestion')
    .addItem('Док поправлен — перечитать', 'requestRecheck')
    .addSeparator()
    .addItem('Позвать редакцию письмом', 'notifyEditors')
    .addItem('Кому писать (владельцу)', 'setupEditors')
    .addToUi();
}

function requestUrgent() {
  writeRequest_('Срочно', 'Что нужно сделать срочно?', false);
}

function requestQuestion() {
  writeRequest_('Вопрос', 'Какой вопрос по теме?', false);
}

function requestRecheck() {
  writeRequest_('Док поправлен — перечитать', 'Что поправили в доке? (можно пусто)', true);
}

function writeRequest_(label, question, allowEmpty) {
  var ui = SpreadsheetApp.getUi();
  var topic = readTopic_();
  if (!topic) {
    ui.alert('Встаньте курсором на строку с темой, начиная с ' + FIRST_DATA_ROW + '-й.');
    return;
  }

  var answer = ui.prompt('Тема: ' + topic.title, question, ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  var note = answer.getResponseText().trim();
  if (!note && !allowEmpty) {
    ui.alert('Пусто — запрос не сохранён.');
    return;
  }

  var request = '[' + label + ']' + (note ? ' ' + note : '');
  var cell = SpreadsheetApp.getActiveSheet().getRange(topic.row, COL_NOTE);
  var previous = String(cell.getValue() || '').trim();
  cell.setValue(previous ? previous + '\n' + request : request);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Запрос записан в «Комментарий». Статус: ' + topic.status,
    'Контур',
    5
  );
}

function readTopic_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveRange().getRow();
  if (row < FIRST_DATA_ROW) return null;
  var title = String(sheet.getRange(row, COL_TOPIC).getValue() || '').trim();
  if (!title) return null;
  return {
    row: row,
    title: title,
    status: String(sheet.getRange(row, COL_STATUS).getValue() || '—').trim(),
  };
}

function setupEditors() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'Кому писать',
    'Адреса редакции через запятую. Они хранятся в свойствах скрипта.',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var value = res.getResponseText().trim();
  if (!value) return;
  PropertiesService.getScriptProperties().setProperty(EDITORS_KEY, value);
  ui.alert('Сохранено.');
}

function notifyEditors() {
  var ui = SpreadsheetApp.getUi();
  var raw = PropertiesService.getScriptProperties().getProperty(EDITORS_KEY) || '';
  var to = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!to.length) {
    ui.alert('Сначала задайте адреса: Контур → «Кому писать».');
    return;
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet();
  MailApp.sendEmail({
    to: to.join(','),
    subject: 'Редакция: проверьте таблицу',
    body: 'В таблице есть вопросы или материалы на вычитку:\n' + sheet.getUrl(),
  });
  ui.alert('Письмо отправлено.');
}
