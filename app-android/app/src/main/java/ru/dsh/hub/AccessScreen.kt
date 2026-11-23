package ru.dsh.hub

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Экран «Доступ»: режим, службы, политики и журнал. Всё, что здесь меняется, живёт в prefs
 * `dsh_device` и подхватывается службой без перезапуска приложения.
 */
@Composable
internal fun AccessScreen(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = devicePrefs(ctx)

    var mode by remember { mutableStateOf(DeviceMode.selected(ctx)) }
    var policyShell by remember { mutableStateOf(prefs.getString(K_POLICY_SHELL, "ask") ?: "ask") }
    var policyLaunch by remember { mutableStateOf(prefs.getString(K_POLICY_LAUNCH, "auto") ?: "auto") }
    var assistOn by remember { mutableStateOf(PhoneHands.isReady()) }
    var shizuku by remember { mutableStateOf(ShizukuBridge.state(ctx)) }
    var serviceOn by remember { mutableStateOf(DeviceService.running) }
    var deviceId by remember { mutableStateOf(prefs.getString(K_DEVICE_ID, "") ?: "") }
    var audit by remember { mutableStateOf(Audit.list(ctx)) }

    // Результат «Разрешить Shizuku» приходит слушателем, состояние подхватывает тикер ниже.
    DisposableEffect(Unit) {
        ShizukuBridge.registerListener()
        onDispose { ShizukuBridge.unregisterListener() }
    }

    LaunchedEffect(Unit) {
        while (true) {
            assistOn = PhoneHands.isReady()
            shizuku = ShizukuBridge.state(ctx)
            serviceOn = DeviceService.running
            deviceId = prefs.getString(K_DEVICE_ID, "") ?: ""
            audit = Audit.list(ctx)
            delay(1500)
        }
    }

    var notificationsOk by remember {
        mutableStateOf(
            Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        )
    }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notificationsOk = granted
        DeviceService.startDevice(ctx)
    }

    fun startService() {
        val needPerm = Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (needPerm) permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        else DeviceService.startDevice(ctx)
    }

    val shizukuReady = shizuku == ShizukuBridge.State.READY
    val effective = DeviceMode.effective(mode, assistOn, shizukuReady)

    Column(Modifier.fillMaxSize()) {
        PaneHeader("ДОСТУП", onBack = onClose) {
            StatusPill(
                if (serviceOn) "устройство на связи" else "устройство стоит",
                if (serviceOn) Mint else Color(0xFF6E7E99)
            )
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                Modifier.fillMaxSize().widthIn(max = 640.dp),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item {
                    SectionCard(
                        "Режим",
                        "Выбираете вы. Фактический режим — минимум из выбранного и доступного на телефоне."
                    ) {
                        Segmented(
                            listOf(
                                DeviceMode.SANDBOX to "sandbox",
                                DeviceMode.ASSIST to "assist",
                                DeviceMode.FULL to "full"
                            ),
                            mode,
                            enabled = buildSet {
                                add(DeviceMode.SANDBOX)
                                add(DeviceMode.ASSIST)
                                if (shizukuReady) add(DeviceMode.FULL)
                            }
                        ) { picked ->
                            mode = picked
                            prefs.edit().putString(K_MODE, picked).apply()
                        }
                        Spacer(Modifier.height(12.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusPill("сейчас: $effective", if (effective == DeviceMode.SANDBOX) Color(0xFF6E7E99) else Mint)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "выбрано: $mode",
                                fontSize = 10.5.sp,
                                color = Color(0xFF64738C)
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(modeExplain(effective), fontSize = 12.sp, color = InkDim, lineHeight = 17.sp)
                        modeWarning(mode, assistOn, shizukuReady)?.let {
                            Spacer(Modifier.height(10.dp))
                            WarnLine(it)
                        }
                    }
                }

                item {
                    SectionCard("Служба доступности", "Дерево экрана, скриншот, жесты, ввод и запуск приложений.") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusPill(if (assistOn) "включена" else "выключена", if (assistOn) Mint else Rose)
                            Spacer(Modifier.weight(1f))
                            PillButton(if (assistOn) "Настройки" else "Включить службу доступности", accent = true) {
                                runCatching {
                                    ctx.startActivity(
                                        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(
                            if (assistOn) "Найдена в системе: ru.dsh.hub / DshAccessibilityService."
                            else "Включите «DSH Federation» в списке служб: Настройки → Специальные возможности → Установленные приложения.",
                            fontSize = 11.5.sp, color = InkDim, lineHeight = 16.sp
                        )
                    }
                }

                item {
                    SectionCard("Shizuku", "Режим full: shell-команды (input, pm, am, dumpsys) через сервис Shizuku.") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusPill(
                                when (shizuku) {
                                    ShizukuBridge.State.READY -> "готово"
                                    ShizukuBridge.State.NO_PERMISSION -> "нет разрешения"
                                    ShizukuBridge.State.NOT_RUNNING -> "сервис не запущен"
                                    ShizukuBridge.State.NOT_INSTALLED -> "не установлен"
                                },
                                when (shizuku) {
                                    ShizukuBridge.State.READY -> Mint
                                    ShizukuBridge.State.NOT_INSTALLED -> Rose
                                    else -> Amber
                                }
                            )
                            Spacer(Modifier.weight(1f))
                            if (shizuku == ShizukuBridge.State.NO_PERMISSION) {
                                PillButton("Разрешить Shizuku", accent = true) { ShizukuBridge.requestPermission() }
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(shizukuHint(shizuku), fontSize = 11.5.sp, color = InkDim, lineHeight = 16.sp)
                        if (!shizukuReady) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "Запуск сервиса: в приложении Shizuku «Просмотр команды» → выполните показанную команду по adb. " +
                                    "На 13.6 это `adb shell …/lib/libshizuku.so`; на старых версиях — `adb shell sh …/start.sh`.",
                                fontSize = 10.5.sp, color = Color(0xFF8FA6C8), lineHeight = 15.sp
                            )
                        }
                    }
                }

                item {
                    SectionCard("Служба устройства", "Постоянное уведомление и связь с хабом — пока не нажмёте «Стоп».") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    if (serviceOn) "Идёт: hello раз в 30 с, long-poll команд"
                                    else "Стоит: хаб не может прислать команду",
                                    fontSize = 12.5.sp, color = Ink, fontWeight = FontWeight.Medium
                                )
                                Spacer(Modifier.height(3.dp))
                                Text(
                                    if (deviceId.isBlank()) "устройство ещё не регистрировалось на хабе"
                                    else "id на хабе: $deviceId",
                                    fontSize = 10.5.sp, color = Color(0xFF64738C),
                                    maxLines = 1, overflow = TextOverflow.Ellipsis
                                )
                            }
                            Spacer(Modifier.width(12.dp))
                            Switch(
                                checked = serviceOn,
                                onCheckedChange = { on ->
                                    if (on) startService() else DeviceService.stopDevice(ctx, "переключатель")
                                },
                                colors = SwitchDefaults.colors(
                                    checkedThumbColor = Color.White,
                                    checkedTrackColor = Accent,
                                    uncheckedThumbColor = Color(0xFF7A8AA5),
                                    uncheckedTrackColor = CardHi,
                                    uncheckedBorderColor = Edge
                                )
                            )
                        }
                        if (!notificationsOk) {
                            Spacer(Modifier.height(10.dp))
                            WarnLine("Уведомления для приложения выключены: на Android 13+ служба без уведомления менее живуча. Разрешение спросим при включении.")
                        }
                    }
                }

                item {
                    SectionCard("Политики инструментов", "auto — сразу, ask — спросить на телефоне, deny — отказать.") {
                        PolicyRow("shell · input, pm, am", policyShell) {
                            policyShell = it
                            prefs.edit().putString(K_POLICY_SHELL, it).apply()
                        }
                        Spacer(Modifier.height(12.dp))
                        PolicyRow("launch · открыть приложение", policyLaunch) {
                            policyLaunch = it
                            prefs.edit().putString(K_POLICY_LAUNCH, it).apply()
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "shell на этом телефоне всегда отвечает full-unavailable: Shizuku не подключён. " +
                                "Политика остаётся на будущее, действия она не разрешает.",
                            fontSize = 10.5.sp, color = Color(0xFF64738C), lineHeight = 15.sp
                        )
                    }
                }

                item {
                    SectionCard("Журнал", "Последние действия агента. Хранится на телефоне, всего до 100 записей.") {
                        if (audit.isEmpty()) {
                            Text("Записей пока нет. Сюда попадает каждая команда: вид, результат, ошибка, время.", fontSize = 11.5.sp, color = InkDim)
                        } else {
                            audit.take(12).forEach { e -> AuditRow(e) }
                            if (audit.size > 12) {
                                Spacer(Modifier.height(6.dp))
                                Text("и ещё ${audit.size - 12} в памяти телефона", fontSize = 10.5.sp, color = Color(0xFF64738C))
                            }
                        }
                    }
                }

                item {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(18.dp))
                            .background(
                                Brush.horizontalGradient(
                                    listOf(Rose.copy(alpha = 0.22f), Color(0xFF2A1218))
                                )
                            )
                            .border(1.dp, Rose.copy(alpha = 0.55f), RoundedCornerShape(18.dp))
                            .clickable {
                                DeviceService.stopDevice(ctx, "кнопка СТОП")
                            }
                            .padding(vertical = 17.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            "СТОП · выключить доступ",
                            fontSize = 15.sp, color = Rose, fontWeight = FontWeight.Bold, letterSpacing = 0.4.sp
                        )
                    }
                }

                item {
                    Text(
                        "Агент не получает прав устройства: он присылает запрос, приложение проверяет режим и политику " +
                            "и только потом действует. Каждое действие видно здесь и на хабе.",
                        fontSize = 10.5.sp, color = Color(0xFF5C6A82), lineHeight = 15.sp,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionCard(
    title: String,
    subtitle: String? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(Card)
            .border(1.dp, Edge, RoundedCornerShape(18.dp))
            .padding(14.dp)
    ) {
        Text(
            title.uppercase(Locale.ROOT),
            fontSize = 10.5.sp, letterSpacing = 0.9.sp, color = InkDim, fontWeight = FontWeight.SemiBold
        )
        if (subtitle != null) {
            Spacer(Modifier.height(6.dp))
            Text(subtitle, fontSize = 11.5.sp, color = Color(0xFF64738C), lineHeight = 16.sp)
        }
        Spacer(Modifier.height(12.dp))
        content()
    }
}

@Composable
private fun Segmented(
    options: List<Pair<String, String>>,
    selected: String,
    enabled: Set<String> = options.map { it.first }.toSet(),
    onSelect: (String) -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(13.dp))
            .background(BgSoft)
            .border(1.dp, Edge, RoundedCornerShape(13.dp))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        options.forEach { (id, label) ->
            val on = id == selected
            val allowed = id in enabled
            Box(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .then(
                        if (on) Modifier.background(Brush.horizontalGradient(listOf(Accent, Accent2)))
                        else Modifier
                    )
                    .clickable(enabled = allowed) { onSelect(id) }
                    .padding(vertical = 9.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    label,
                    fontSize = 12.5.sp,
                    color = when {
                        on -> Color.White
                        !allowed -> Color(0xFF4E5A70)
                        else -> InkDim
                    },
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal
                )
            }
        }
    }
}

