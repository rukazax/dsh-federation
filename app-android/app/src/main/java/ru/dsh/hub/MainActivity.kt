package ru.dsh.hub

import android.app.Application
import android.content.Context
import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

const val DEFAULT_BASE = "http://192.168.88.35:18990"
private const val PREFS = "dsh_hub"
private const val KEY_BASE = "base"
private const val KEY_TOKEN = "token"

// ---------- палитра ----------

internal val Bg = Color(0xFF070A11)
internal val BgSoft = Color(0xFF0C1120)
internal val Card = Color(0xFF121A2A)
internal val CardHi = Color(0xFF182234)
internal val Edge = Color(0xFF23304A)
internal val Ink = Color(0xFFECF2FD)
internal val InkDim = Color(0xFF93A3BC)
internal val Accent = Color(0xFF5B8CFF)
internal val Accent2 = Color(0xFFA06BFF)
internal val Mint = Color(0xFF3DDC97)
internal val Amber = Color(0xFFFFC93C)
internal val Rose = Color(0xFFFF6B7A)

internal val HubScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF1E2E4C),
    onPrimaryContainer = Ink,
    secondary = Accent2,
    background = Bg,
    onBackground = Ink,
    surface = BgSoft,
    onSurface = Ink,
    surfaceVariant = Card,
    onSurfaceVariant = InkDim,
    error = Rose,
    errorContainer = Color(0xFF3A1720),
    onErrorContainer = Color(0xFFFFD6DC),
    outline = Edge,
)

// ---------- данные ----------

data class HubNode(val id: String, val name: String, val os: String, val lastSeen: String)
data class HubSession(val id: String, val node: String, val title: String, val status: String, val updatedAt: String)
data class HubMsg(val role: String, val text: String, val at: String)

// JSON null не должен попадать в интерфейс строкой "null".
private fun s(o: JSONObject, key: String, fallback: String = ""): String {
    if (o.isNull(key)) return fallback
    val v = o.optString(key, fallback)
    return if (v.isBlank()) fallback else v
}

// ---------- HTTP ----------

object HubApi {
    fun request(base: String, token: String, path: String, method: String = "GET", body: String? = null): JSONObject {
        val conn = (URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15000
            readTimeout = 90000
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
            if (code !in 200..299) throw IllegalStateException("HTTP $code: ${text.take(300)}")
            return runCatching { JSONObject(text.ifBlank { "{}" }) }.getOrElse { JSONObject() }
        } finally {
            conn.disconnect()
        }
    }
}

// ---------- состояние ----------

