/**
 * Контур — меню редактора в Google-таблице.
 *
 * Ставится в таблицу плана: Расширения → Apps Script → вставить этот файл.
 * Полная инструкция — docs/editor-button.md в репозитории.
 *
 * Зачем: редактор по устройству модуля не заходит в GitHub. Раньше он мог
 * только оставить правку в таблице и ждать, пока рутина B придёт по
 * расписанию — до четырёх часов. Теперь он жмёт пункт меню в документе,
 * который и так открыт, и запрос уходит сразу.
 *
 * Токен лежит в свойствах скрипта на стороне Google, а не в браузере.
 * Редактор его не видит и не вводит: настраивает один раз владелец.
 */

// ─── настройки ──────────────────────────────────────────────────────────

var REPO_OWNER = 'burbonivanovich-oss';
var REPO_NAME = 'K_Editor';
var WORKFLOW = 'editor-request.yml';
var BRANCH = 'main';

// Раскладка повторяет WORK_COLS из scripts/lib/sheet-columns.mjs.
// Google Apps Script живёт на стороне Google и импортировать модуль
// репозитория не может — это единственная копия раскладки, которая
// осталась. Меняете порядок колонок там — правьте эти три строки, иначе
// кнопка возьмёт не ту ячейку. Ровно так 11.08.2026 разъехались статусы:
// «I» была «Статусом», стала «Приоритетом», и никто не заметил.
var FIRST_DATA_ROW = 5;
var COL_TOPIC = 2;   // B — Тема
var COL_STATUS = 3;  // C — Статус

var TOKEN_KEY = 'GITHUB_TOKEN';
var EDITORS_KEY = 'EDITOR_EMAILS';

// ─── меню ───────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Контур')
    .addItem('Срочная правка — позвать сейчас', 'requestUrgent')
    .addItem('Вопрос по теме', 'requestQuestion')
    .addItem('Док поправлен — перечитать', 'requestRecheck')
    .addSeparator()
    .addItem('Позвать редакцию письмом', 'notifyEditors')
    .addSeparator()
    .addItem('Проверить связь', 'checkConnection')
    .addItem('Настроить доступ (владельцу)', 'setupToken')
    .addItem('Кому писать (владельцу)', 'setupEditors')
    .addItem('Письма по понедельникам: включить', 'enableWeeklyMail')
    .addToUi();
}

// ─── пункты меню ────────────────────────────────────────────────────────

function requestUrgent() {
  sendRequest_('urgent', 'Что нужно сделать срочно?');
}

function requestQuestion() {
  sendRequest_('question', 'Какой вопрос по теме?');
}

function requestRecheck() {
  sendRequest_('recheck', 'Что поправили в доке? (можно пусто)', true);
}

// ─── письма редакции ────────────────────────────────────────────────────

/*
 * Зачем это здесь, а не в скриптах репозитория.
 *
 * Сигнал «приехали новые темы» долго не находился. Google шлёт письмо
 * только при первой выдаче доступа к файлу, а таблица теперь одна и
 * доступ выдан однажды. Комментарий с упоминанием тоже проверили
 * 11.08.2026 на живом адресе — письмо не пришло: для комментариев,
 * созданных через API, Google рассылку не делает.
 *
 * Apps Script живёт на стороне Google и почту слать умеет. Отсюда письмо
 * уходит от владельца таблицы, гарантированно и с тем текстом, который мы
 * написали, — а не «в документе что-то изменилось».
 */

/** Адреса редакции. В репозиторий не попадают: он публичный. */
function getEditors_() {
  var raw = PropertiesService.getScriptProperties().getProperty(EDITORS_KEY) || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function setupEditors() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'Кому писать',
    'Адреса редакции через запятую. Хранятся в свойствах скрипта, в таблице не видны.',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var value = res.getResponseText().trim();
  if (!value) { ui.alert('Пусто — ничего не сохранил.'); return; }
  PropertiesService.getScriptProperties().setProperty(EDITORS_KEY, value);
  ui.alert('Сохранено: ' + value);
}

