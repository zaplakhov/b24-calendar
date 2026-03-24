# b24-calendar

Сервис синхронизации календарей `Bitrix24 <-> Яндекс Календарь` в режиме `Bitrix local app without UI`.

Приложение работает как серверная интеграция:
- локальное приложение устанавливается в Bitrix24 без встроенного интерфейса
- пользователь проходит внешний OAuth/onboarding flow на вашем домене
- настройки Яндекс Календаря заполняются на внешней странице
- синхронизация и polling выполняются на сервере

## Что уже реализовано

- Bitrix24 install endpoint для локального приложения
- внешний `connect` flow для OAuth авторизации пользователя Bitrix24
- внешний onboarding page для настройки Яндекс Календаря
- per-user connections в SQLite
- scoped sync state и event mappings по connection
- загрузка календарей Bitrix24 и Яндекс для каждой connection
- ручная ресинхронизация и background polling
- Dockerfile для деплоя на VPS / Coolify

## Архитектура

- `backend/` — Express + SQLite + Bitrix REST + Yandex CalDAV
- `frontend/connect/` — внешняя страница запуска OAuth
- `frontend/onboarding/` — внешняя страница настройки календарей и sync
- `.data/` или `/data` — SQLite volume

## Переменные окружения

Скопируйте `.env.example` и заполните минимум:

- `APP_BASE_URL` — публичный HTTPS URL приложения
- `APP_SIGNING_SECRET` — секрет для подписи state / onboarding flow
- `BITRIX_CLIENT_ID` — ключ приложения из формы локального приложения Bitrix24
- `BITRIX_CLIENT_SECRET` — секрет приложения из формы локального приложения Bitrix24

Пример локального запуска:

```bash
npm install --prefix backend
npm run build --prefix backend
npm start --prefix backend
```

## Docker / Coolify

Собрать образ:

```bash
docker build -t b24-calendar .
```

Запустить с volume для SQLite:

```bash
docker run --rm -p 3000:3000 -v "$PWD/.data:/data" --name b24-calendar b24-calendar
```

В production рекомендуется:
- подключить persistent volume в `/data`
- выставить `APP_BASE_URL` на публичный HTTPS домен
- хранить `BITRIX_CLIENT_SECRET` и `APP_SIGNING_SECRET` в секретах Coolify

## Настройка в Bitrix24

1. Разверните сервис по HTTPS.
2. Откройте Bitrix24: `Приложения -> Разработчикам -> Другое -> Локальное приложение`.
3. Включите опцию `Приложение использует только API`.
4. Укажите:
   - `Путь вашего обработчика` -> `https://your-domain.example.com/bitrix/oauth/callback`
   - `Путь для первоначальной установки` -> `https://your-domain.example.com/bitrix/install`
5. Сохраните приложение.
6. Bitrix24 покажет `client_id` и `client_secret`.
7. Запишите их в `BITRIX_CLIENT_ID` и `BITRIX_CLIENT_SECRET` и перезапустите сервис.
8. После этого откройте внешнюю страницу:

   `https://your-domain.example.com/connect/`

9. Введите портал Bitrix24 и пройдите OAuth.
10. После callback вы попадете на onboarding URL вида:

    `https://your-domain.example.com/onboarding/<token>`

11. На onboarding странице:
    - загрузите календари Bitrix24
    - укажите `Yandex username`
    - укажите `app password`
    - загрузите календари Яндекс
    - выберите пару календарей
    - включите sync

## Основные маршруты

### Public web

- `GET /` -> redirect на `/connect/`
- `GET /connect/` -> внешняя страница старта OAuth
- `GET /onboarding/:token` -> внешняя страница настройки connection

### Bitrix lifecycle

- `ALL /bitrix/install` -> обработчик первоначальной установки локального приложения
- `GET /bitrix/oauth/start?portal=company.bitrix24.ru` -> старт OAuth пользователя
- `GET /bitrix/oauth/callback` -> callback после Bitrix OAuth

### API onboarding

- `GET /api/onboarding/:token` -> полное состояние connection
- `PUT /api/onboarding/:token` -> сохранить настройки connection
- `GET /api/onboarding/:token/bitrix/calendars` -> загрузить календари Bitrix24
- `GET /api/onboarding/:token/yandex/calendars` -> загрузить календари Яндекс
- `GET /api/onboarding/:token/sync/status` -> статус sync
- `POST /api/onboarding/:token/sync/run` -> ручная ресинхронизация

### Runtime

- `POST /api/webhook/bitrix` -> webhook intake для Bitrix событий
- `GET /health` -> технический health endpoint

## Как это работает для пользователя

1. Администратор портала регистрирует local app в Bitrix24.
2. Пользователь открывает `/connect/`.
3. Пользователь проходит Bitrix OAuth.
4. Сервис создает scoped connection для конкретного Bitrix пользователя.
5. Пользователь заполняет данные Яндекс на `/onboarding/:token`.
6. Сервис синхронизирует события только для этой connection.

## Ограничения текущей версии

- Текущий deployment предполагает один набор `BITRIX_CLIENT_ID/BITRIX_CLIENT_SECRET` на один инстанс сервиса.
- Это хорошо подходит для одного портала Bitrix24 с любым количеством пользователей этого портала.
- Для true multi-portal SaaS нужны отдельные client credentials per portal и отдельный lifecycle management.
- Повторяющиеся события по-прежнему намеренно пропускаются.

## Быстрая ручная проверка

1. Убедитесь, что `GET /health` отвечает `status: ok`.
2. Отправьте install payload из Bitrix24 и проверьте, что `/bitrix/install` отвечает `ok: true`.
3. Откройте `/connect/` и выполните OAuth для пользователя портала.
4. На `/onboarding/:token` загрузите календари Bitrix24 и Яндекс.
5. Сохраните настройки и включите sync.
6. Запустите `POST /api/onboarding/:token/sync/run` или кнопку ручной ресинхронизации.
7. Проверьте, что статусы и reviewer evidence обновляются.
