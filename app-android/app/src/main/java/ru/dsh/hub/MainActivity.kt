package ru.dsh.hub

import android.app.Application
import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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

const val DEFAULT_BASE = "http://192.168.88.35:18990"
private const val PREFS = "dsh_hub"
private const val KEY_BASE = "base"
private const val KEY_TOKEN = "token"

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
        if (token.isBlank()) { error = "Токен не задан — откройте «Токен» в шапке"; return }
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
        // Удобные extras для установки/проверки: adb shell am start -e token <…>
        val extraToken = intent?.getStringExtra("token")
        val extraBase = intent?.getStringExtra("base") ?: intent?.getStringExtra("url")
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                val vm: HubVm = viewModel()
                LaunchedEffect(Unit) { vm.seed(extraBase, extraToken) }
                App(vm)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun App(vm: HubVm) {
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    var showSettings by rememberSaveable { mutableStateOf(vm.token.isBlank()) }
    // Диалог открывается сам только пока токена нет; после подстановки (или ввода) он закрывается.
    var autoOpened by rememberSaveable { mutableStateOf(vm.token.isBlank()) }
    LaunchedEffect(vm.token) {
        if (autoOpened && vm.token.isNotBlank()) {
            showSettings = false
            autoOpened = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("DSH Hub", fontWeight = FontWeight.Bold)
                        Text(
                            if (vm.selectedSession != null) "переписка" else if (vm.selectedNode != null) "сессии узла" else "узлы федерации",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                actions = {
                    TextButton(onClick = { vm.loadNodes() }) { Text("Обновить") }
                    TextButton(onClick = { showSettings = true }) { Text("Токен") }
                }
            )
        }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            vm.error?.let { text ->
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(text, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { vm.clearError() }) { Text("×") }
                    }
                }
            }
            if (vm.token.isBlank()) {
                Text(
                    "Токен хаба не задан. Нажмите «Токен» в шапке и вставьте его.",
                    Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error
                )
            }
            Box(Modifier.weight(1f)) {
                if (wide) WideLayout(vm) else CompactLayout(vm)
            }
            if (vm.status.isNotBlank()) {
                Text(
                    vm.status,
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2, overflow = TextOverflow.Ellipsis
                )
            }
        }
    }

    if (showSettings) SettingsDialog(vm, onClose = { showSettings = false })
}

@Composable
private fun CompactLayout(vm: HubVm) {
    when {
        vm.selectedSession != null -> ChatPane(vm, Modifier.fillMaxSize())
        vm.selectedNode != null -> SessionsPane(vm, Modifier.fillMaxSize())
        else -> NodesPane(vm, Modifier.fillMaxSize())
    }
}

@Composable
private fun WideLayout(vm: HubVm) {
    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(0.42f).fillMaxHeight()) {
            if (vm.selectedNode == null) {
                NodesPane(vm, Modifier.fillMaxSize())
            } else {
                NodesPane(vm, Modifier.weight(0.5f))
                HorizontalDivider()
                SessionsPane(vm, Modifier.weight(0.5f))
            }
        }
        VerticalDivider()
        Box(Modifier.weight(0.58f).fillMaxHeight()) {
            if (vm.selectedSession != null) ChatPane(vm, Modifier.fillMaxSize())
            else EmptyHint("Узлы и сессии слева — выберите сессию, чтобы читать переписку.", Modifier.align(Alignment.Center))
        }
    }
}

@Composable
private fun PaneHeader(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {}
) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (onBack != null) TextButton(onClick = onBack) { Text("← Назад") }
        Text(title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        actions()
    }
}

@Composable
private fun NodesPane(vm: HubVm, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        PaneHeader(if (vm.selectedNode == null) "Узлы" else "Узлы (${vm.nodes.size})")
        if (vm.nodes.isEmpty()) {
            EmptyHint(if (vm.token.isBlank()) "Сначала задайте токен." else "Узлов нет — нажмите «Обновить».", Modifier.padding(16.dp))
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(vm.nodes, key = { it.id }) { n ->
                    val selected = vm.selectedNode?.id == n.id
                    Card(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
                            .clickable { vm.selectNode(n) },
                        colors = CardDefaults.cardColors(
                            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
                        )
                    ) {
                        Column(Modifier.padding(10.dp)) {
                            Text(n.name, fontWeight = FontWeight.SemiBold)
                            Text(n.id, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(n.os, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("в сети: ${shortTime(n.lastSeen)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionsPane(vm: HubVm, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        PaneHeader(
            vm.selectedNode?.name?.let { "Сессии: $it" } ?: "Сессии",
            onBack = if (vm.selectedNode != null) ({ vm.closeNode() }) else null,
            actions = {
                TextButton(onClick = { vm.loadSessions() }) { Text("Обновить") }
                TextButton(onClick = { vm.createSession() }) { Text("＋ Новая") }
            }
        )
        if (vm.sessions.isEmpty()) {
            EmptyHint("Сессий нет. «＋ Новая» создаст сессию на узле.", Modifier.padding(16.dp))
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(vm.sessions, key = { it.id }) { s ->
                    val selected = vm.selectedSession?.id == s.id
                    Card(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).clickable { vm.selectSession(s) },
                        colors = CardDefaults.cardColors(
                            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
                        )
                    ) {
                        Column(Modifier.padding(10.dp)) {
                            Text(s.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                "${s.status} · ${shortTime(s.updatedAt)}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
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
        PaneHeader(
            s.title,
            onBack = { vm.closeSession() },
            actions = { OutlinedButton(onClick = { vm.cancelPrompt() }) { Text("Стоп") } }
        )
        if (vm.messages.isEmpty()) {
            EmptyHint("Сообщений в снапшоте нет — можно отправить промпт.", Modifier.padding(16.dp))
        } else {
            LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp), state = listState) {
                items(vm.messages.size) { i ->
                    val m = vm.messages[i]
                    MsgBubble(m)
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = vm.draft,
                onValueChange = { vm.draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Промпт узлу…") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { vm.sendPrompt() })
            )
            Button(onClick = { vm.sendPrompt() }, enabled = vm.draft.isNotBlank()) { Text("→") }
        }
    }
}

@Composable
private fun MsgBubble(m: HubMsg) {
    val mine = m.role == "user"
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start
    ) {
        Surface(
            shape = RoundedCornerShape(10.dp),
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth(0.88f)
        ) {
            Column(Modifier.padding(8.dp)) {
                Text(
                    if (mine) "Вы" else m.role,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(m.text, style = MaterialTheme.typography.bodyMedium)
                if (m.at.isNotBlank()) {
                    Text(shortTime(m.at), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun EmptyHint(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun SettingsDialog(vm: HubVm, onClose: () -> Unit) {
    // Поля берут актуальные значения при каждом открытии диалога (ключи rememberSaveable).
    var base by rememberSaveable(vm.baseUrl, vm.token) { mutableStateOf(vm.baseUrl) }
    var tok by rememberSaveable(vm.baseUrl, vm.token) { mutableStateOf(vm.token) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Хаб и токен") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(base, { base = it }, label = { Text("Адрес хаба") }, singleLine = true)
                OutlinedTextField(tok, { tok = it }, label = { Text("Токен хаба") }, singleLine = true)
                Text("Хранится в настройках приложения (SharedPreferences), не в коде.", style = MaterialTheme.typography.labelSmall)
            }
        },
        confirmButton = { TextButton(onClick = { vm.saveSettings(base, tok); onClose() }) { Text("Сохранить") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Отмена") } }
    )
}

private fun shortTime(iso: String): String = iso.replace('T', ' ').removeSuffix("Z").take(16)
