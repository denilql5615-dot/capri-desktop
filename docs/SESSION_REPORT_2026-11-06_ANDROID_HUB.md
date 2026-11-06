# GENESIS HUB & Android Bridge Session Report (2026-11-06)

## 1. Сводка сессии
- **Цель:** Завершить сквозной путь GENESIS HUB на Windows и полностью реализовать нативный клиент GENESIS HUB в Android-приложении (`capri-android-ref`), сохранив стиль Nothing OS × Arasaka AI (`ui-ux-pro-max`).
- **Коммиты:**
  - `capri-desktop`: `43f1b9d` (`feat(hub): connect Antigravity quotas and expose agent hub over phone bridge`)
  - `capri-android`: `d94fcf6` (`feat(hub): add native GENESIS Agents Hub screen and bridge client`)

---

## 2. Результаты по этапам

### Этап 1: Сквозной путь файлов в Windows Hub
- Устранён дефект в `src/main/hub-artifacts.js`: непадающая обработка `ENOENT` при обращении к несуществующим папкам запуска (возврат понятной ошибки «Вложение недоступно»).
- Создан и запущен живой тест `tests/live-hub-file-flow.test.js`:
  - Создание сессии, изолированная папка `hub-artifacts/<UUID>`, создание текстовых и бинарных файлов.
  - Прикрепление артефактов к сообщениям истории.
  - Защита от path traversal (`..`, `\`, абсолютные пути) и опасных расширений (`.exe`, `.bat`, `.ps1` и т.д.).
  - Проверены действия `open`, `copy` и `save` с `COPYFILE_EXCL`.
  - Валидация web-ссылок и отсечение недопустимых схем.

### Этап 2: Облачные медиа-возможности провайдеров
- **Claude Code (`claude`):** Инструменты генерации картинок и видео в CLI отсутствуют.
- **Codex (`codex`):** DALL-E/видео в текущей конфигурации CLI недоступны.
- **Antigravity (`agy`):** Генерация картинок **доступна и подтверждена живым тестом** через суб-агента `image-generator` и Google Cloud Imagen (создан JPEG 485 КБ). Генерация видео (Veo) в CLI отсутствует. ComfyUI и Wan для облачных задач не подменяются согласно правилам.

### Этап 3: Автообновление квот Antigravity
- В `src/main/agent-quotas.js` реализован парсер `parseAgyStatusLineQuota`, разбирающий 5 ключей (`gemini-5h`, `gemini-weekly`, `gemini-argon-wtu-weekly`, `3p-5h`, `3p-weekly`) по группам `agy-argon`, `agy-gemini` и `agy-third-party`.
- В `src/main/main.js` добавлено фоновое обновление с кэшем 120 с, защитой от параллельных вызовов и меткой устаревания `stale` (> 600 с).
- В интерфейсе `src/renderer/js/agent-hub.js` подключена кнопка «Обновить» и индикаторы устаревания.

### Этап 4: PhoneBridge для агентов (порт 8770)
- В `src/main/phone.js` и `src/main/main.js` подключены защищённые эндпоинты:
  - `GET /agents` — список сессий и модели.
  - `GET /agents/sessions?agent=...` — сессии конкретного агента.
  - `POST /agents/sessions` — создание сессии.
  - `GET /agents/session?id=...` — история сообщений сессии.
  - `POST /agents/send` — отправка команды агенту с таймаутом до 5 минут.
  - `POST /agents/stop` — остановка выполнения задачи.
  - `GET /agents/quota` — получение квот агентов.
  - `GET /agents/artifact` — загрузка артефактов с токеном в заголовке или строке запроса (`?token=...`).
- Все 8 эндпоинтов проверены тестами в `tests/phone.test.js` и скриптом `test_bridge_endpoints.js`.

### Этап 5: Нативный Android GENESIS HUB (`capri-android-ref`)
- В `Bridge.kt` добавлены типизированные методы вызова Hub API.
- Создана `AgentsActivity.kt` в стилистике Nothing × Arasaka:
  - Палитра OLED `#000000`, карточки `#0F0F0F`, акцент `#D71921`, `DotText`, моноширинный шрифт.
  - Переключатель 5 агентов (`Antigravity`, `Claude`, `Codex`, `Gemma`, `Faun`).
  - Карточка квоты с процентами использования окон и кнопкой «↻ ОБНОВИТЬ».
  - Список сессий с бейджем `● В РАБОТЕ` и кнопкой `+ НОВЫЙ ЧАТ`.
  - Чат сессии с выбором модели, остановкой `■ СТОП`, карточками артефактов, асинхронным превью картинок, кнопками «ОТКРЫТЬ» и «СКАЧАТЬ» (в `DownloadManager`).
- Точки входа:
  - `MainActivity.kt`: кнопка `⚡ ХАБ АГЕНТОВ (GENESIS) →` в разделе «МОЗГ».
  - `ChatActivity.kt`: кнопка `⚡` в верхней панели для мгновенного перехода.
- `AndroidManifest.xml`: зарегистрирована `AgentsActivity`.

---

## 3. Статус CI / Сборки
- Изменения `capri-desktop` и `capri-android` отправлены в ветки `main`.
- На GitHub в `capri-android` запущен автоматический Action `.github/workflows/build.yml` для сборки подписанного `capri.apk`.
