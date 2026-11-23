# DSH Federation — Android-клиент федерации

Нативное приложение для телефона: узлы федерации, сессии узла, переписка сессии,
отправка промпта, «Новая сессия» и «Стоп». Русский интерфейс, тёмная тема,
одноколоночный вид на узком экране и двухпанельный (список + детали) на широком.

Версия 2 (24.11) — редизайн: своя палитра (`#070A11` фон, `#5B8CFF`/`#A06BFF` акцент),
градиентная шапка с логотипом-сетью, карточки узлов с живой точкой связи и статусом,
карточки сессий с полосой статуса, пузыри переписки, композер с круглой кнопкой,
анимации переходов. Иконка приложения — та же сеть из трёх узлов; растр собирается
скриптом `tools/make_icon.py` (legacy 48–192 px + adaptive foreground 108dp).

Собрано **Kotlin 2.0.20 + Jetpack Compose (compose-bom 2024.09.02, Material3 1.3.0)**,
AGP 8.5.2, Gradle 8.9, JDK 21, compileSdk/targetSdk 35, minSdk 24.
Один файл кода: `app/src/main/java/ru/dsh/hub/MainActivity.kt`.
HTTP — `HttpURLConnection`, JSON — `org.json`, токен — `SharedPreferences`. Внешних
сетевых библиотек нет намеренно: одна зависимость — это одна зависимость меньше.

## Что делает

| Экран | Запрос | Что видно |
|---|---|---|
| Узлы | `GET /api/federation/nodes` | имя, id, os, «в сети» |
| Сессии | `GET /api/federation/sessions?node=<id>` | заголовок, статус, время; кнопки «Обновить», «＋ Новая» (`POST /api/federation/create`) |
| Переписка | `GET /api/federation/session?id=<id>&node=<id>` | сообщения (роль/текст/время), поле промпта (`POST /api/federation/prompt`), «Стоп» (`POST /api/federation/cancel`) |

Все запросы идут с заголовком `authorization: Bearer <hub-token>`.
Токен и адрес хаба не в коде: их вводят в диалоге «Токен» и они лежат в
`SharedPreferences` (`DSH Federation` / `token`, `base`).

Раскладка выбирается по `LocalConfiguration.screenWidthDp`: `< 600 dp` — одна колонка
с навигацией «назад», `>= 600 dp` — слева узлы (сверху) и сессии (снизу), справа
переписка. Выбранный узел, сессия и черновик промпта живут в `ViewModel`, поэтому
сгиб/разгиб (пересоздание Activity) их не теряет.

## Сборка

```bash
cd app-android
export ANDROID_HOME=/srv/apps/dsh/android-sdk
export ANDROID_SDK_ROOT=/srv/apps/dsh/android-sdk
/srv/apps/dsh/gradle-8.9/bin/gradle --offline -q assembleDebug
# APK: app-android/app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` с `sdk.dir=/srv/apps/dsh/android-sdk` уже в репозитории (путь хоста),
`--offline` работает на прогретом кэше `~/.gradle`.

## Установка

```bash
# HONOR FCP-N49 (складной, adb по Wi-Fi)
adb -s adb-AXGL024B08000886-1q6BJU._adb-tls-connect._tcp install -r app-debug.apk

# Xiaomi/Redmi 23122PCD1G: HyperOS режет `adb install` (INSTALL_FAILED_USER_RESTRICTED)
adb -s 909f194a push app-debug.apk /sdcard/Download/
adb -s 909f194a shell am start -n com.mi.android.globalFileexplorer/com.android.fileexplorer.activity.FileActivity \
  -d 'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fapp-debug.apk' \
  -t application/vnd.android.package-archive
# в файловом менеджере тап по APK → «Установить»/«Обновить»
```

Запуск с подстановкой токена (удобно для установки/проверки; обычный путь — ввести в диалоге руками):

```bash
adb -s <serial> shell am start -n ru.dsh.hub/.MainActivity \
  -e base "http://192.168.88.35:18990" -e token "$(cat /srv/apps/dsh/federation/hub-token)"
```

## Скриншоты

| Файл | Что на нём |
|---|---|
| `assets/phone-23122PCD1G-nodes.png` | Redmi, 406 dp: «Узлы» — карточка `debian17` / `node_8a602424`, «Узлов: 1» |
| `assets/phone-23122PCD1G-sessions.png` | Redmi: «Сессии: debian17» — две сессии, «＋ Новая» |
| `assets/phone-23122PCD1G-chat.png` | Redmi: переписка, сообщение «Вы», поле промпта, «Стоп» |
| `assets/phone-23122PCD1G-sent.png` | Redmi: после отправки — «Хаб принял промпт: команда 49ceb0cb… (queued)» |
| `assets/phone-FCP-N49-nodes.png` | HONOR, 718 dp (развёрнут): двухпанельный вид, слева узлы, справа подсказка |
| `assets/phone-FCP-N49-panes.png` | HONOR: слева узлы + сессии (`debian17`, 2 сессии), справа переписка с полем промпта |
| `assets/phone-FCP-N49-folded-narrow.png` | HONOR с `wm size 1080x2344` (эмуляция сложенного, 360 dp): та же открытая сессия в одной колонке |

Состояние переживает смену раскладки: сессия была открыта в двухпанельном виде,
после `wm size` (пересоздание Activity) осталась открытой в одноколоночном, после
`wm size reset` вернулась двухпанельная с той же сессией.

## Оговорки и как проверено (24.11)

- **HONOR FCP-N49 ходил в хаб через свой VPN.** Раньше запросы к `192.168.88.35` уходили в `tun0`
  (`failed to connect ... from 100.106.55.30`). Сейчас приложение на нём получает узлы, сессии и
  переписку с тем же `http://192.168.88.35:18990` — проверено живым скриншотом `assets/phone-FCP-N49-panes.png`.
  Если VPN-профиль сменится, адрес хаба нужно будет исключить из туннеля (раздельный туннель Amnezia).
- **Снапшот узла больше не путает сессии.** Запоминается вид запроса `page()`, а не готовый адрес
  с `sessionId`; есть регресс-тест на две сессии. На телефоне открываются обе сессии узла и каждая со своей перепиской.
- **Заголовок сессии может приходить `null`** — клиент подставляет «(без названия)».
- **Кириллица через `adb shell input text` не инжектится** — проверка промпта идёт ASCII-текстом.

## Не сделано

- Ввод русского текста через `adb shell input text` не проверить (кириллица не
  инжектится) — проверено ASCII-промптом.
- Реальный сгиб HONOR руками не трогали: складной телефон физически не складывали,
  узкая раскладка снята через `wm size` (эмуляция 360 dp), широкая — настоящая, 718 dp.
- Пуш-уведомления, SSE-обновления в реальном времени, выбор модели и переименование
  сессии в клиент не входят — по заданию не требовались.
