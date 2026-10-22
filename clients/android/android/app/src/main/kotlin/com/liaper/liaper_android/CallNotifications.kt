package com.liaper.liaper_android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import java.lang.ref.WeakReference

/** Общее состояние звонка между activity, push-сервисом и обработчиком кнопок уведомления. */
object CallRingState {
    /** Комната, для которой приложение само звонит (MediaPlayer) — push по ней не нужен */
    @Volatile
    var activeRoomId: String? = null

    /** Комната, для которой звонит push-уведомление (приложение могло быть выгружено) */
    @Volatile
    var pushRoomId: String? = null

    @Volatile
    var activity: WeakReference<MainActivity>? = null

    private var pendingAction: Triple<String, String, Long>? = null

    /**
     * «Принять»/«Отклонить» нажали в уведомлении, когда приложение ещё не знало о звонке
     * (было выгружено). Выполним, когда звонок придёт по WebSocket.
     */
    @Synchronized
    fun setPendingAction(roomId: String, action: String) {
        pendingAction = Triple(roomId, action, SystemClock.elapsedRealtime())
    }

    @Synchronized
    fun takePendingAction(roomId: String): String? {
        val pending = pendingAction ?: return null
        if (SystemClock.elapsedRealtime() - pending.third > 60_000) {
            pendingAction = null
            return null
        }
        if (pending.first != roomId) return null
        pendingAction = null
        return pending.second
    }

    @Synchronized
    fun clearPendingAction(roomId: String) {
        if (pendingAction?.first == roomId) pendingAction = null
    }
}

/** Уведомление о входящем звонке: и из приложения, и из push. */
object CallNotifications {
    const val ACTION_ACCEPT = "com.liaper.liaper_android.CALL_ACCEPT"
    const val ACTION_DECLINE = "com.liaper.liaper_android.CALL_DECLINE"
    const val ACTION_OPEN = "com.liaper.liaper_android.CALL_OPEN"
    const val EXTRA_ROOM_ID = "room_id"
    const val NOTIFICATION_ID = 4201
    const val RING_TIMEOUT_MS = 45_000L

    // Приложение звонит само (MediaPlayer) — канал без звука
    private const val SILENT_CHANNEL_ID = "incoming_calls"
    // Push, приложение могло быть выгружено — звонит сама система, по кругу (FLAG_INSISTENT)
    private const val RING_CHANNEL_ID = "incoming_calls_ring"

    // Ритм вибрации совпадает с циклом мелодии (2.6 с): два коротких импульса и пауза
    val VIBRATION_PATTERN = longArrayOf(0, 400, 200, 400, 1600)

    val RING_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    fun ringtoneUri(context: Context): Uri =
        Uri.parse("android.resource://${context.packageName}/${R.raw.ringtone}")

    private fun manager(context: Context) =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = manager(context)
        if (nm.getNotificationChannel(SILENT_CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(SILENT_CHANNEL_ID, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Звонки и приглашения на урок, пока приложение открыто"
                    // Звук и вибрацию проигрываем сами, чтобы они шли по кругу, а не один раз
                    setSound(null, null)
                    enableVibration(false)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
            )
        }
        if (nm.getNotificationChannel(RING_CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(RING_CHANNEL_ID, "Входящие звонки (фон)", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Звонки, когда приложение свёрнуто или закрыто"
                    setSound(ringtoneUri(context), RING_ATTRIBUTES)
                    enableVibration(true)
                    vibrationPattern = VIBRATION_PATTERN
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
            )
        }
    }

    private fun activityIntent(context: Context, action: String, roomId: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            this.action = action
            putExtra(EXTRA_ROOM_ID, roomId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun declineIntent(context: Context, roomId: String): PendingIntent {
        val intent = Intent(context, CallActionReceiver::class.java).apply {
            action = ACTION_DECLINE
            putExtra(EXTRA_ROOM_ID, roomId)
        }
        return PendingIntent.getBroadcast(
            context, 3, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /**
     * @param ringing true — звонит сама система (push), false — звук уже играет приложение
     */
    fun show(
        context: Context,
        roomId: String,
        callerName: String,
        roomTitle: String,
        withVideo: Boolean,
        ringing: Boolean,
    ) {
        val nm = manager(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !nm.areNotificationsEnabled()) return
        ensureChannels(context)
        val openIntent = activityIntent(context, ACTION_OPEN, roomId, 1)
        val builder = NotificationCompat.Builder(context, if (ringing) RING_CHANNEL_ID else SILENT_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(if (withVideo) "Входящий видеозвонок" else "Входящий звонок")
            .setContentText(if (roomTitle.isNotEmpty()) "$callerName — $roomTitle" else callerName)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отклонить", declineIntent(context, roomId))
            .addAction(android.R.drawable.sym_action_call, "Принять", activityIntent(context, ACTION_ACCEPT, roomId, 2))
        if (ringing && Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            @Suppress("DEPRECATION")
            builder.setSound(ringtoneUri(context), AudioManager.STREAM_RING)
                .setVibrate(VIBRATION_PATTERN)
        }
        // Поверх других приложений и на заблокированном экране — как обычный звонок
        val canFullScreen = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()
        if (canFullScreen) builder.setFullScreenIntent(openIntent, true)
        val notification = builder.build()
        // Звук и вибрация повторяются, пока уведомление не убрали
        if (ringing) notification.flags = notification.flags or Notification.FLAG_INSISTENT
        try {
            nm.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
        }
    }

    fun cancel(context: Context) {
        CallRingState.pushRoomId = null
        manager(context).cancel(NOTIFICATION_ID)
    }
}
