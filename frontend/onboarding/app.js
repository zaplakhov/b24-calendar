const onboardingToken = window.location.pathname.split('/').filter(Boolean).pop();

const state = {
  calendars: {
    bitrix: [],
    yandex: [],
  },
  debugTrace: null,
};

const settingsForm = document.getElementById('settingsForm');
const refreshSettingsButton = document.getElementById('refreshSettingsButton');
const loadBitrixCalendarsButton = document.getElementById('loadBitrixCalendarsButton');
const loadYandexCalendarsButton = document.getElementById('loadYandexCalendarsButton');
const manualSyncButton = document.getElementById('manualSyncButton');
const statusBanner = document.getElementById('statusBanner');
const runtimeStatus = document.getElementById('runtimeStatus');
const connectionStatus = document.getElementById('connectionStatus');
const lastSyncValue = document.getElementById('lastSyncValue');
const lastErrorValue = document.getElementById('lastErrorValue');
const portalValue = document.getElementById('portalValue');
const bitrixUserValue = document.getElementById('bitrixUserValue');
const portalCaption = document.getElementById('portalCaption');
let diagnosticsSummary = null;
let diagnosticsRaw = null;

function ensureDiagnosticsPanel() {
  if (diagnosticsSummary && diagnosticsRaw) {
    return;
  }

  const grid = document.querySelector('.grid--secondary');
  if (!grid) {
    return;
  }

  const section = document.createElement('section');
  section.className = 'card status-card';
  section.innerHTML = '<h2>Sync diagnostics (debug trace)</h2><pre id="diagnosticsSummary">Диагностика еще не загружена.</pre><pre id="diagnosticsRaw">{}</pre>';
  grid.appendChild(section);
  diagnosticsSummary = section.querySelector('#diagnosticsSummary');
  diagnosticsRaw = section.querySelector('#diagnosticsRaw');
}

const fields = {
  bitrixCalendarId: document.getElementById('bitrixCalendarId'),
  syncEnabled: document.getElementById('syncEnabled'),
  yandexCalendarUrl: document.getElementById('yandexCalendarUrl'),
  yandexPassword: document.getElementById('yandexPassword'),
  yandexUsername: document.getElementById('yandexUsername'),
};

function endpoint(path = '') {
  return `/api/onboarding/${onboardingToken}${path}`;
}

function setBanner(message, tone = 'default') {
  statusBanner.textContent = message;
  statusBanner.classList.remove('is-error', 'is-success');

  if (tone === 'error') {
    statusBanner.classList.add('is-error');
  }

  if (tone === 'success') {
    statusBanner.classList.add('is-success');
  }
}

function renderSelect(select, items, selectedValue, valueKey) {
  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Выберите календарь';
  select.appendChild(placeholder);

  items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item[valueKey] || '';
    option.textContent = item.name || item.id || item.url || 'Без названия';
    option.selected = option.value === selectedValue;
    select.appendChild(option);
  });
}

function fillSettings(response) {
  const settings = response.settings || {};
  const status = response.status || {};
  const runtimeState = status.state || {};

  fields.bitrixCalendarId.value = settings.bitrixCalendarId || '';
  fields.yandexUsername.value = settings.yandexUsername || '';
  fields.yandexPassword.value = '';
  fields.syncEnabled.checked = Boolean(settings.syncEnabled);

  state.calendars.bitrix = response.calendars?.bitrix || [];
  state.calendars.yandex = response.calendars?.yandex || [];

  renderSelect(fields.bitrixCalendarId, state.calendars.bitrix, settings.bitrixCalendarId || '', 'id');
  renderSelect(fields.yandexCalendarUrl, state.calendars.yandex, settings.yandexCalendarUrl || '', 'url');

  runtimeStatus.textContent = JSON.stringify(status, null, 2);
  connectionStatus.textContent = status.configured ? 'Готово к синхронизации' : 'Требуются настройки';
  lastSyncValue.textContent = runtimeState.lastSuccessAt || runtimeState.lastRunAt || 'Никогда';
  lastErrorValue.textContent = runtimeState.lastErrorMessage || 'Нет';
  portalValue.textContent = response.installation?.portalHost || '-';
  bitrixUserValue.textContent = response.connection?.bitrixUserName || response.connection?.bitrixUserId || '-';
  portalCaption.textContent = `${response.installation?.portalHost || 'Портал'} · пользователь ${bitrixUserValue.textContent}`;

  if (response.configured) {
    setBanner('Подключение настроено. Автоматический sync выполняется каждые 5 минут, а кнопку можно использовать для мгновенной проверки.', 'success');
    return;
  }

  if (response.credentials?.yandexPasswordSaved) {
    setBanner('Пароль приложения Яндекс сохранен на сервере. Осталось выбрать календари и при необходимости включить синхронизацию.');
    return;
  }

  setBanner('Подключите Яндекс Календарь, выберите календари и сохраните настройки.');
}

function maskSecrets(value, parentKey = '') {
  const secretKeyPattern = /(password|token|secret|credential|authorization|auth|cookie|session)/i;
  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item, parentKey));
  }

  if (value && typeof value === 'object') {
    const masked = {};
    for (const [key, nested] of Object.entries(value)) {
      if (secretKeyPattern.test(key)) {
        masked[key] = '***redacted***';
      } else {
        masked[key] = maskSecrets(nested, key);
      }
    }
    return masked;
  }

  if (typeof value === 'string' && secretKeyPattern.test(parentKey)) {
    return value ? '***redacted***' : '';
  }

  return value;
}

