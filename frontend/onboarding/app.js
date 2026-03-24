const onboardingToken = window.location.pathname.split('/').filter(Boolean).pop();

const state = {
  calendars: {
    bitrix: [],
    yandex: [],
  },
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
}

async function saveSettings(event) {
  event.preventDefault();
  setBanner('Сохранение настроек...');

  const payload = {
    bitrixCalendarId: fields.bitrixCalendarId.value,
    syncEnabled: fields.syncEnabled.checked,
    yandexCalendarUrl: fields.yandexCalendarUrl.value,
    yandexUsername: fields.yandexUsername.value,
  };

  if (fields.yandexPassword.value) {
    payload.yandexPassword = fields.yandexPassword.value;
  }

  await fetchJson(endpoint(), {
    body: JSON.stringify(payload),
    method: 'PUT',
  });

  await loadSettings();
  setBanner('Настройки сохранены.', 'success');
}

async function loadCalendars(provider) {
  setBanner(`Загрузка календарей ${provider === 'bitrix' ? 'Bitrix24' : 'Яндекс'}...`);
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
