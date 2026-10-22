package com.liaper.liaper_android

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Сквозное шифрование звука и видео в звонке ключом комнаты (AES-256-GCM, аппаратно).
 * Формат v1 общий с web (`src/crypto/mediaFrames.ts`): случайный IV 12 байт на кадр,
 * шифротекст с тегом 16 байт в конце, AAD "liaper-media-v1|<room>|<отправитель>|<тип>".
 * Ключи приходят из Dart (связка ключей комнаты) через [setKeys].
 */
object MediaFrameCipher {
    const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private class State(
        val roomId: String,
        val userId: String,
        val activeKeyId: String,
        val keys: Map<String, SecretKeySpec>,
    )

    @Volatile
    private var state: State? = null
    private val random = SecureRandom()

    class Frame(val ciphertext: ByteArray, val iv: ByteArray, val keyId: String)

    fun setKeys(roomId: String, userId: String, activeKeyId: String, rawKeysB64: Map<String, String>) {
        val keys = rawKeysB64.mapNotNull { (id, b64) ->
            val raw = try { Base64.decode(b64, Base64.DEFAULT) } catch (_: Exception) { null }
            if (raw != null && raw.size == 32) id to SecretKeySpec(raw, "AES") else null
        }.toMap()
        state = if (keys.containsKey(activeKeyId)) State(roomId, userId, activeKeyId, keys) else null
    }

    fun clear() {
        state = null
    }

    fun aad(roomId: String, senderId: String, kind: String): ByteArray =
        "liaper-media-v1|$roomId|$senderId|$kind".toByteArray(Charsets.UTF_8)

    /** null — ключа комнаты ещё нет: кадр не отправляем, открытым текстом медиа не уходит. */
    fun encrypt(kind: String, plaintext: ByteArray): Frame? {
        val s = state ?: return null
        val key = s.keys[s.activeKeyId] ?: return null
        return try {
            val iv = ByteArray(IV_BYTES).also(random::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(aad(s.roomId, s.userId, kind))
            Frame(cipher.doFinal(plaintext), iv, s.activeKeyId)
        } catch (_: Exception) {
            null
        }
    }

    /** null — неизвестный ключ, подделанный или незашифрованный кадр. */
    fun decrypt(kind: String, senderId: String, keyId: String, iv: ByteArray, ciphertext: ByteArray): ByteArray? {
        val s = state ?: return null
        val key = s.keys[keyId] ?: return null
        if (iv.size != IV_BYTES) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(aad(s.roomId, senderId, kind))
            cipher.doFinal(ciphertext)
        } catch (_: Exception) {
            null
        }
    }
}