class HubVm(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var baseUrl by mutableStateOf(prefs.getString(KEY_BASE, DEFAULT_BASE) ?: DEFAULT_BASE)
        private set
    var token by mutableStateOf(prefs.getString(KEY_TOKEN, "") ?: "")
        private set

    var nodes by mutableStateOf<List<HubNode>>(emptyList()); private set
    var sessions by mutableStateOf<List<HubSession>>(emptyList()); private set
    var selectedNode by mutableStateOf<HubNode?>(null); private set
    var selectedSession by mutableStateOf<HubSession?>(null); private set
    var messages by mutableStateOf<List<HubMsg>>(emptyList()); private set
    var draft by mutableStateOf("")
    var busy by mutableStateOf(false); private set
    var status by mutableStateOf(""); private set
    var error by mutableStateOf<String?>(null); private set

    init {
        if (token.isNotBlank()) loadNodes()
    }

    fun clearError() { error = null }

    fun seed(base: String?, tok: String?) {
        if (base.isNullOrBlank() && tok.isNullOrBlank()) return
        val b = base?.takeIf { it.isNotBlank() } ?: baseUrl
        val t = tok?.takeIf { it.isNotBlank() } ?: token
        if (b == baseUrl && t == token) return
        baseUrl = b
        token = t
        prefs.edit().putString(KEY_BASE, b).putString(KEY_TOKEN, t).apply()
        if (t.isNotBlank()) loadNodes()
    }

    fun saveSettings(base: String, newToken: String) {
        baseUrl = base.trim().ifBlank { DEFAULT_BASE }
        token = newToken.trim()
        prefs.edit().putString(KEY_BASE, baseUrl).putString(KEY_TOKEN, token).apply()
        error = null
        loadNodes()
    }

    private fun task(note: String, ok: (String) -> String = { it }, block: suspend () -> String) {
        if (token.isBlank()) { error = "Токен не задан — откройте настройки в шапке"; return }
        viewModelScope.launch {
            busy = true
            error = null
            status = note
            runCatching {
                val msg = withContext(Dispatchers.IO) { block() }
                status = ok(msg)
            }.onFailure {
                error = it.message ?: it.toString()
                status = "Ошибка"
            }
            busy = false
        }
    }

    fun loadNodes() = task("Загружаю узлы…") {
        val arr = HubApi.request(baseUrl, token, "/api/federation/nodes").optJSONArray("nodes") ?: JSONArray()
        nodes = (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            HubNode(s(o, "id"), s(o, "name", "(без имени)"), s(o, "os"), s(o, "last_seen"))
        }
        "Узлов: ${nodes.size}"
    }

    fun selectNode(n: HubNode) {
        selectedNode = n
        selectedSession = null
        messages = emptyList()
        sessions = emptyList()
        loadSessions(n.id)
    }

    fun closeNode() {
        selectedNode = null
        selectedSession = null
        sessions = emptyList()
        messages = emptyList()
    }

    fun loadSessions(nodeId: String? = null) {
        val id = nodeId ?: selectedNode?.id ?: return
        task("Загружаю сессии…") {
            val arr = HubApi.request(baseUrl, token, "/api/federation/sessions?node=$id").optJSONArray("sessions") ?: JSONArray()
            sessions = (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                HubSession(
                    s(o, "id"), s(o, "node"),
                    s(o, "title", "(без названия)"), s(o, "status", "?"), s(o, "updated_at")
                )
            }
            "Сессий: ${sessions.size}"
        }
    }

    fun selectSession(s: HubSession) {
        selectedSession = s
        messages = emptyList()
        loadMessages(s, "Открываю переписку…")
        // снапшот у хаба обновляется от узла не мгновенно — дочитываем пару раз
        viewModelScope.launch {
            repeat(3) {
                delay(2500)
                runCatching {
                    val arr = withContext(Dispatchers.IO) {
                        HubApi.request(baseUrl, token, "/api/federation/session?id=${s.id}&node=${s.node}")
                            .optJSONArray("messages") ?: JSONArray()
                    }
                    messages = parseMsgs(arr)
                }
            }
        }
    }

    fun closeSession() {
        selectedSession = null
        messages = emptyList()
    }

    private fun parseMsgs(arr: JSONArray): List<HubMsg> = (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        HubMsg(s(o, "role", "?"), s(o, "text"), s(o, "at"))
    }

    fun loadMessages(s: HubSession? = null, note: String = "Читаю переписку…") {
        val sess = s ?: selectedSession ?: return
        task(note) {
            val o = HubApi.request(baseUrl, token, "/api/federation/session?id=${sess.id}&node=${sess.node}")
            messages = parseMsgs(o.optJSONArray("messages") ?: JSONArray())
            "Сообщений: ${messages.size}"
        }
    }

    fun sendPrompt() {
        val s = selectedSession ?: return
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        messages = messages + HubMsg("user", text, "сразу")
        task("Отправляю промпт…") {
            val body = JSONObject()
                .put("node", s.node)
                .put("sessionId", s.id)
                .put("text", text)
                .toString()
            val r = HubApi.request(baseUrl, token, "/api/federation/prompt", "POST", body)
            "Хаб принял промпт: команда ${r.optString("commandId").take(8)}… (${r.optString("state", "queued")})"
        }
        viewModelScope.launch {
            repeat(3) {
                delay(2500)
                runCatching {
                    val arr = withContext(Dispatchers.IO) {
                        HubApi.request(baseUrl, token, "/api/federation/session?id=${s.id}&node=${s.node}")
                            .optJSONArray("messages") ?: JSONArray()
                    }
                    messages = parseMsgs(arr)
                }
            }
        }
    }

    fun cancelPrompt() {
        val s = selectedSession ?: return
        task("Отправляю стоп…") {
            val body = JSONObject().put("node", s.node).put("sessionId", s.id).toString()
            val r = HubApi.request(baseUrl, token, "/api/federation/cancel", "POST", body)
            "Стоп отправлен: команда ${r.optString("commandId").take(8)}…"
        }
    }

    fun createSession() {
        val n = selectedNode ?: return
        task("Создаю сессию на узле…") {
            val body = JSONObject().put("node", n.id).toString()
            val r = HubApi.request(baseUrl, token, "/api/federation/create", "POST", body)
            "Создание принято: команда ${r.optString("commandId").take(8)}…"
        }
        viewModelScope.launch {
            repeat(3) {
                delay(3000)
                if (selectedNode?.id == n.id) runCatching { loadSessions(n.id) }
            }
        }
    }
}

