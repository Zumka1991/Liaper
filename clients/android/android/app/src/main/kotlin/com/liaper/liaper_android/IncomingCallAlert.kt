package com.liaper.liaper_android

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

/**
 * Входящий звонок: рингтон по кругу (поток «звонок», а не «медиа»), вибрация в такт
 * мелодии и high-priority уведомление с full-screen intent, пока приложение не на экране.
 */
class IncomingCallAlert(private val activity: Activity) {
    companion object {
        const val ACTION_ACCEPT = "com.liaper.liaper_android.CALL_ACCEPT"
        const val ACTION_DECLINE = "com.liaper.liaper_android.CALL_DECLINE"
        const val ACTION_OPEN = "com.liaper.liaper_android.CALL_OPEN"
        private const val CHANNEL_ID = "incoming_calls"
        private const val NOTIFICATION_ID = 4201
        // Звонящий может бросить трубку, а сервер об этом не сообщает — не звоним бесконечно
        private const val RING_TIMEOUT_MS = 45_000L
        // Ритм вибрации совпадает с циклом мелодии (2.6 с): два коротких импульса и пауза
        private val VIBRATION_PATTERN = longArrayOf(0, 400, 200, 400, 1600)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val notificationManager =
        activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private var player: MediaPlayer? = null
    private var ringing = false
    private var inForeground = true
    private var callerName = ""
    private var roomTitle = ""
    private var withVideo = false

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    private val ringAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private val timeoutRunnable = Runnable { silence() }

    fun start(caller: String, title: String, video: Boolean) {
        stop()
        ringing = true
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
        handler.postDelayed(timeoutRunnable, RING_TIMEOUT_MS)
    }

    fun stop() {
        ringing = false
        handler.removeCallbacks(timeoutRunnable)
        silence()
        notificationManager.cancel(NOTIFICATION_ID)
        setShowOverLockScreen(false)
    }

    fun onForegroundChanged(foreground: Boolean) {
        inForeground = foreground
        if (!ringing) return
        // В приложении уже виден баннер — системное уведомление нужно только снаружи
        if (foreground) notificationManager.cancel(NOTIFICATION_ID) else showNotification()
    }

    private fun silence() {
        handler.removeCallbacksAndMessages(VOLUME_TOKEN)
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
            val uri = Uri.parse("android.resource://${activity.packageName}/${R.raw.ringtone}")
            val mp = MediaPlayer()
            mp.setAudioAttributes(ringAttributes)
            mp.setDataSource(activity, uri)
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
        }, VOLUME_TOKEN, android.os.SystemClock.uptimeMillis() + 500)
    }

    private fun vibrate() {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0), ringAttributes)
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(VIBRATION_PATTERN, 0, ringAttributes)
            }
        } catch (_: Exception) {
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (notificationManager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Звонки и приглашения на урок"
            // Звук и вибрацию проигрываем сами, чтобы они шли по кругу, а не один раз
            setSound(null, null)
            enableVibration(false)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        notificationManager.createNotificationChannel(channel)
    }

    private fun activityIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(activity, activity.javaClass).apply {
            this.action = action
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            activity, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun declineIntent(): PendingIntent {
        val intent = Intent(ACTION_DECLINE).setPackage(activity.packageName)
        return PendingIntent.getBroadcast(
            activity, 3, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun showNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !notificationManager.areNotificationsEnabled()
        ) return
        ensureChannel()
        val openIntent = activityIntent(ACTION_OPEN, 1)
        val builder = NotificationCompat.Builder(activity, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(if (withVideo) "Входящий видеозвонок" else "Входящий звонок")
            .setContentText(if (roomTitle.isNotEmpty()) "$callerName — $roomTitle" else callerName)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отклонить", declineIntent())
            .addAction(android.R.drawable.sym_action_call, "Принять", activityIntent(ACTION_ACCEPT, 2))
        // Поверх других приложений и на заблокированном экране — как обычный звонок
        val canFullScreen = Build.VERSION.SDK_INT < 34 || notificationManager.canUseFullScreenIntent()
        if (canFullScreen) builder.setFullScreenIntent(openIntent, true)
        try {
            notificationManager.notify(NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
        }
    }

    private fun setShowOverLockScreen(enabled: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.setShowWhenLocked(enabled)
            activity.setTurnScreenOn(enabled)
        }
    }
}

private val VOLUME_TOKEN = Any()