/** Сколько тем ждёт решения и сколько статей ждёт вычитки — прямо из листа. */
function countWork_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var last = sheet.getLastRow();
  var out = { candidates: 0, review: 0 };
  if (last < FIRST_DATA_ROW) return out;
  var values = sheet.getRange(FIRST_DATA_ROW, COL_STATUS, last - FIRST_DATA_ROW + 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var st = String(values[i][0] || '');
    if (st.indexOf('кандидат') === 0) out.candidates++;
    if (st.indexOf('на вычитке') === 0) out.review++;
  }
  return out;
}

function notifyEditors() {
  var ui = SpreadsheetApp.getUi();
  var to = getEditors_();
  if (!to.length) {
    ui.alert('Некому писать', 'Сначала: меню Контур → «Кому писать».', ui.ButtonSet.OK);
    return;
  }
  var sent = sendEditorsMail_();
  ui.alert('Письмо отправлено', sent.summary + '\n\nКому: ' + to.join(', '), ui.ButtonSet.OK);
}

/** Общий отправитель: зовётся и из меню, и по расписанию. */
function sendEditorsMail_() {
  var to = getEditors_();
  var work = countWork_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var summary =
    'Ждут решения: ' + work.candidates + '. На вычитке: ' + work.review + '.';

  if (to.length) {
    MailApp.sendEmail({
      to: to.join(','),
      subject: 'Редакция: ' + summary,
      body:
        summary + '\n\n' +
        'Таблица: ' + ss.getUrl() + '\n\n' +
        'Решение ставится в колонке «Решение»: «одобрено» берёт тему в работу, ' +
        '«написать сейчас» не ждёт очереди, «убрать» снимает (тогда нужна причина).\n' +
        'Статьи на вычитке — по ссылке в колонке «Документ», правки комментариями.',
    });
  }
  return { summary: summary, to: to };
}

/** Письмо по понедельникам утром — когда приходят новые темы. */
function enableWeeklyMail() {
  var ui = SpreadsheetApp.getUi();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'sendEditorsMail_') {
      ui.alert('Уже включено', 'Письмо уходит по понедельникам утром.', ui.ButtonSet.OK);
      return;
    }
  }
  ScriptApp.newTrigger('sendEditorsMail_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(10)
    .create();
  ui.alert('Включено', 'Письмо будет уходить по понедельникам около 10 утра.', ui.ButtonSet.OK);
}

// ─── общая логика запроса ───────────────────────────────────────────────

/**
 * @param {string} kind        тип запроса для workflow
 * @param {string} question    что спросить у редактора
 * @param {boolean} allowEmpty можно ли отправить с пустым комментарием
 */
function sendRequest_(kind, question, allowEmpty) {
  var ui = SpreadsheetApp.getUi();

  var token = getToken_();
  if (!token) {
    ui.alert(
      'Доступ не настроен',
      'В свойствах скрипта нет токена GitHub. Это настраивает владелец: ' +
        'меню Контур → «Настроить доступ».',
      ui.ButtonSet.OK
    );
    return;
  }

  var topic = readTopic_();
  if (topic === null) {
    ui.alert(
      'Не видно темы',
      'Встаньте курсором на строку с темой (начиная с ' + FIRST_DATA_ROW +
        '-й) и повторите. Кнопка передаёт тему из строки, чтобы не пришлось ' +
        'объяснять словами, о чём речь.',
      ui.ButtonSet.OK
    );
    return;
  }

  var answer = ui.prompt('Тема: ' + topic.title, question, ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  var note = answer.getResponseText().trim();
  if (!note && !allowEmpty) {
    ui.alert('Пусто — не отправляю. Напишите пару слов, иначе запрос ничего не значит.');
    return;
  }

  var result = dispatch_(token, {
    kind: kind,
    topic: topic.title,
    note: note,
    who: Session.getActiveUser().getEmail() || 'редактор',
  });

  if (result.ok) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Запрос отправлен. Статус темы: ' + topic.status,
      'Контур',
      5
    );
  } else {
    ui.alert('Не отправилось', result.message, ui.ButtonSet.OK);
  }
}