// ---------- активность ----------

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = AndroidColor.TRANSPARENT
        window.navigationBarColor = AndroidColor.TRANSPARENT
        // Удобные extras для установки/проверки: adb shell am start -e token <…>
        val extraToken = intent?.getStringExtra("token")
        val extraBase = intent?.getStringExtra("base") ?: intent?.getStringExtra("url")
        // Явный «Пуск» службы устройства (та же кнопка в приложении, exported=false у службы).
        val startDevice = intent?.getBooleanExtra("startDevice", false) == true ||
            intent?.getStringExtra("device") == "start"
        if (startDevice) DeviceService.startDevice(this)
        val openAccess = intent?.getStringExtra("screen") == "access"
        setContent {
            MaterialTheme(colorScheme = HubScheme) {
                val vm: HubVm = viewModel()
                LaunchedEffect(Unit) { vm.seed(extraBase, extraToken) }
                App(vm, startAccess = openAccess)
            }
        }
    }
}

// ---------- экран ----------

private enum class Screen { NODES, SESSIONS, CHAT }

private fun screenOf(vm: HubVm): Screen = when {
    vm.selectedSession != null -> Screen.CHAT
    vm.selectedNode != null -> Screen.SESSIONS
    else -> Screen.NODES
}

@Composable
fun App(vm: HubVm, startAccess: Boolean = false) {
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    var showAccess by rememberSaveable { mutableStateOf(startAccess) }
    var showSettings by rememberSaveable { mutableStateOf(vm.token.isBlank()) }
    // Диалог открывается сам только пока токена нет; после подстановки (или ввода) он закрывается.
    var autoOpened by rememberSaveable { mutableStateOf(vm.token.isBlank()) }
    LaunchedEffect(vm.token) {
        if (autoOpened && vm.token.isNotBlank()) {
            showSettings = false
            autoOpened = false
        }
    }

    BackHandler(enabled = showAccess) { showAccess = false }

    Scaffold(
        containerColor = Bg,
        topBar = {},
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            HubHeader(
                vm = vm,
                onRefresh = { vm.loadNodes() },
                onSettings = { showSettings = true },
                onAccess = { showAccess = true },
            )
            BusyLine(vm.busy)
            AnimatedVisibility(visible = vm.error != null, enter = fadeIn(), exit = fadeOut()) {
                ErrorBanner(vm.error ?: "", onClose = { vm.clearError() })
            }
            Box(Modifier.weight(1f)) {
                if (showAccess) AccessScreen(onClose = { showAccess = false })
                else if (wide) WideLayout(vm) else CompactLayout(vm)
            }
            StatusLine(vm.status)
        }
    }

    if (showSettings) SettingsDialog(vm, onClose = { showSettings = false })
}

