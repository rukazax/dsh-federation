package ru.dsh.hub

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Отказ инструмента с машинным кодом. Агент на хабе видит причину, а не «не получилось»:
 * mode-sandbox, denied-policy, denied-timeout, not-found, full-unavailable, assist-off, …
 */
internal class CmdFail(val code: String) : Exception(code)

/**
 * Руки телефона: то, что доступно только через включённую службу доступности.
 * Держит слабую ссылку на сервис, поэтому «служба выключена» — это честный assist-off,
 * а не падение.
 */
object PhoneHands {
    private const val TAG = "DshHands"

    private var ref: WeakReference<DshAccessibilityService>? = null

    fun attach(s: DshAccessibilityService) {
        ref = WeakReference(s)
    }

    fun detach(s: DshAccessibilityService) {
        if (ref?.get() === s) ref = null
    }

    fun isReady(): Boolean = ref?.get() != null

    private fun service(): DshAccessibilityService =
        ref?.get() ?: throw CmdFail("assist-off")

    /** "pkg/Activity", а если прошивка не назвала активность — честно только пакет. */
    fun focusString(): String {
        val s = ref?.get() ?: return ""
        val pkg = s.lastPkg.ifBlank { s.rootInActiveWindow?.packageName?.toString().orEmpty() }
        if (pkg.isBlank()) return ""
        return if (s.lastActivity.isBlank()) pkg else "$pkg/${s.lastActivity}"
    }

    // ---------- скриншот ----------

    /** {format:"jpeg",width,height,data} — JPEG q70, длинная сторона ≤ maxWidth (по умолчанию 720). */
    suspend fun screenshot(maxWidth: Int = 720): JSONObject {
        val svc = service()
        if (Build.VERSION.SDK_INT < 30) throw CmdFail("screenshot-unavailable")
        val raw = svc.grabBitmap()
        val limit = if (maxWidth > 0) maxWidth else 720
        val out = if (raw.width > limit) {
            val h = (raw.height.toLong() * limit / raw.width).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(raw, limit, h, true)
        } else raw
        return try {
            val bytes = ByteArrayOutputStream()
            out.compress(Bitmap.CompressFormat.JPEG, 70, bytes)
            JSONObject()
                .put("format", "jpeg")
                .put("width", out.width)
                .put("height", out.height)
                .put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
        } finally {
            if (out !== raw) out.recycle()
            raw.recycle()
        }
    }

    @android.annotation.TargetApi(30)
    private suspend fun DshAccessibilityService.grabBitmap(): Bitmap = suspendCancellableCoroutine { cont ->
        val executor = ContextCompat.getMainExecutor(this)
        val callback = object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                val hb = screenshot.hardwareBuffer
                try {
                    val hw = Bitmap.wrapHardwareBuffer(hb, screenshot.colorSpace)
                    val soft = hw?.copy(Bitmap.Config.ARGB_8888, false)
                    if (soft == null) {
                        if (cont.isActive) cont.resumeWithException(CmdFail("screenshot-failed"))
                    } else if (cont.isActive) {
                        cont.resume(soft)
                    }
                } catch (e: Exception) {
                    if (cont.isActive) cont.resumeWithException(CmdFail("screenshot-failed"))
                } finally {
                    hb.close()
                }
            }

