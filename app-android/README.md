# dsh_hub — Android-клиент федерации

Нативное приложение для телефона: узлы федерации, сессии узла, переписка сессии,
отправка промпта, «Новая сессия» и «Стоп». Русский интерфейс, тёмная тема,
одноколоночный вид на узком экране и двухпанельный (список + детали) на широком.

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
`SharedPreferences` (`dsh_hub` / `token`, `base`).

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

## Оговорки, найденные на живом хабе

- **HONOR ходит в хаб через свой VPN.** У телефона поднят `tun0` (100.106.55.30),
  и запросы к `192.168.88.35` уходят в туннель: `failed to connect ... from 100.106.55.30`.
  Для снимков использован `adb reverse tcp:18990 tcp:18990` и адрес `http://127.0.0.1:18990`;
  в обычной жизни на этом телефоне нужен либо адрес хаба, видимый из VPN, либо
  исключение `192.168.88.35` в раздельном туннеле Amnezia.
- **Снапшот узла отдаёт одно и то же сообщение для всех сессий.** После `POST /create`
  новая сессия появилась (`title: null` → позже заголовок стал «ping from dsh_hub»),
  но `/api/federation/session` для неё возвращает сообщение seq 8 из старой сессии.
  Приложение показывает ровно то, что отдал хаб; это баг экспортёра на узле, не клиента.
- `POST /prompt` возвращает `queued` + `commandId`, узел затем пишет в аудит
  `result: done, accepted: true` — отправка работает, но новые сообщения в снапшот
  переписки узел пока не кладёт (тот же баг).
- Заголовок сессии приходит как JSON `null` — клиент подставляет «(без названия)».

## Не сделано

- Ввод русского текста через `adb shell input text` не проверить (кириллица не
  инжектится) — проверено ASCII-промптом.
- Реальный сгиб HONOR руками не трогали: складной телефон физически не складывали,
  узкая раскладка снята через `wm size` (эмуляция 360 dp), широкая — настоящая, 718 dp.
- Пуш-уведомления, SSE-обновления в реальном времени, выбор модели и переименование
  сессии в клиент не входят — по заданию не требовались.