@Composable
private fun HubHeader(vm: HubVm, onRefresh: () -> Unit, onSettings: () -> Unit, onAccess: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color(0xFF14203A), Bg)))
            .statusBarsPadding()
    ) {
        Row(
            // 2 dp снаружи: у строк текста уже есть внутренний leading, визуально это 8 dp воздуха
            Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Logo(28.dp)
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    "DSH Federation",
                    style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)),
                    fontSize = 16.sp,
                    lineHeight = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Ink,
                    letterSpacing = 0.2.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    when (screenOf(vm)) {
                        Screen.NODES -> "хаб · ${shortHost(hubHost(vm.baseUrl))}"
                        Screen.SESSIONS -> "сессии · ${vm.selectedNode?.name ?: "узел"}"
                        Screen.CHAT -> "переписка · ${nodeName(vm, vm.selectedSession?.node)}"
                    },
                    style = TextStyle(platformStyle = PlatformTextStyle(includeFontPadding = false)),
                    fontSize = 10.5.sp,
                    lineHeight = 13.sp,
                    color = InkDim,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.width(4.dp))
            CircleIcon(Icons.Default.Lock, "Доступ", onAccess, size = 30.dp)
            Spacer(Modifier.width(4.dp))
            CircleIcon(Icons.Default.Refresh, "Обновить", onRefresh, size = 30.dp)
            Spacer(Modifier.width(4.dp))
            CircleIcon(Icons.Default.Settings, "Подключение", onSettings, size = 30.dp)
        }
        Box(
            Modifier.fillMaxWidth().height(1.dp)
                .background(Brush.horizontalGradient(listOf(Color.Transparent, Accent.copy(alpha = 0.65f), Accent2.copy(alpha = 0.5f), Color.Transparent)))
        )
    }
}

@Composable
private fun Logo(size: androidx.compose.ui.unit.Dp = 42.dp) {
    Canvas(Modifier.size(size)) {
        val k = this.size.minDimension / 42.dp.toPx()  // ритм глифа едет вместе с размером
        val r = this.size.minDimension / 2f
        drawCircle(Brush.linearGradient(listOf(Accent, Accent2)), radius = r)
        val pts = listOf(
            Offset(this.size.width * 0.50f, this.size.height * 0.30f),
            Offset(this.size.width * 0.29f, this.size.height * 0.70f),
            Offset(this.size.width * 0.71f, this.size.height * 0.70f),
        )
        val ring = Stroke(width = (1.dp.toPx() * k).coerceAtLeast(0.8f))
        val line = (2.2.dp.toPx() * k).coerceAtLeast(1.4f)
        drawLine(Color(0xCC0A1020), pts[0], pts[1], strokeWidth = line, cap = StrokeCap.Round)
        drawLine(Color(0xCC0A1020), pts[1], pts[2], strokeWidth = line, cap = StrokeCap.Round)
        drawLine(Color(0xCC0A1020), pts[2], pts[0], strokeWidth = line, cap = StrokeCap.Round)
        pts.forEach { p -> drawCircle(Color.White, radius = (3.1.dp.toPx() * k).coerceAtLeast(2.2f), center = p) }
        drawCircle(color = Color.White, radius = r - (1.dp.toPx() * k), style = ring)
    }
}

@Composable
private fun CircleIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    size: androidx.compose.ui.unit.Dp = 40.dp
) {
    Box(
        Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0x14FFFFFF))
            .border(1.dp, Edge, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) { Icon(icon, contentDescription = label, tint = Ink, modifier = Modifier.size(size * 0.48f)) }
}

@Composable
private fun MiniIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    accent: Boolean = false,
    size: androidx.compose.ui.unit.Dp = 34.dp,
    onClick: () -> Unit
) {
    Box(
        Modifier
            .size(size)
            .clip(CircleShape)
            .background(if (accent) Accent.copy(alpha = 0.18f) else Color(0x12FFFFFF))
            .border(1.dp, if (accent) Accent.copy(alpha = 0.55f) else Edge, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) { Icon(icon, contentDescription = label, tint = if (accent) Accent else InkDim, modifier = Modifier.size(size * 0.58f)) }
}

@Composable
private fun BusyLine(busy: Boolean) {
    Box(Modifier.fillMaxWidth().height(2.dp)) {
        if (busy) {
            androidx.compose.material3.LinearProgressIndicator(
                Modifier.fillMaxWidth().height(2.dp),
                color = Accent,
                trackColor = Color.Transparent,
            )
        }
    }
}

@Composable
private fun ErrorBanner(text: String, onClose: () -> Unit) {
    Surface(color = Color(0xFF3A1720), modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(Rose))
            Spacer(Modifier.width(10.dp))
            Text(text, Modifier.weight(1f), color = Color(0xFFFFD6DC), fontSize = 12.5.sp)
            Icon(
                Icons.Default.Close, "Скрыть", tint = Color(0xFFFFD6DC),
                modifier = Modifier.size(18.dp).clickable(onClick = onClose)
            )
        }
    }
}

