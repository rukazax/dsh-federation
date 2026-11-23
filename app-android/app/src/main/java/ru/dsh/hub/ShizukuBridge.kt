package ru.dsh.hub

import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelFileDescriptor
import android.util.Log
import moe.shizuku.server.IShizukuService
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * Мост к Shizuku: единственный путь к режиму `full`. Прав устройства агент не получает —
 * каждая shell-команда проходит проверку режима и политики и попадает в журнал.
 */
object ShizukuBridge {
    private const val TAG = "DshShizuku"
    private const val PKG = "moe.shizuku.privileged.api"
    private const val OUTPUT_LIMIT = 64 * 1024
    const val REQUEST_CODE = 4711

    enum class State { NOT_INSTALLED, NOT_RUNNING, NO_PERMISSION, READY }

    @Volatile
    var lastGrant: Boolean? = null
        private set

    private val listener = Shizuku.OnRequestPermissionResultListener { _, grant ->
        lastGrant = grant == PackageManager.PERMISSION_GRANTED
        Log.i(TAG, "permission result: granted=$grant")
    }

    fun registerListener() {
        runCatching { Shizuku.addRequestPermissionResultListener(listener) }
    }

    fun unregisterListener() {
        runCatching { Shizuku.removeRequestPermissionResultListener(listener) }
    }

    fun requestPermission() {
        runCatching { Shizuku.requestPermission(REQUEST_CODE) }
            .onFailure { Log.w(TAG, "requestPermission: ${it.message}") }
    }

    fun installed(ctx: Context): Boolean =
        runCatching { ctx.packageManager.getPackageInfo(PKG, 0); true }.getOrDefault(false)

    fun binderAlive(): Boolean = runCatching { Shizuku.pingBinder() }.getOrDefault(false)

    fun hasPermission(): Boolean = runCatching {
        binderAlive() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    /** full доступен только когда сервис Shizuku жив и разрешение выдано. */
    fun isReady(ctx: Context): Boolean = hasPermission()

    fun state(ctx: Context): State = when {
        !binderAlive() -> if (installed(ctx)) State.NOT_RUNNING else State.NOT_INSTALLED
        hasPermission() -> State.READY
        else -> State.NO_PERMISSION
    }

    /**
     * shell через Shizuku: stdout/stderr/код выхода. Вывод обрезается до 64 КБ,
     * по таймауту процесс убивается и команда отвечает timeout.
     */
    fun shell(cmd: String, timeoutMs: Long = 60_000): JSONObject {
        if (!hasPermission()) throw CmdFail("full-unavailable")
        val binder = Shizuku.getBinder() ?: throw CmdFail("full-unavailable")
        val svc = IShizukuService.Stub.asInterface(binder) ?: throw CmdFail("full-unavailable")
        val proc = svc.newProcess(arrayOf("sh", "-c", cmd), null, null)
            ?: throw CmdFail("full-unavailable")

        val out = ByteArrayOutputStream()
        val err = ByteArrayOutputStream()
        val tOut = Thread { drain(ParcelFileDescriptor.AutoCloseInputStream(proc.getInputStream()), out) }
            .apply { isDaemon = true; start() }
        val tErr = Thread { drain(ParcelFileDescriptor.AutoCloseInputStream(proc.getErrorStream()), err) }
            .apply { isDaemon = true; start() }
        var code = -1
        val waiter = Thread { code = runCatching { proc.waitFor() }.getOrDefault(-1) }
            .apply { isDaemon = true; start() }
        waiter.join(timeoutMs)
        val timedOut = waiter.isAlive
        if (timedOut) runCatching { proc.destroy() }
        tOut.join(2000)
        tErr.join(2000)
        if (timedOut) throw CmdFail("timeout")

        return JSONObject()
            .put("stdout", out.toString("UTF-8"))
            .put("stderr", err.toString("UTF-8"))
            .put("code", code)
            .put("truncated", out.size() >= OUTPUT_LIMIT || err.size() >= OUTPUT_LIMIT)
    }

    private fun drain(input: InputStream, sink: ByteArrayOutputStream) {
        try {
            val buf = ByteArray(8192)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                val room = OUTPUT_LIMIT - sink.size()
                if (room > 0) sink.write(buf, 0, minOf(n, room))
            }
        } catch (e: Exception) {
            Log.d(TAG, "drain: ${e.message}")
        } finally {
            runCatching { input.close() }
        }
    }
}
