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

// Раскладка таблицы повторяет COLS из scripts/drive-sync.mjs.
// Меняете там — поправьте здесь, иначе кнопка возьмёт не ту колонку.
var FIRST_DATA_ROW = 5;
var COL_TOPIC = 2;   // B — Тема
var COL_STATUS = 9;  // I — Статус

var TOKEN_KEY = 'GITHUB_TOKEN';

// ─── меню ───────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Контур')
    .addItem('Срочная правка — позвать сейчас', 'requestUrgent')
    .addItem('Вопрос по теме', 'requestQuestion')
    .addItem('Док поправлен — перечитать', 'requestRecheck')
    .addSeparator()
    .addItem('Проверить связь', 'checkConnection')
    .addItem('Настроить доступ (владельцу)', 'setupToken')
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
