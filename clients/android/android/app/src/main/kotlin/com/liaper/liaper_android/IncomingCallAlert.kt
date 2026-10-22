package com.liaper.liaper_android

import android.app.Activity
import android.content.Context
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Входящий звонок, пока приложение живо: рингтон по кругу (поток «звонок», а не «медиа»),
 * вибрация в такт мелодии и уведомление поверх экрана, пока приложение не на экране.
 */
class IncomingCallAlert(private val activity: Activity) {
    private val handler = Handler(Looper.getMainLooper())
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var player: MediaPlayer? = null
    private var roomId: String? = null
    private var inForeground = true
    private var callerName = ""
    private var roomTitle = ""
    private var withVideo = false
    private val volumeToken = Any()

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    // Звонящий может бросить трубку раньше, чем сервер узнает об этом, — не звоним бесконечно
    private val timeoutRunnable = Runnable { silence() }

    fun start(room: String, caller: String, title: String, video: Boolean) {
        stop()
        roomId = room
        CallRingState.activeRoomId = room
        callerName = caller
        roomTitle = title
        withVideo = video
        setShowOverLockScreen(true)

        when (audioManager.ringerMode) {
            AudioManager.RINGER_MODE_NORMAL -> {
                playRingtone()
                vibrate()
            }
            AudioManager.RINGER_MODE_VIBRATE -> vibrate()
            else -> Unit // беззвучный режим уважаем: остаётся только уведомление
        }
        if (!inForeground) showNotification()
        handler.postDelayed(timeoutRunnable, CallNotifications.RING_TIMEOUT_MS)
    }

    fun stop() {
        roomId = null
        CallRingState.activeRoomId = null
        handler.removeCallbacks(timeoutRunnable)
        silence()
        // Заодно гасит push-уведомление о том же звонке
        CallNotifications.cancel(activity)
        setShowOverLockScreen(false)
    }

    fun onForegroundChanged(foreground: Boolean) {
        inForeground = foreground
        if (roomId == null) return
        // В приложении уже виден баннер — системное уведомление нужно только снаружи
        if (foreground) CallNotifications.cancel(activity) else showNotification()
    }

    private fun showNotification() {
        val room = roomId ?: return
        CallNotifications.show(activity, room, callerName, roomTitle, withVideo, ringing = false)
    }

    private fun silence() {
        handler.removeCallbacksAndMessages(volumeToken)
        try {
            player?.stop()
        } catch (_: Exception) {
        }
        player?.release()
        player = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
    }

    private fun playRingtone() {
        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(CallNotifications.RING_ATTRIBUTES)
            mp.setDataSource(activity, CallNotifications.ringtoneUri(activity))
            mp.isLooping = true
            mp.prepare()
            mp.setVolume(0.35f, 0.35f)
            mp.start()
            player = mp
            rampVolume(0.35f)
        } catch (_: Exception) {
            player?.release()
            player = null
        }
    }

    // Плавное нарастание громкости, чтобы звонок не пугал
    private fun rampVolume(current: Float) {
        if (current >= 1f) return
        handler.postAtTime({
            val next = (current + 0.05f).coerceAtMost(1f)
            player?.setVolume(next, next)
            if (player != null) rampVolume(next)
        }, volumeToken, SystemClock.uptimeMillis() + 500)
    }

    private fun vibrate() {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(
                    VibrationEffect.createWaveform(CallNotifications.VIBRATION_PATTERN, 0),
                    CallNotifications.RING_ATTRIBUTES
                )
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(CallNotifications.VIBRATION_PATTERN, 0, CallNotifications.RING_ATTRIBUTES)
            }
        } catch (_: Exception) {
        }
    }

    private fun setShowOverLockScreen(enabled: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.setShowWhenLocked(enabled)
            activity.setTurnScreenOn(enabled)
        }
    }
}