@Composable
private fun PolicyRow(title: String, value: String, onChange: (String) -> Unit) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), fontSize = 12.5.sp, color = Ink)
            Text(policyLabel(value), fontSize = 10.5.sp, color = if (value == "deny") Rose else InkDim)
        }
        Spacer(Modifier.height(7.dp))
        Segmented(
            listOf("auto" to "auto", "ask" to "ask", "deny" to "deny"),
            value,
            onSelect = onChange
        )
    }
}

private fun policyLabel(v: String): String = when (v) {
    "auto" -> "можно сразу"
    "ask" -> "спросить на телефоне"
    "deny" -> "запрещено"
    else -> v
}

@Composable
private fun WarnLine(text: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Amber.copy(alpha = 0.10f))
            .border(1.dp, Amber.copy(alpha = 0.35f), RoundedCornerShape(12.dp))
            .padding(horizontal = 11.dp, vertical = 9.dp),
        verticalAlignment = Alignment.Top
    ) {
        Box(Modifier.padding(top = 5.dp).size(6.dp).clip(CircleShape).background(Amber))
        Spacer(Modifier.width(9.dp))
        Text(text, fontSize = 11.sp, color = Color(0xFFFFE8A8), lineHeight = 16.sp)
    }
}

@Composable
private fun AuditRow(e: org.json.JSONObject) {
    val ok = e.optBoolean("ok", false)
    val kind = e.optString("kind")
    val err = if (e.isNull("error")) "" else e.optString("error")
    val ms = e.optLong("ms", 0L)
    val ts = e.optLong("ts", 0L)
    val time = runCatching {
        SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(Date(ts))
    }.getOrElse { "" }
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(time, fontSize = 10.5.sp, color = Color(0xFF5C6A82))
        Spacer(Modifier.width(10.dp))
        Text(kind, Modifier.weight(1f), fontSize = 11.5.sp, color = Ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (err.isNotBlank()) {
            Spacer(Modifier.width(6.dp))
            Text(err, fontSize = 10.sp, color = Rose, maxLines = 1)
        }
        Spacer(Modifier.width(8.dp))
        Text(if (ok) "ok" else "отказ", fontSize = 10.sp, color = if (ok) Mint else Rose)
        Spacer(Modifier.width(8.dp))
        Text("$ms мс", fontSize = 10.sp, color = Color(0xFF5C6A82))
    }
}

