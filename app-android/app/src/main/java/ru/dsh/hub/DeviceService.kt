package ru.dsh.hub

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// ---------- настройки телефона-узла ----------

internal const val DEVICE_PREFS = "dsh_device"
internal const val K_MODE = "mode"
internal const val K_POLICY_SHELL = "policy_shell"
internal const val K_POLICY_LAUNCH = "policy_launch"
internal const val K_DEVICE_TOKEN = "device_token"
internal const val K_DEVICE_ID = "device_id"
internal const val K_CURSOR = "cursor"
internal const val K_STOPPED = "stopped"
internal const val K_AUDIT = "audit"

internal fun devicePrefs(ctx: Context): SharedPreferences =
    ctx.applicationContext.getSharedPreferences(DEVICE_PREFS, Context.MODE_PRIVATE)

/** Тот же файл, куда MainActivity положила адрес и токен хаба. */
internal fun hubPrefs(ctx: Context): SharedPreferences =
    ctx.applicationContext.getSharedPreferences("dsh_hub", Context.MODE_PRIVATE)

/**
 * Режим работы: выбранный пользователем и фактический. full без Shizuku честно деградирует
 * в assist; assist без включённой службы доступности — в sandbox.
 */
internal object DeviceMode {
    const val SANDBOX = "sandbox"
    const val ASSIST = "assist"
    const val FULL = "full"

    fun selected(ctx: Context): String = devicePrefs(ctx).getString(K_MODE, SANDBOX) ?: SANDBOX

    fun effective(ctx: Context): String =
        effective(selected(ctx), PhoneHands.isReady(), ShizukuBridge.isReady(ctx))

    /** full — только при живом Shizuku и выданном разрешении; иначе честная деградация. */
    fun effective(selected: String, assistReady: Boolean, fullReady: Boolean): String = when (selected) {
        SANDBOX -> SANDBOX
        ASSIST -> if (assistReady) ASSIST else SANDBOX
        FULL -> when {
            fullReady -> FULL
            assistReady -> ASSIST
            else -> SANDBOX
        }
        else -> SANDBOX
    }

    /**
     * Возможности в форме docs/FEDERATION.md §4: modes/tools/full, плюс булевы флаги.
     * phone_shell появляется в tools только когда full реально доступен (Shizuku готов).
     */
    fun capabilities(mode: String, assistReady: Boolean, fullReady: Boolean): JSONObject {
        val modes = JSONArray().put(SANDBOX)
        if (assistReady) modes.put(ASSIST)
        if (fullReady) modes.put(FULL)
        val hands = assistReady && mode != SANDBOX
        val shell = mode == FULL && fullReady
        val tools = JSONArray()
        if (hands) {
            tools.put("phone_ui_tree").put("phone_screenshot").put("phone_tap")
                .put("phone_swipe").put("phone_type").put("phone_open_app")
        }
        if (shell) tools.put("phone_shell")
        return JSONObject()
            .put("modes", modes)
            .put("tools", tools)
            .put("full", fullReady)
            .put("screenshot", hands)
            .put("ui_tree", hands)
            .put("tap", hands)
            .put("swipe", hands)
            .put("text", hands)
            .put("key", hands)
            .put("launch", hands)
            .put("shell", shell)
    }
}

/** Локальный журнал: последние 100 действий агента. Виден на экране «Доступ». */
internal object Audit {
    private const val MAX = 100

    fun add(ctx: Context, kind: String, ok: Boolean, error: String?, ms: Long) {
        val p = devicePrefs(ctx)
        val out = JSONArray()
        out.put(
            JSONObject()
                .put("ts", System.currentTimeMillis())
                .put("kind", kind)
                .put("ok", ok)
                .put("error", error ?: JSONObject.NULL)
                .put("ms", ms)
        )
        val old = runCatching { JSONArray(p.getString(K_AUDIT, "[]") ?: "[]") }.getOrElse { JSONArray() }
        for (i in 0 until old.length()) {
            if (out.length() >= MAX) break
            out.put(old.getJSONObject(i))
        }
        runCatching { p.edit().putString(K_AUDIT, out.toString()).apply() }
    }