            override fun onFailure(errorCode: Int) {
                Log.w(TAG, "takeScreenshot failed: $errorCode")
                if (cont.isActive) cont.resumeWithException(CmdFail("screenshot-failed"))
            }
        }
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, executor, callback)
        } catch (e: Exception) {
            if (cont.isActive) cont.resumeWithException(CmdFail("screenshot-unavailable"))
        }
    }

    // ---------- дерево экрана ----------

    /** {nodes:[{text,desc,id,cls,bounds,clickable,pkg}], focus:"pkg/Activity", screen:{w,h}} */
    suspend fun uiTree(maxNodes: Int = 200): JSONObject {
        val svc = service()
        val root = svc.rootInActiveWindow ?: throw CmdFail("no-window")
        val limit = if (maxNodes in 1..2000) maxNodes else 200
        val nodes = JSONArray()
        var count = 0

        fun describe(n: AccessibilityNodeInfo): JSONObject {
            val r = Rect()
            n.getBoundsInScreen(r)
            return JSONObject()
                .put("text", n.text?.toString().orEmpty())
                .put("desc", n.contentDescription?.toString().orEmpty())
                .put("id", n.viewIdResourceName.orEmpty())
                .put("cls", n.className?.toString().orEmpty())
                .put("bounds", JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom))
                .put("clickable", n.isClickable)
                .put("pkg", n.packageName?.toString().orEmpty())
        }

        // Интересные узлы: с текстом, описанием, id или кликабельные. Пустая обёртка без
        // признаков агенту бесполезна и только выжигает лимит узлов.
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || count >= limit || depth > 30) return
            val text = n.text?.toString().orEmpty()
            val desc = n.contentDescription?.toString().orEmpty()
            if (text.isNotBlank() || desc.isNotBlank() || !n.viewIdResourceName.isNullOrBlank() || n.isClickable) {
                nodes.put(describe(n))
                count++
            }
            if (count >= limit) return
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }

        walk(root, 0)
        val dm = svc.resources.displayMetrics
        return JSONObject()
            .put("nodes", nodes)
            .put("focus", focusString())
            .put("screen", JSONObject().put("w", dm.widthPixels).put("h", dm.heightPixels))
    }

    // ---------- жесты ----------

    suspend fun tap(x: Int, y: Int): JSONObject {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        dispatchGesture(path, 60)
        return JSONObject().put("ok", true).put("x", x).put("y", y)
    }

    /** Ищет узел по подстроке в text/contentDescription (без учёта регистра) и тапает его центр. */
    suspend fun tapByText(query: String): JSONObject {
        val svc = service()
        val root = svc.rootInActiveWindow ?: throw CmdFail("no-window")
        val hit = find(root, query) ?: throw CmdFail("not-found")
        val target = clickableAncestor(hit) ?: hit
        val r = Rect()
        target.getBoundsInScreen(r)
        val cx = r.centerX()
        val cy = r.centerY()
        dispatchGesture(Path().apply { moveTo(cx.toFloat(), cy.toFloat()) }, 60)
        return JSONObject().put("ok", true).put("x", cx).put("y", cy)
    }

    suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, ms: Int = 300): JSONObject {
        val dur = ms.coerceIn(50, 3000)
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        dispatchGesture(path, dur.toLong())
        return JSONObject().put("ok", true).put("ms", dur)
    }

    private suspend fun dispatchGesture(path: Path, ms: Long) {
        val svc = service()
        val stroke = GestureDescription.StrokeDescription(path, 0L, ms.coerceIn(1, 60_000))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val ok = suspendCancellableCoroutine { cont ->
            val sent = svc.dispatchGesture(gesture, object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(d: GestureDescription?) {
                    if (cont.isActive) cont.resume(true)
                }

                override fun onCancelled(d: GestureDescription?) {
                    if (cont.isActive) cont.resume(false)
                }
            }, null)
            if (!sent && cont.isActive) cont.resume(false)
        }
        if (!ok) throw CmdFail("gesture-rejected")
    }

    // ---------- ввод и клавиши ----------

    suspend fun setText(text: String): JSONObject {
        val svc = service()
        val focused = svc.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val editable = editableNode(focused) ?: throw CmdFail("no-focus")
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val ok = editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (!ok) throw CmdFail("no-focus")
        return JSONObject().put("ok", true).put("text", text)
    }

    suspend fun key(name: String): JSONObject {
        val svc = service()
        val action = when (name.trim().lowercase()) {
            "back" -> AccessibilityService.GLOBAL_ACTION_BACK
            "home" -> AccessibilityService.GLOBAL_ACTION_HOME
            "recents", "app_switch" -> AccessibilityService.GLOBAL_ACTION_RECENTS
            "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
            "power_dialog" -> AccessibilityService.GLOBAL_ACTION_POWER_DIALOG
            "lock", "lock_screen" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN else -1
            else -> -1
        }
        if (action < 0) throw CmdFail("unsupported-key")
        if (!svc.performGlobalAction(action)) throw CmdFail("gesture-rejected")
        return JSONObject().put("ok", true).put("key", name)
    }

    suspend fun launch(pkg: String): JSONObject {
        val svc = service()
        val intent = svc.packageManager.getLaunchIntentForPackage(pkg) ?: throw CmdFail("not-found")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        svc.startActivity(intent)
        return JSONObject().put("ok", true).put("pkg", pkg)
    }

    suspend fun currentFocus(): JSONObject {
        val svc = service()
        val dm = svc.resources.displayMetrics
        return JSONObject()
            .put("focus", focusString())
            .put("screen", JSONObject().put("w", dm.widthPixels).put("h", dm.heightPixels))
    }

    // ---------- поиск ----------

    private fun find(root: AccessibilityNodeInfo, query: String): AccessibilityNodeInfo? {
        val q = query.trim()
        if (q.isEmpty()) return null
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addLast(root)
        var visited = 0
        while (stack.isNotEmpty() && visited < 4000) {
            val n = stack.removeLast()
            visited++
            val text = n.text?.toString().orEmpty()
            val desc = n.contentDescription?.toString().orEmpty()
            if (text.contains(q, true) || desc.contains(q, true)) return n
            for (i in n.childCount - 1 downTo 0) n.getChild(i)?.let { stack.addLast(it) }
        }
        return null
    }

    private fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var n: AccessibilityNodeInfo? = node
        var hops = 0
        while (n != null && hops < 12) {
            if (n.isClickable) return n
            n = n.parent
            hops++
        }
        return null
    }

    private fun editableNode(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var n = node
        var hops = 0
        while (n != null && hops < 12) {
            if (n.isEditable) return n
            n = n.parent
            hops++
        }
        return null
    }
}

/**
 * Служба доступности DSH. Всё, что она умеет, вызывается из PhoneHands по запросу агента —
 * сама она ничего не делает и никаких событий не читает, кроме имени активного окна.
 */
class DshAccessibilityService : AccessibilityService() {
    @Volatile
    var lastPkg: String = ""

    @Volatile
    var lastActivity: String = ""

    override fun onServiceConnected() {
        super.onServiceConnected()
        PhoneHands.attach(this)
        DeviceService.onHandsChanged(this)
        Log.i("DshHands", "accessibility service connected")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        PhoneHands.detach(this)
        DeviceService.onHandsChanged(this)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        PhoneHands.detach(this)
        DeviceService.onHandsChanged(this)
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        event.packageName?.let { lastPkg = it.toString() }
        val cls = event.className?.toString().orEmpty()
        // Часть прошивок (MIUI) в className кладёт корневой view, а не Activity —
        // тогда имя активности не перетираем мусором, оставляем последнее известное.
        if (cls.isNotBlank() && !isFrameworkClass(cls)) lastActivity = cls
    }

    private fun isFrameworkClass(cls: String): Boolean =
        cls.startsWith("android.widget.") || cls.startsWith("android.view.") ||
            cls.startsWith("android.webkit.") || cls.startsWith("android.app.") ||
            cls.startsWith("androidx.") || cls.startsWith("com.android.internal.")

    override fun onInterrupt() {}
}
