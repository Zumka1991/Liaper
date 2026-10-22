package com.liaper.liaper_android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** «Отклонить» в уведомлении о звонке: работает и без запущенного приложения. */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != CallNotifications.ACTION_DECLINE) return
        val roomId = intent.getStringExtra(CallNotifications.EXTRA_ROOM_ID) ?: return
        CallNotifications.cancel(context)
        val activity = CallRingState.activity?.get()
        if (activity != null) {
            activity.onCallActionFromNotification(roomId, "decline")
        } else {
            // Приложение выгружено: отклоним на сервере, если звонок придёт при следующем запуске
            CallRingState.setPendingAction(roomId, "decline")
        }
    }
}