/** Тема и статус из текущей строки. null — курсор не на строке с темой. */
function readTopic_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row = sheet.getActiveRange().getRow();
  if (row < FIRST_DATA_ROW) return null;

  var title = String(sheet.getRange(row, COL_TOPIC).getValue() || '').trim();
  if (!title) return null;

  return {
    title: title,
    status: String(sheet.getRange(row, COL_STATUS).getValue() || '—').trim(),
  };
}

// ─── GitHub ─────────────────────────────────────────────────────────────

/**
 * Запускает workflow. GitHub на успех отвечает 204 без тела — поэтому
 * проверяем именно код, а не содержимое ответа.
 */
function dispatch_(token, inputs) {
  var url =
    'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
    '/actions/workflows/' + WORKFLOW + '/dispatches';

  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      payload: JSON.stringify({ ref: BRANCH, inputs: inputs }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    return { ok: false, message: 'Сеть не ответила: ' + e };
  }

  var code = response.getResponseCode();
  if (code === 204) return { ok: true };

  return { ok: false, message: explainError_(code, response.getContentText()) };
}

/**
 * Коды GitHub сами по себе редактору ничего не говорят. Переводим в то,
 * что можно сделать руками, — иначе любой отказ выглядит одинаково.
 */
function explainError_(code, body) {
  if (code === 401) {
    return 'Токен не принят (401). Скорее всего истёк или отозван — владельцу ' +
      'нужно выпустить новый через «Настроить доступ».';
  }
  if (code === 403) {
    return 'Доступ запрещён (403). У токена нет права Actions: write на этот ' +
      'репозиторий, либо Actions отключены в настройках репозитория.';
  }
  if (code === 404) {
    return 'Не найдено (404). Либо у токена нет доступа к репозиторию, либо файла ' +
      WORKFLOW + ' нет в ветке ' + BRANCH + ': workflow_dispatch видит только ' +
      'файлы из ветки по умолчанию.';
  }
  if (code === 422) {
    return 'GitHub не принял поля запроса (422). Обычно это значит, что список ' +
      'полей в workflow разошёлся с этим скриптом. Ответ: ' + body;
  }
  return 'GitHub ответил ' + code + '. ' + body;
}

// ─── настройка и диагностика ────────────────────────────────────────────

function getToken_() {
  return PropertiesService.getScriptProperties().getProperty(TOKEN_KEY);
}

/**
 * Токен вводится один раз владельцем и остаётся в свойствах скрипта.
 * В таблицу он не пишется и редактору не показывается.
 */
function setupToken() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.prompt(
    'Токен GitHub',
    'Fine-grained token с правом Actions: write только на ' + REPO_OWNER + '/' + REPO_NAME +
      '.\nПустая строка — удалить сохранённый токен.',
    ui.ButtonSet.OK_CANCEL
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  var token = answer.getResponseText().trim();
  var props = PropertiesService.getScriptProperties();

  if (!token) {
    props.deleteProperty(TOKEN_KEY);
    ui.alert('Токен удалён. Кнопки работать не будут.');
    return;
  }

  props.setProperty(TOKEN_KEY, token);
  ui.alert('Токен сохранён. Проверьте связь: меню Контур → «Проверить связь».');
}

/**
 * Проверяет доступ, ничего не запуская: читает описание workflow.
 * Отдельный пункт нужен, чтобы ловить проблемы с токеном не в тот момент,
 * когда у редактора горит правка.
 */
function checkConnection() {
  var ui = SpreadsheetApp.getUi();

  var token = getToken_();
  if (!token) {
    ui.alert('Токена нет. Меню Контур → «Настроить доступ».');
    return;
  }

  var url =
    'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
    '/actions/workflows/' + WORKFLOW;

  var response = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    ui.alert('Связи нет', explainError_(code, response.getContentText()), ui.ButtonSet.OK);
    return;
  }

  var wf = JSON.parse(response.getContentText());
  ui.alert(
    'Связь есть',
    'Workflow «' + wf.name + '», состояние: ' + wf.state + '.\n\n' +
      'Это подтверждает доступ на чтение. Право на запуск проверится первой ' +
      'реальной отправкой — GitHub не даёт проверить его отдельно.',
    ui.ButtonSet.OK
  );
}