private fun modeExplain(effective: String): String = when (effective) {
    DeviceMode.ASSIST ->
        "Можно: дерево экрана, скриншот, тап и свайп, ввод текста, клавиши, запуск приложений. " +
            "Действия по политике, опасное спрашивает разрешение на телефоне."
    DeviceMode.FULL ->
        "Можно всё из assist плюс shell: input, pm, am, dumpsys, буфер обмена."
    else ->
        "Можно: узлы, сессии, промпты — своё. Экран телефона агент не видит: скриншот и тап отвечают no-permission."
}

private fun modeWarning(selected: String, assistReady: Boolean, shizukuReady: Boolean): String? = when {
    selected == DeviceMode.FULL && !shizukuReady ->
        "Shizuku не готов, поэтому full честно деградирует в assist: capabilities.full=false, " +
            "команда shell отвечает full-unavailable."
    selected == DeviceMode.ASSIST && !assistReady ->
        "Служба доступности выключена — фактически работает sandbox, руки отключены."
    else -> null
}

private fun shizukuHint(state: ShizukuBridge.State): String = when (state) {
    ShizukuBridge.State.READY ->
        "Сервис жив, разрешение выдано: режим full доступен, shell пойдёт через Shizuku."
    ShizukuBridge.State.NO_PERMISSION ->
        "Сервис работает — выдайте DSH Federation разрешение кнопкой справа."
    ShizukuBridge.State.NOT_RUNNING ->
        "Shizuku установлен, но сервис не запущен. Запустите его по adb (команда ниже) или из приложения Shizuku."
    ShizukuBridge.State.NOT_INSTALLED ->
        "Shizuku не установлен. Без него режим full недоступен, работает assist."
}