function renderDebugTrace(debugTrace) {
  ensureDiagnosticsPanel();
  if (!diagnosticsSummary || !diagnosticsRaw) {
    return;
  }

  if (!debugTrace?.available || !debugTrace.trace) {
    diagnosticsSummary.textContent = 'Debug trace пока отсутствует. Запустите sync, чтобы получить диагностический run-level trail.';
    diagnosticsRaw.textContent = JSON.stringify({ available: false }, null, 2);
    return;
  }

  const masked = maskSecrets(debugTrace.trace);
  const summary = masked.summary || {};
  diagnosticsSummary.textContent = [
    `run: ${masked.runMeta?.trigger || '-'} (${masked.runMeta?.status || '-'})`,
    `trail events (today+): ${summary.trailCount ?? 0}`,
    `soft failures: ${summary.softFailures ?? 0}`,
    `expected recurring skips: ${summary.expectedRecurringSkips ?? 0}`,
    `markers: ${debugTrace.markers?.length || 0}, truncated: ${Boolean(debugTrace.truncated)}`,
  ].join('\n');
  diagnosticsRaw.textContent = JSON.stringify({ ...debugTrace, trace: masked }, null, 2);

  console.groupCollapsed('[onboarding][sync-debug] summary');
  console.table(summary.reasonBuckets || {});
  console.log(masked.runMeta);
  console.groupEnd();

  console.groupCollapsed('[onboarding][sync-debug] trail');
  console.table((masked.trail || []).map((item) => ({
    decision: item.decision?.reason || '-',
    direction: item.direction,
    eventKey: item.eventKey,
    mutation: item.mutation?.outcome || '-',
  })));
  console.groupEnd();
}

async function loadDebugTrace() {
  const payload = await fetchJson(endpoint('/sync/debug-trace'));
  state.debugTrace = payload.debugTrace || null;
  renderDebugTrace(state.debugTrace);
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
    },
    ...options,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }

  return payload;
}

async function loadSettings() {
  setBanner('Загрузка настроек...');
  const payload = await fetchJson(endpoint());
  fillSettings(payload);
  await loadDebugTrace().catch(() => renderDebugTrace(null));
}

async function persistCurrentSettings() {
  const payload = {
    bitrixCalendarId: fields.bitrixCalendarId.value,
    syncEnabled: fields.syncEnabled.checked,
    yandexCalendarUrl: fields.yandexCalendarUrl.value,
    yandexUsername: fields.yandexUsername.value,
  };

  if (fields.yandexPassword.value) {
    payload.yandexPassword = fields.yandexPassword.value;
  }

  return fetchJson(endpoint(), {
    body: JSON.stringify(payload),
    method: 'PUT',
  });
}

async function saveSettings(event) {
  event.preventDefault();
  setBanner('Сохранение настроек...');

  await persistCurrentSettings();

  await loadSettings();
  setBanner('Настройки сохранены.', 'success');
}

async function loadCalendars(provider) {
  setBanner(`Загрузка календарей ${provider === 'bitrix' ? 'Bitrix24' : 'Яндекс'}...`);
  if (provider === 'yandex') {
    await persistCurrentSettings();
  }

  const payload = await fetchJson(endpoint(`/${provider}/calendars`));

  state.calendars[provider] = payload.calendars || [];

  if (provider === 'bitrix') {
    renderSelect(fields.bitrixCalendarId, state.calendars.bitrix, fields.bitrixCalendarId.value, 'id');
  } else {
    renderSelect(fields.yandexCalendarUrl, state.calendars.yandex, fields.yandexCalendarUrl.value, 'url');
  }

  setBanner(`Календари ${provider === 'bitrix' ? 'Bitrix24' : 'Яндекс'} загружены. Сохраните выбранную связку.`, 'success');
}

async function triggerSync() {
  setBanner('Запуск синхронизации только по новым изменениям...');
  const payload = await fetchJson(endpoint('/sync/run'), {
    body: JSON.stringify({}),
    method: 'POST',
  });

  runtimeStatus.textContent = JSON.stringify(payload.result?.status || payload.status || payload, null, 2);
  await loadDebugTrace().catch(() => renderDebugTrace(null));
  setBanner('Ручной sync по новым изменениям завершен.', 'success');
}

settingsForm.addEventListener('submit', (event) => {
  void saveSettings(event).catch((error) => setBanner(error.message, 'error'));
});

refreshSettingsButton.addEventListener('click', () => {
  void loadSettings().catch((error) => setBanner(error.message, 'error'));
});

loadBitrixCalendarsButton.addEventListener('click', () => {
  void loadCalendars('bitrix').catch((error) => setBanner(error.message, 'error'));
});

loadYandexCalendarsButton.addEventListener('click', () => {
  void loadCalendars('yandex').catch((error) => setBanner(error.message, 'error'));
});

manualSyncButton.addEventListener('click', () => {
  void triggerSync().catch((error) => setBanner(error.message, 'error'));
});

void loadSettings().catch((error) => setBanner(error.message, 'error'));