    fun list(ctx: Context): List<JSONObject> =
        runCatching {
            val arr = JSONArray(devicePrefs(ctx).getString(K_AUDIT, "[]") ?: "[]")
            (0 until arr.length()).map { arr.getJSONObject(it) }
        }.getOrElse { emptyList() }
}

/** HTTP к хабу. Один метод — за глаза: hello, long-poll, reply. */
internal object DeviceApi {
    fun call(
        base: String,
        token: String,
        path: String,
        method: String = "GET",
        body: String? = null,
        readTimeoutMs: Int = 15000,
        connectTimeoutMs: Int = 10000,
    ): JSONObject {
        val conn = (URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            useCaches = false
            setRequestProperty("authorization", "Bearer $token")
            setRequestProperty("accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json; charset=utf-8")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw IllegalStateException("HTTP $code: ${text.take(200)}")
            return runCatching { JSONObject(text.ifBlank { "{}" }) }.getOrElse { JSONObject() }
        } finally {
            conn.disconnect()
        }
    }
}

// ---------- служба устройства ----------

/**
 * Фоновое соединение с хабом: hello раз в 30 с, long-poll команд, исполнение по режиму и
 * политике, ответ reply. Постоянное уведомление с кнопкой «Стоп» — цена доступа, а не баг.
 */
class DeviceService : Service() {

    companion object {
        private const val TAG = "DshDevice"
        const val CHANNEL = "dsh_device"
        const val NOTIF_ID = 7100
        const val ACTION_STOP = "ru.dsh.hub.action.DEVICE_STOP"

        @Volatile
        var running: Boolean = false
            private set

        private var instance: DeviceService? = null

        /** Явный «Пуск»: снимает стоп-кран и поднимает службу. */
        fun startDevice(ctx: Context) {
            devicePrefs(ctx).edit().putBoolean(K_STOPPED, false).apply()
            runCatching {
                ContextCompat.startForegroundService(ctx, Intent(ctx, DeviceService::class.java))
            }.onFailure { Log.w(TAG, "start: ${it.message}") }
        }

        /** Стоп-кран: гаснет исполнение и сама служба, до явного «Пуск». */
        fun stopDevice(ctx: Context, reason: String) {
            devicePrefs(ctx).edit().putBoolean(K_STOPPED, true).apply()
            Audit.add(ctx, "stop", true, reason, 0)
            runCatching { ctx.stopService(Intent(ctx, DeviceService::class.java)) }
        }

        /** Служба доступности включилась/выключилась — режим и capabilities изменились. */
        fun onHandsChanged(ctx: Context) {
            instance?.let { svc ->
                svc.refreshNotification()
                svc.scope.launch { svc.safeHello() }
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var helloJob: Job? = null
    private var pollJob: Job? = null

    @Volatile
    private var lastHelloAt: Long = 0L

    private val prefListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == K_MODE || key == K_POLICY_SHELL || key == K_POLICY_LAUNCH) {
            refreshNotification()
            scope.launch { safeHello() }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        running = true
        createChannel()
        startAsForeground()
        devicePrefs(this).registerOnSharedPreferenceChangeListener(prefListener)
        helloJob = scope.launch { helloLoop() }
        pollJob = scope.launch { pollLoop() }
        Log.i(TAG, "service started, mode=${DeviceMode.effective(this)}")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopDevice(this, "уведомление")
            return START_NOT_STICKY
        }
        startAsForeground()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        runCatching { devicePrefs(this).unregisterOnSharedPreferenceChangeListener(prefListener) }
        helloJob?.cancel()
        pollJob?.cancel()
        scope.cancel()
        instance = null
        running = false
        Log.i(TAG, "service stopped")
        super.onDestroy()
    }

    // ---------- уведомление ----------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, "DSH доступ к телефону", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Постоянное уведомление: телефон на связи с хабом федерации. Кнопка «Стоп» гасит доступ."
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        nm.createNotificationChannel(ch)
    }