@Composable
private fun StatusLine(status: String) {
    if (status.isBlank()) return
    Text(
        status,
        Modifier.fillMaxWidth().background(BgSoft).padding(horizontal = 16.dp, vertical = 5.dp),
        fontSize = 10.5.sp,
        color = InkDim,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}

@Composable
private fun CompactLayout(vm: HubVm) {
    AnimatedContent(
        targetState = screenOf(vm),
        transitionSpec = {
            val forward = targetState.ordinal > initialState.ordinal
            (slideInHorizontally(tween(220)) { if (forward) it / 6 else -it / 6 } + fadeIn(tween(220)))
                .togetherWith(slideOutHorizontally(tween(160)) { if (forward) -it / 8 else it / 8 } + fadeOut(tween(120)))
        },
        label = "screen"
    ) { screen ->
        when (screen) {
            Screen.NODES -> NodesPane(vm, Modifier.fillMaxSize())
            Screen.SESSIONS -> SessionsPane(vm, Modifier.fillMaxSize())
            Screen.CHAT -> ChatPane(vm, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun WideLayout(vm: HubVm) {
    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(0.42f).fillMaxHeight()) {
            if (vm.selectedNode == null) {
                NodesPane(vm, Modifier.fillMaxSize())
            } else {
                NodesPane(vm, Modifier.weight(0.48f))
                Box(Modifier.fillMaxWidth().height(1.dp).background(Edge))
                SessionsPane(vm, Modifier.weight(0.52f))
            }
        }
        Box(Modifier.width(1.dp).fillMaxHeight().background(Edge))
        Box(Modifier.weight(0.58f).fillMaxHeight()) {
            if (vm.selectedSession != null) ChatPane(vm, Modifier.fillMaxSize())
            else EmptyState("Переписки нет", "Выберите сессию слева, чтобы читать и отвечать.", Modifier.align(Alignment.Center))
        }
    }
}

// ---------- панели ----------

@Composable
internal fun PaneHeader(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {}
) {
    Row(
        Modifier.fillMaxWidth().padding(start = if (onBack != null) 2.dp else 10.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (onBack != null) {
            Box(
                Modifier.size(30.dp).clip(CircleShape).clickable(onClick = onBack),
                contentAlignment = Alignment.Center
            ) { Icon(Icons.Default.ArrowBack, "Назад", tint = InkDim, modifier = Modifier.size(16.dp)) }
        }
        Text(
            title.uppercase(Locale.ROOT), Modifier.weight(1f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
            color = InkDim, maxLines = 1, overflow = TextOverflow.Ellipsis,
            letterSpacing = 0.9.sp
        )
        actions()
    }
}

@Composable
internal fun PillButton(text: String, accent: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(if (accent) Accent.copy(alpha = 0.16f) else Color(0x0FFFFFFF))
            .border(1.dp, if (accent) Accent.copy(alpha = 0.55f) else Edge, RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Text(text, fontSize = 11.5.sp, color = if (accent) Accent else InkDim, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun NodesPane(vm: HubVm, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        PaneHeader("Узлы") {
            StatusPill("${vm.nodes.size}", Color(0xFF7C8CA8))
            Spacer(Modifier.width(6.dp))
            MiniIcon(Icons.Default.Refresh, "Обновить узлы", size = 24.dp) { vm.loadNodes() }
        }
        if (vm.nodes.isEmpty()) {
            EmptyState(
                "Узлов пока нет",
                if (vm.token.isBlank()) "Сначала задайте адрес хаба и токен — кнопка с шестернёй в шапке."
                else "Нажмите «Обновить». Узел появится, когда выйдет на связь с хабом.",
                Modifier.fillMaxSize()
            )
        } else {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(vm.nodes, key = { it.id }) { n ->
                    NodeCard(n, selected = vm.selectedNode?.id == n.id) { vm.selectNode(n) }
                }
            }
        }
    }
}

@Composable
private fun NodeCard(n: HubNode, selected: Boolean, onClick: () -> Unit) {
    val online = isFresh(n.lastSeen)
    val shape = RoundedCornerShape(20.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) CardHi else Card)
            .border(
                1.dp,
                if (selected) Brush.linearGradient(listOf(Accent, Accent2))
                else Brush.linearGradient(listOf(Edge, Edge)),
                shape
            )
            .clickable(onClick = onClick)
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
                Box(
                    Modifier.size(46.dp).clip(CircleShape)
                        .background(Brush.linearGradient(listOf(Accent.copy(alpha = 0.28f), Accent2.copy(alpha = 0.24f)))),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        initials(n.name), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = Ink
                    )
                }
                Box(
                    Modifier.align(Alignment.BottomEnd).size(13.dp).clip(CircleShape).background(Bg),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        Modifier.size(9.dp).clip(CircleShape)
                            .background(if (online) Mint else Color(0xFF5A6A85))
                    )
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(n.name, fontSize = 15.5.sp, fontWeight = FontWeight.SemiBold, color = Ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        n.id, fontSize = 11.sp, color = InkDim, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
                    )
                    Spacer(Modifier.width(6.dp))
                    StatusPill(if (online) "онлайн" else "офлайн", if (online) Mint else Color(0xFF6E7E99))
                }
                Spacer(Modifier.height(5.dp))
                Text(
                    listOf(shortOs(n.os), shortTime(n.lastSeen)).filter { it.isNotBlank() }.joinToString("  ·  "),
                    fontSize = 10.5.sp, color = Color(0xFF6E7E99), maxLines = 1, overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun SessionsPane(vm: HubVm, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        PaneHeader(
            vm.selectedNode?.name ?: "СЕССИИ",
            onBack = if (vm.selectedNode != null) ({ vm.closeNode() }) else null,
        ) {
            MiniIcon(Icons.Default.Add, "Новая сессия", accent = true, size = 24.dp) { vm.createSession() }
            Spacer(Modifier.width(6.dp))
            MiniIcon(Icons.Default.Refresh, "Обновить сессии", size = 24.dp) { vm.loadSessions() }
        }
        if (vm.sessions.isEmpty()) {
            EmptyState(
                "Сессий нет",
                "«＋ Сессия» создаст новую на узле — она появится здесь через пару секунд.",
                Modifier.fillMaxSize()
            )
        } else {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(vm.sessions, key = { it.id }) { sess ->
                    SessionCard(sess, selected = vm.selectedSession?.id == sess.id) { vm.selectSession(sess) }
                }
            }
        }
    }
}

@Composable
private fun SessionCard(sess: HubSession, selected: Boolean, onClick: () -> Unit) {
    val accent = statusColor(sess.status)
    val shape = RoundedCornerShape(16.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(shape)
            .background(if (selected) CardHi else Card)
            .border(1.dp, if (selected) accent.copy(alpha = 0.55f) else Edge, shape)
            .clickable(onClick = onClick)
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(accent))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(
                sess.title, fontSize = 13.5.sp, fontWeight = FontWeight.Medium, color = Ink,
                maxLines = 2, overflow = TextOverflow.Ellipsis
            )
            Spacer(Modifier.height(5.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill(statusLabel(sess.status), accent)
                Spacer(Modifier.width(8.dp))
                Text(shortTime(sess.updatedAt), fontSize = 10.5.sp, color = Color(0xFF6E7E99))
            }
        }
        Icon(
            Icons.Default.ArrowBack, "Открыть", tint = Color(0xFF3D4A63),
            modifier = Modifier.align(Alignment.CenterVertically).padding(end = 12.dp).size(16.dp).rotate(180f)
        )
    }
}

@Composable
private fun ChatPane(vm: HubVm, modifier: Modifier = Modifier) {
    val s = vm.selectedSession ?: return
    val listState = rememberLazyListState()
    LaunchedEffect(vm.messages.size, s.id) {
        if (vm.messages.isNotEmpty()) listState.scrollToItem(vm.messages.size - 1)
    }
    Column(modifier) {
        PaneHeader(s.title, onBack = { vm.closeSession() }) {
            PillButton("Стоп", onClick = { vm.cancelPrompt() })
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (vm.messages.isEmpty()) {
                EmptyState(
                    "Пока пусто",
                    "Отправьте промпт — ответ узла появится в этой переписке.",
                    Modifier.fillMaxSize()
                )
            } else {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(vm.messages.size) { i -> MessageBubble(vm.messages[i]) }
                }
            }
        }
        Composer(vm)
    }
}

@Composable
private fun MessageBubble(m: HubMsg) {
    val mine = m.role == "user"
    val shape = RoundedCornerShape(
        topStart = 18.dp, topEnd = 18.dp,
        bottomStart = if (mine) 18.dp else 5.dp,
        bottomEnd = if (mine) 5.dp else 18.dp,
    )
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start
    ) {
        Column(
            Modifier.fillMaxWidth(0.9f),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start
        ) {
            Text(
                if (mine) "ВЫ" else "DSH",
                fontSize = 9.5.sp,
                color = if (mine) Accent.copy(alpha = 0.85f) else InkDim,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.8.sp,
                modifier = Modifier.padding(start = 6.dp, end = 6.dp, bottom = 3.dp)
            )
            Box(
                Modifier
                    .clip(shape)
                    .then(
                        if (mine) Modifier.background(Brush.linearGradient(listOf(Color(0xFF2B4C8F), Color(0xFF3D3C8F))))
                        else Modifier.background(Card).border(1.dp, Edge, shape)
                    )
                    .padding(horizontal = 13.dp, vertical = 9.dp)
            ) {
                Column {
                    Text(m.text, fontSize = 14.sp, color = if (mine) Color(0xFFF2F6FF) else Ink, lineHeight = 19.sp)
                    if (m.at.isNotBlank()) {
                        Spacer(Modifier.height(3.dp))
                        Text(
                            shortTime(m.at), fontSize = 9.5.sp,
                            color = if (mine) Color(0xFFB9C9EA) else Color(0xFF64738C)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(vm: HubVm) {
    val enabled = vm.draft.isNotBlank()
    Column(
        Modifier
            .fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, BgSoft)))
            .navigationBarsPadding()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 10.dp)
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = Card,
                modifier = Modifier.weight(1f).border(1.dp, Edge, RoundedCornerShape(24.dp))
            ) {
                BasicTextField(
                    value = vm.draft,
                    onValueChange = { vm.draft = it },
                    textStyle = TextStyle(color = Ink, fontSize = 14.5.sp),
                    cursorBrush = SolidColor(Accent),
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { vm.sendPrompt() }),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp),
                    decorationBox = { inner ->
                        if (vm.draft.isEmpty()) {
                            Text("Промпт узлу…", fontSize = 14.5.sp, color = Color(0xFF5E6C84))
                        }
                        inner()
                    }
                )
            }
            Box(
                Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(
                        if (enabled) Brush.linearGradient(listOf(Accent, Accent2))
                        else Brush.linearGradient(listOf(CardHi, CardHi))
                    )
                    .clickable(enabled = enabled, onClick = { vm.sendPrompt() }),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Default.Send, "Отправить",
                    tint = if (enabled) Color.White else Color(0xFF4E5C74),
                    modifier = Modifier.size(20.dp)
                )
            }
        }
    }
}

