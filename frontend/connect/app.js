const connectForm = document.getElementById('connectForm');
const portalInput = document.getElementById('portalInput');
const statusBanner = document.getElementById('statusBanner');

function normalizePortal(value) {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

connectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const portal = normalizePortal(portalInput.value);

  if (!portal) {
    statusBanner.textContent = 'Укажите адрес портала Bitrix24, например company.bitrix24.ru';
    statusBanner.classList.add('is-error');
    return;
  }

  statusBanner.classList.remove('is-error');
  statusBanner.textContent = 'Перенаправляем в Bitrix24 OAuth...';
  window.location.href = `/bitrix/oauth/start?portal=${encodeURIComponent(portal)}`;
});
