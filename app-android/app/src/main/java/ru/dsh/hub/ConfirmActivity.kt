package ru.dsh.hub

import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay

/**
 * Мостик между службой устройства и прозрачной активностью подтверждения.
 * Каждому запросу — свой id: просроченный ответ не может закрыть чужой запрос.
 */
object ConfirmBus {
    @Volatile
    private var pending: CompletableDeferred<String>? = null

    @Volatile
    var description: String = ""
        private set

    @Volatile
    var requestId: String = ""
        private set

    fun open(desc: String): Pair<String, CompletableDeferred<String>> {
        pending?.complete("deny")
        val id = "c" + System.nanoTime().toString(36)
        val d = CompletableDeferred<String>()
        description = desc
        requestId = id
        pending = d
        return id to d
    }

    fun answer(id: String, verdict: String) {
        if (id != requestId) return
        pending?.complete(verdict)
        pending = null
    }
}

/** Диалог «Агент просит: …». Прозрачная активность поверх чужого экрана, 60 с на ответ. */
class ConfirmActivity : ComponentActivity() {
    private var reqId: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = AndroidColor.TRANSPARENT
        window.navigationBarColor = AndroidColor.TRANSPARENT
        reqId = ConfirmBus.requestId
        val desc = ConfirmBus.description
        setContent {
            MaterialTheme(colorScheme = HubScheme) {
                ConfirmScreen(desc, onAnswer = ::answer)
            }
        }
    }

    private fun answer(verdict: String) {
        ConfirmBus.answer(reqId, verdict)
        finish()
    }

    override fun onDestroy() {
        // Смахнули, экран погас, система убила — считаем отказом, но только свой запрос.
        ConfirmBus.answer(reqId, "deny")
        super.onDestroy()
    }
}

@Composable
private fun ConfirmScreen(desc: String, onAnswer: (String) -> Unit) {
    var left by remember { mutableStateOf(60) }
    LaunchedEffect(Unit) {
        while (left > 0) {
            delay(1000)
            left -= 1
        }
        onAnswer("timeout")
    }
    Box(
        Modifier.fillMaxSize().background(Color(0xB3060A12)).padding(20.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            Modifier
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(24.dp))
                .background(Card)
                .border(1.dp, Accent.copy(alpha = 0.45f), RoundedCornerShape(24.dp))
                .padding(20.dp)
        ) {
            Text(
                "АГЕНТ ПРОСИТ",
                fontSize = 10.5.sp,
                letterSpacing = 1.2.sp,
                color = Accent,
                fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.height(10.dp))
            Text(desc, fontSize = 16.sp, color = Ink, lineHeight = 22.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(10.dp))
            Text(
                "Это запрос с хаба федерации. Разрешить один раз и на 60 секунд — решение попадёт в журнал.",
                fontSize = 11.5.sp, color = InkDim, lineHeight = 16.sp
            )
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(14.dp))
                        .background(Brush.horizontalGradient(listOf(Accent, Accent2)))
                        .clickable { onAnswer("allow") }
                        .padding(vertical = 13.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Разрешить", fontSize = 14.sp, color = Color.White, fontWeight = FontWeight.SemiBold)
                }
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(14.dp))
                        .background(CardHi)
                        .border(1.dp, Edge, RoundedCornerShape(14.dp))
                        .clickable { onAnswer("deny") }
                        .padding(vertical = 13.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Отклонить", fontSize = 14.sp, color = InkDim, fontWeight = FontWeight.Medium)
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(
                "Осталось $left с — иначе отказ по таймауту",
                fontSize = 10.5.sp, color = Color(0xFF64738C), textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