@Composable
internal fun StatusPill(text: String, color: Color) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.14f))
            .border(1.dp, color.copy(alpha = 0.35f), RoundedCornerShape(50))
            .padding(horizontal = 9.dp, vertical = 3.dp)
    ) {
        Text(text, fontSize = 10.5.sp, color = color, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun EmptyState(title: String, hint: String, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().padding(36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
            Box(
                Modifier.size(64.dp).clip(CircleShape).border(1.dp, Edge, CircleShape)
            )
            Canvas(Modifier.size(64.dp)) {
                val r = size.minDimension / 2f
                val pts = listOf(
                    Offset(size.width * 0.5f, size.height * 0.3f),
                    Offset(size.width * 0.3f, size.height * 0.68f),
                    Offset(size.width * 0.7f, size.height * 0.68f),
                )
                for (i in pts.indices) for (j in i + 1 until pts.size) {
                    drawLine(Accent.copy(alpha = 0.28f), pts[i], pts[j], strokeWidth = 1.5.dp.toPx())
                }
                pts.forEach { drawCircle(Accent.copy(alpha = 0.75f), radius = 2.6.dp.toPx(), center = it) }
                drawCircle(Accent.copy(alpha = 0.10f), radius = r, style = Stroke(width = 1.dp.toPx()))
            }
        }
        Spacer(Modifier.height(16.dp))
        Text(title, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = Ink)
        Spacer(Modifier.height(6.dp))
        Text(hint, fontSize = 12.5.sp, color = InkDim, textAlign = TextAlign.Center, lineHeight = 18.sp)
    }
}

@Composable
private fun SettingsDialog(vm: HubVm, onClose: () -> Unit) {
    // Поля берут актуальные значения при каждом открытии диалога (ключи rememberSaveable).
    var base by rememberSaveable(vm.baseUrl, vm.token) { mutableStateOf(vm.baseUrl) }
    var tok by rememberSaveable(vm.baseUrl, vm.token) { mutableStateOf(vm.token) }
    AlertDialog(
        onDismissRequest = onClose,
        containerColor = Card,
        shape = RoundedCornerShape(24.dp),
        title = { Text("Подключение к хабу", fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Адрес и токен хранятся в настройках приложения, не в коде.", fontSize = 11.5.sp, color = InkDim)
                SettingsField(base, { base = it }, "Адрес хаба")
                SettingsField(tok, { tok = it }, "Токен хаба")
            }
        },
        confirmButton = {
            TextButton(onClick = { vm.saveSettings(base, tok); onClose() }) { Text("Сохранить и подключиться", color = Accent) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Отмена", color = InkDim) } }
    )
}

@Composable
private fun SettingsField(value: String, onChange: (String) -> Unit, label: String) {
    Column {
        Text(label, fontSize = 10.5.sp, color = InkDim, letterSpacing = 0.5.sp)
        Spacer(Modifier.height(4.dp))
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = BgSoft,
            modifier = Modifier.fillMaxWidth().border(1.dp, Edge, RoundedCornerShape(12.dp))
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(color = Ink, fontSize = 13.5.sp),
                cursorBrush = SolidColor(Accent),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 11.dp)
            )
        }
    }
}