    private fun modeLine(): String {
        val mode = DeviceMode.effective(this)
        return when (mode) {
            DeviceMode.SANDBOX -> "режим: sandbox · экран не читается"
            else -> "режим: $mode · жду команд хаба"
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getBroadcast(
            this, 1,
            Intent(this, DeviceStopReceiver::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("DSH доступ к телефону")
            .setContentText(modeLine())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(open)
            .addAction(0, "Стоп", stop)
            .build()
    }

    private fun startAsForeground() {
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), type)
    }

    private fun refreshNotification() {
        if (!running) return
        runCatching { startAsForeground() }
    }

    // ---------- цикл связи ----------

    private suspend fun helloLoop() {
        while (currentCoroutineContext().isActive) {
            safeHello()
            delay(30_000)
        }
    }

    private suspend fun safeHello() {
        runCatching { hello() }.onFailure {
            if (it is CancellationException) throw it
            Log.w(TAG, "hello: ${it.message}")
        }
    }

    private suspend fun hello() {
        val base = hubPrefs(this).getString("base", DEFAULT_BASE) ?: DEFAULT_BASE
        val hubToken = hubPrefs(this).getString("token", "") ?: ""
        val devToken = devicePrefs(this).getString(K_DEVICE_TOKEN, "") ?: ""
        val auth = devToken.ifBlank { hubToken }
        if (auth.isBlank()) {
            Log.w(TAG, "токен хаба не задан — hello не отправлен")
            return
        }
        val p = devicePrefs(this)
        val assistReady = PhoneHands.isReady()
        val fullReady = ShizukuBridge.isReady(this)
        val mode = DeviceMode.effective(DeviceMode.selected(this), assistReady, fullReady)
        val body = JSONObject()
            .put("proto", 1)
            .put(
                "device", JSONObject()
                    .put("name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    .put("model", Build.MODEL)
                    .put("android", Build.VERSION.RELEASE)
                    .put("sdk", Build.VERSION.SDK_INT)
            )
            .put("mode", mode)
            .put("capabilities", DeviceMode.capabilities(mode, assistReady, fullReady))
            .put(
                "policies", JSONObject()
                    .put("shell", p.getString(K_POLICY_SHELL, "ask") ?: "ask")
                    .put("launch", p.getString(K_POLICY_LAUNCH, "auto") ?: "auto")
            )
        val r = DeviceApi.call(base, auth, "/fed/v1/device/hello", "POST", body.toString(), 15000)
        r.optString("token").takeIf { it.isNotBlank() }?.let { p.edit().putString(K_DEVICE_TOKEN, it).apply() }
        r.optString("deviceId").takeIf { it.isNotBlank() }?.let { p.edit().putString(K_DEVICE_ID, it).apply() }
        lastHelloAt = System.currentTimeMillis()
        refreshNotification()
        Log.i(TAG, "hello ok: mode=$mode id=${r.optString("deviceId")}")
    }

    private suspend fun pollLoop() {
        var backoff = 1L
        while (currentCoroutineContext().isActive) {
            if (devicePrefs(this).getBoolean(K_STOPPED, false)) {
                delay(2000)
                continue
            }
            val base = hubPrefs(this).getString("base", DEFAULT_BASE) ?: DEFAULT_BASE
            val hubToken = hubPrefs(this).getString("token", "") ?: ""
            val token = (devicePrefs(this).getString(K_DEVICE_TOKEN, "") ?: "").ifBlank { hubToken }
            if (token.isBlank() || lastHelloAt == 0L) {
                delay(3000)
                continue
            }
            try {
                val had = pollOnce(base, token)
                backoff = 1L
                if (!had) delay(150)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "poll: ${e.message}")
                delay(backoff * 1000)
                backoff = (backoff * 2).coerceAtMost(30L)
            }
        }
    }

    private suspend fun pollOnce(base: String, token: String): Boolean {
        val p = devicePrefs(this)
        val cursor = p.getLong(K_CURSOR, 0L)
        // wait=25: хаб держит запрос до 25 с, если очередь пуста — без этого долбим его вхолостую
        val r = DeviceApi.call(base, token, "/fed/v1/device/commands?cursor=$cursor&wait=25", "GET", null, 45000)
        val arr = r.optJSONArray("commands") ?: JSONArray()
        var next = cursor
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i)
            handleCommand(base, token, c)
            val seq = c.optLong("seq", 0L)
            if (seq > next) next = seq
        }
        val rc = r.optLong("cursor", -1L)
        if (rc > next) next = rc
        if (next != cursor) p.edit().putLong(K_CURSOR, next).apply()
        return arr.length() > 0
    }

    // ---------- исполнение ----------

    private suspend fun handleCommand(base: String, token: String, c: JSONObject) {
        val id = c.optString("commandId")
        val kind = c.optString("kind")
        val payload = c.optJSONObject("payload") ?: JSONObject()
        val t0 = SystemClock.elapsedRealtime()
        var result = JSONObject()
        var error: String? = null
        try {
            result = execute(kind, payload)
        } catch (f: CmdFail) {
            error = f.code
            Log.w(TAG, "command $kind: ${f.code}")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = "internal"
            Log.w(TAG, "command $kind failed", e)
        }
        val ok = error == null
        val ms = SystemClock.elapsedRealtime() - t0
        // В reply — только канонические коды; внутренняя причина осталась в logcat выше.
        val code = error?.let { canonical(it) }

        val reply = JSONObject().put("commandId", id)
        if (ok) reply.put("ok", true).put("result", result)
        else reply.put("ok", false).put("error", code)
        runCatching { DeviceApi.call(base, token, "/fed/v1/device/reply", "POST", reply.toString(), 15000) }
            .onFailure { Log.w(TAG, "reply: ${it.message}") }

        Audit.add(this, kind, ok, code, ms)

        if (kind == "stop") {
            devicePrefs(this).edit().putBoolean(K_STOPPED, true).apply()
            stopSelf()
        } else {
            refreshNotification()
        }
    }

    /**
     * Коды из ТЗ: no-permission, needs-confirmation, full-unavailable, unsupported-surface,
     * timeout и not-found (элемент не нашёлся — это не «защищённый экран», врать не надо).
     */
    private fun canonical(code: String): String = when (code) {
        "no-permission", "needs-confirmation", "full-unavailable", "unsupported-surface", "timeout", "not-found" -> code
        "mode-sandbox", "assist-off" -> "no-permission"
        "denied-policy", "denied", "denied-timeout", "confirm-unavailable" -> "needs-confirmation"
        else -> "unsupported-surface"
    }

    private suspend fun execute(kind: String, payload: JSONObject): JSONObject {
        if (kind == "stop") return JSONObject().put("stopped", true)

        val mode = DeviceMode.effective(this)
        if (mode == DeviceMode.SANDBOX) throw CmdFail("no-permission")

        // shell — только в full через живой Shizuku.
        if (kind == "shell" && mode != DeviceMode.FULL) throw CmdFail("full-unavailable")

        when (policyFor(kind)) {
            "deny" -> throw CmdFail("needs-confirmation")
            "ask" -> when (askUser(describe(kind, payload))) {
                ConfirmResult.ALLOW -> Unit
                ConfirmResult.DENY -> throw CmdFail("needs-confirmation")
                ConfirmResult.TIMEOUT -> throw CmdFail("needs-confirmation")
                ConfirmResult.UNAVAILABLE -> throw CmdFail("needs-confirmation")
            }
        }

        // Жест или скриншот могут не ответить вовсе — тогда честный timeout, а не вечное «в работе».
        // shell получает свой лимит: у него внутри 60 с и обрезка вывода.
        val bound = if (kind == "shell") 70_000L else 30_000L
        return withTimeoutOrNull(bound) { runTool(kind, payload) } ?: throw CmdFail("timeout")
    }

    private suspend fun runTool(kind: String, payload: JSONObject): JSONObject {
        return when (kind) {
            "screenshot" -> PhoneHands.screenshot(payload.optInt("maxWidth", 720))
            "ui_tree" -> PhoneHands.uiTree(payload.optInt("maxNodes", 200))
            "tap" -> {
                val hasX = payload.has("x") && !payload.isNull("x")
                val hasY = payload.has("y") && !payload.isNull("y")
                val text = payload.optString("text")
                when {
                    hasX && hasY -> PhoneHands.tap(payload.optInt("x"), payload.optInt("y"))
                    text.isNotBlank() -> PhoneHands.tapByText(text)
                    else -> throw CmdFail("bad-request")
                }
            }
            "swipe" -> PhoneHands.swipe(
                payload.optInt("x1"), payload.optInt("y1"),
                payload.optInt("x2"), payload.optInt("y2"),
                payload.optInt("ms", 300)
            )
            "text" -> PhoneHands.setText(payload.optString("text"))
            "key" -> PhoneHands.key(payload.optString("key"))
            "launch" -> PhoneHands.launch(payload.optString("pkg"))
            "shell" -> ShizukuBridge.shell(payload.optString("cmd"))
            else -> throw CmdFail("unknown-command")
        }
    }

    private fun policyFor(kind: String): String = when (kind) {
        "shell" -> devicePrefs(this).getString(K_POLICY_SHELL, "ask") ?: "ask"
        "launch" -> devicePrefs(this).getString(K_POLICY_LAUNCH, "auto") ?: "auto"
        else -> "auto"
    }

    private enum class ConfirmResult { ALLOW, DENY, TIMEOUT, UNAVAILABLE }

    private fun describe(kind: String, payload: JSONObject): String = when (kind) {
        "screenshot" -> "снять экран телефона"
        "ui_tree" -> "прочитать дерево экрана"
        "tap" -> payload.optString("text").takeIf { it.isNotBlank() }
            ?.let { "тапнуть по «$it»" }
            ?: "тапнуть в точке ${payload.optInt("x")}, ${payload.optInt("y")}"
        "swipe" -> "свайпнуть по экрану"
        "text" -> "ввести текст «${payload.optString("text").take(80)}»"
        "key" -> "нажать клавишу ${payload.optString("key")}"
        "launch" -> "открыть приложение ${payload.optString("pkg")}"
        "shell" -> "выполнить shell-команду «${payload.optString("cmd").take(100)}»"
        else -> "выполнить $kind"
    }

    private suspend fun askUser(desc: String): ConfirmResult {
        val (reqId, deferred: CompletableDeferred<String>) = ConfirmBus.open(desc)
        val started = runCatching {
            startActivity(Intent(this, ConfirmActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        }.getOrElse {
            Log.w(TAG, "confirm: ${it.message}")
            false
        }
        if (!started) {
            ConfirmBus.answer(reqId, "deny")
            return ConfirmResult.UNAVAILABLE
        }
        val verdict = withTimeoutOrNull(70_000) { deferred.await() }
        return when (verdict) {
            "allow" -> ConfirmResult.ALLOW
            "timeout" -> ConfirmResult.TIMEOUT
            null -> {
                ConfirmBus.answer(reqId, "timeout")
                ConfirmResult.TIMEOUT
            }
            else -> ConfirmResult.DENY
        }
    }
}

/** Кнопка «Стоп» в уведомлении. */
class DeviceStopReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != DeviceService.ACTION_STOP) return
        DeviceService.stopDevice(context, "уведомление")
    }
}
