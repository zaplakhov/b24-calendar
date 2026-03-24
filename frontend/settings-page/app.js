const state = {
  calendars: {
    yandex: [],
  },
};

const settingsForm = document.getElementById('settingsForm');
const refreshSettingsButton = document.getElementById('refreshSettingsButton');
const loadYandexCalendarsButton = document.getElementById('loadYandexCalendarsButton');
const manualSyncButton = document.getElementById('manualSyncButton');
const statusBanner = document.getElementById('statusBanner');
const runtimeStatus = document.getElementById('runtimeStatus');
const connectionStatus = document.getElementById('connectionStatus');
const lastSyncValue = document.getElementById('lastSyncValue');
const lastErrorValue = document.getElementById('lastErrorValue');

const fields = {
  syncEnabled: document.getElementById('syncEnabled'),
  yandexCalendarUrl: document.getElementById('yandexCalendarUrl'),
  yandexPassword: document.getElementById('yandexPassword'),
  yandexUsername: document.getElementById('yandexUsername'),
};

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
  placeholder.textContent = 'Select calendar';
  select.appendChild(placeholder);

  items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item[valueKey] || '';
    option.textContent = item.name || item.id || item.url || 'Unnamed calendar';
    option.selected = option.value === selectedValue;
    select.appendChild(option);
  });
}

function fillSettings(response) {
  const settings = response.settings || {};
  const status = response.status || {};
  const runtimeState = status.state || {};
  const manualResync = status.manualResync || {};
  const savedCredentials = response.credentials || {};

  fields.yandexUsername.value = settings.yandexUsername || '';
  fields.yandexPassword.value = '';
  fields.syncEnabled.checked = Boolean(settings.syncEnabled);

  state.calendars.yandex = response.calendars?.yandex || [];

  renderSelect(fields.yandexCalendarUrl, state.calendars.yandex, settings.yandexCalendarUrl || '', 'url');
  runtimeStatus.textContent = JSON.stringify(status, null, 2);
  connectionStatus.textContent = status.configured ? 'Connected' : 'Not configured';
  lastSyncValue.textContent = runtimeState.lastSuccessAt || runtimeState.lastRunAt || 'Never';
  lastErrorValue.textContent = runtimeState.lastErrorMessage || 'None';

  if (response.configured) {
    setBanner('Sync is configured and ready for MVP testing.', 'success');
    return;
  }

  if (savedCredentials.yandexPasswordSaved) {
    setBanner(`Saved app password is kept server-side. ${manualResync.message || 'Finish setup to continue.'}`);
    return;
  }

  setBanner(manualResync.message || 'Save credentials and load calendars to complete setup.');
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
  setBanner('Loading settings…');
  const payload = await fetchJson('/api/settings');
  fillSettings(payload);
}

async function saveSettings(event) {
  event.preventDefault();
  setBanner('Saving settings…');

  const payload = {
    syncEnabled: fields.syncEnabled.checked,
    yandexCalendarUrl: fields.yandexCalendarUrl.value,
    yandexUsername: fields.yandexUsername.value,
  };

  if (fields.yandexPassword.value) {
    payload.yandexPassword = fields.yandexPassword.value;
  }

  await fetchJson('/api/settings', {
    body: JSON.stringify(payload),
    method: 'PUT',
  });

  await loadSettings();
  setBanner('Settings saved.', 'success');
}

async function loadCalendars(provider) {
  setBanner(`Loading ${provider} calendars…`);
  const payload = await fetchJson(`/api/settings/${provider}/calendars`);

  state.calendars.yandex = payload.calendars || [];
  renderSelect(fields.yandexCalendarUrl, state.calendars.yandex, fields.yandexCalendarUrl.value, 'url');

  setBanner(`${provider} calendars loaded. Save settings to persist the selected mapping.`, 'success');
}

async function triggerSync(url, successMessage) {
  setBanner('Running sync…');
  const payload = await fetchJson(url, {
    body: JSON.stringify({}),
    method: 'POST',
  });

  runtimeStatus.textContent = JSON.stringify(payload.result?.status || payload.status || payload, null, 2);
  setBanner(successMessage, 'success');
}

settingsForm.addEventListener('submit', (event) => {
  void saveSettings(event).catch((error) => setBanner(error.message, 'error'));
});

refreshSettingsButton.addEventListener('click', () => {
  void loadSettings().catch((error) => setBanner(error.message, 'error'));
});

loadYandexCalendarsButton.addEventListener('click', () => {
  void loadCalendars('yandex').catch((error) => setBanner(error.message, 'error'));
});

manualSyncButton.addEventListener('click', () => {
  void triggerSync('/api/sync/run', 'Manual resync completed.').catch((error) => setBanner(error.message, 'error'));
});

void loadSettings().catch((error) => setBanner(error.message, 'error'));