// ---------- утилиты ----------

private fun nodeName(vm: HubVm, id: String?): String =
    vm.nodes.firstOrNull { it.id == id }?.name ?: id ?: ""

private fun hubHost(base: String): String =
    base.removePrefix("https://").removePrefix("http://").trimEnd('/')

/** Длинный адрес сжимаем по центру: «…88.35:18990». Полный виден в настройках. */
private fun shortHost(host: String, keep: Int = 18): String =
    if (host.length <= keep + 1) host else "…" + host.takeLast(keep)

private fun shortOs(os: String): String {
    if (os.isBlank()) return ""
    // "linux-6.12.113+deb13-amd64" -> "linux-6.12.113": версия ядра без дистрибутива
    return os.substringBefore('+').substringBefore(" (").take(26)
}

private fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    if (parts.isEmpty()) return "?"
    val first = parts.first().first().uppercaseChar()
    val second = parts.getOrNull(1)?.first()?.uppercaseChar()
    return if (second != null) "$first$second" else first.toString()
}

private fun statusColor(status: String): Color = when (status.lowercase(Locale.ROOT)) {
    "running", "working", "busy", "streaming" -> Accent
    "idle", "ready", "done", "completed" -> Mint
    "error", "failed" -> Rose
    else -> Color(0xFF6E7E99)
}

private fun statusLabel(status: String): String = when (status.lowercase(Locale.ROOT)) {
    "running", "working", "busy", "streaming" -> "работает"
    "idle", "ready" -> "свободна"
    "done", "completed" -> "готова"
    "error", "failed" -> "ошибка"
    "?" -> "?"
    else -> status
}

private fun parseUtc(iso: String): Date? = runCatching {
    val head = iso.replace('T', ' ').take(19)
    SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.parse(head)
}.getOrNull()

/** Узел считается на связи, если хаб видел его меньше двух минут назад. */
private fun isFresh(iso: String): Boolean {
    val d = parseUtc(iso) ?: return false
    return (System.currentTimeMillis() - d.time) < 120_000L
}

private fun shortTime(iso: String): String {
    val d = parseUtc(iso)
    if (d != null) {
        val fmt = SimpleDateFormat("dd.MM HH:mm", Locale.ROOT).apply {
            timeZone = TimeZone.getDefault()
        }
        return fmt.format(d)
    }
    return iso.replace('T', ' ').removeSuffix("Z").take(16)
}
