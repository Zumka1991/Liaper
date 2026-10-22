package com.liaper.liaper_android

import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Push о звонках от сервера (FCM data-сообщения). Работает и когда приложение выгружено:
 * звонящее уведомление собираем здесь, а сам звонок приложение получит по WebSocket,
 * когда пользователь его откроет.
 */
class LiaperMessagingService : FirebaseMessagingService() {
    companion object {
        private const val PREFS = "liaper_push"
        private const val KEY_TOKEN = "fcm_token"

        fun savedToken(context: Context): String? =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)
    }

    override fun onNewToken(token: String) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply()
        CallRingState.activity?.get()?.onPushTokenChanged(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val roomId = data["room_id"] ?: return
        when (data["type"]) {
            "incoming_call" -> {
                // Приложение уже звонит по этому звонку само — второй звонок не нужен
                if (CallRingState.activeRoomId == roomId) return
                val sentAt = data["sent_at"]?.toLongOrNull() ?: 0L
                if (System.currentTimeMillis() - sentAt > CallNotifications.RING_TIMEOUT_MS) return
                CallRingState.pushRoomId = roomId
                CallNotifications.show(
                    this,
                    roomId,
                    data["caller_name"].orEmpty(),
                    data["room_title"].orEmpty(),
                    data["with_video"] == "true",
                    ringing = true,
                )
            }
            "call_cancel" -> {
                CallRingState.clearPendingAction(roomId)
                if (CallRingState.pushRoomId == roomId) CallNotifications.cancel(this)
                // WebSocket мог уснуть вместе с телефоном — гасим и звонок внутри приложения
                if (CallRingState.activeRoomId == roomId) {
                    CallRingState.activity?.get()?.onCallCancelledByPush(roomId)
                }
            }
        }
    }
}
