package com.liaper.liaper_android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.math.min

class MainActivity : FlutterActivity() {
    private val channelName = "com.liaper.audio"
    private var methodChannel: MethodChannel? = null

    @Volatile
    private var isRecording = false
    @Volatile
    private var micMuted = false
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Запись голосовых сообщений и звука видеокружков (16 кГц моно PCM16 -> WAV)
    @Volatile
    private var isNoteRecording = false
    private var noteAudioRecord: AudioRecord? = null
    private var noteCaptureThread: Thread? = null
    private var noteStartTimeMs: Long = 0L
    private val notePcmStream = ByteArrayOutputStream()

    // Воспроизведение WAV (войсы и звук видеокружков)
    private var mediaPlayer: MediaPlayer? = null

    // Ожидающие колбэки разрешений и выбора файла
    private var pendingPermResult: MethodChannel.Result? = null
    private var pendingFileResult: MethodChannel.Result? = null

    companion object {
        private const val REQ_PERMISSIONS = 1001
        private const val REQ_PICK_FILE = 1002
        private const val MAX_PLAIN_FILE_BYTES = 134_217_712L // 128 MiB - 16B GCM tag
    }

    override fun onPostResume() {
        super.onPostResume()
        try {
            window.navigationBarColor = 0xFF0F172A.toInt()
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
            }
        } catch (_: Exception) {
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        methodChannel = channel

        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "requestPermissions" -> {
                    val needAudio = call.argument<Boolean>("needAudio")
                        ?: call.argument<Boolean>("audio")
                        ?: true
                    val needCamera = call.argument<Boolean>("needCamera")
                        ?: call.argument<Boolean>("camera")
                        ?: false
                    requestMediaPermissions(needAudio, needCamera, result)
                }
                "pickAttachmentFile" -> {
                    openDocumentPicker(result)
                }
                "startAudio" -> {
                    startAudioEngine()
                    result.success(true)
                }
                "stopAudio" -> {
                    stopAudioEngine()
                    result.success(true)
                }
                "setMicMute" -> {
                    val enabled = call.argument<Boolean>("micEnabled") ?: true
                    micMuted = !enabled
                    result.success(true)
                }
                "playPcm16" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    if (bytes != null) {
                        playPcmChunk(bytes)
                    }
                    result.success(true)
                }
                "startNoteAudio" -> {
                    val started = startNoteAudioCapture()
                    result.success(started)
                }
                "stopNoteAudio" -> {
                    val map = stopNoteAudioCapture(cancel = false)
                    result.success(map)
                }
                "cancelNoteAudio" -> {
                    stopNoteAudioCapture(cancel = true)
                    result.success(true)
                }
                "playWavBytes" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    val id = call.argument<String>("id") ?: ""
                    if (bytes != null) {
                        val ok = playWavFromBytes(bytes, id)
                        result.success(ok)
                    } else {
                        result.success(false)
                    }
                }
                "stopWavPlayback" -> {
                    stopWavPlayer()
                    result.success(true)
                }
                "compressFrame" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    if (bytes != null) {
                        try {
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            if (bmp != null) {
                                val maxDim = 720
                                val ratio = bmp.width.toFloat() / bmp.height.toFloat()
                                val targetW: Int
                                val targetH: Int
                                if (bmp.width >= bmp.height) {
                                    targetW = maxDim.coerceAtMost(bmp.width)
                                    targetH = (targetW / ratio).toInt().coerceAtLeast(240)
                                } else {
                                    targetH = maxDim.coerceAtMost(bmp.height)
                                    targetW = (targetH * ratio).toInt().coerceAtLeast(240)
                                }
                                val scaled = if (targetW != bmp.width || targetH != bmp.height) {
                                    Bitmap.createScaledBitmap(bmp, targetW, targetH, true)
                                } else {
                                    bmp
                                }
                                val out = ByteArrayOutputStream()
                                scaled.compress(Bitmap.CompressFormat.JPEG, 82, out)
                                result.success(out.toByteArray())
                            } else {
                                result.success(bytes)
                            }
                        } catch (_: Exception) {
                            result.success(bytes)
                        }
                    } else {
                        result.success(null)
                    }
                }
                "compressSquareFrame" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    val targetSize = (call.argument<Int>("size") ?: 320).coerceIn(120, 640)
                    val quality = (call.argument<Int>("quality") ?: 72).coerceIn(40, 95)
                    if (bytes != null && bytes.isNotEmpty()) {
                        try {
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            if (bmp != null) {
                                val side = min(bmp.width, bmp.height)
                                val sx = (bmp.width - side) / 2
                                val sy = (bmp.height - side) / 2
                                val cropped = Bitmap.createBitmap(bmp, sx, sy, side, side)
                                val scaled = if (side != targetSize) {
                                    Bitmap.createScaledBitmap(cropped, targetSize, targetSize, true)
                                } else {
                                    cropped
                                }
                                val out = ByteArrayOutputStream()
                                scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
                                result.success(out.toByteArray())
                            } else {
                                result.success(createFallbackSquareJpeg(targetSize, quality))
                            }
                        } catch (_: Exception) {
                            result.success(createFallbackSquareJpeg(targetSize, quality))
                        }
                    } else {
                        result.success(createFallbackSquareJpeg(targetSize, quality))
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun createFallbackSquareJpeg(size: Int, quality: Int): ByteArray {
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(0xFF0F172A.toInt())
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        bmp.recycle()
        return out.toByteArray()
    }

    private fun currentPermissionMap(): Map<String, Boolean> {
        val audioGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        val cameraGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        return mapOf(
            "audio" to audioGranted,
            "camera" to cameraGranted
        )
    }

    private fun requestMediaPermissions(
        needAudio: Boolean,
        needCamera: Boolean,
        result: MethodChannel.Result
    ) {
        val missing = mutableListOf<String>()
        if (needAudio &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            missing.add(Manifest.permission.RECORD_AUDIO)
        }
        if (needCamera &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) {
            missing.add(Manifest.permission.CAMERA)
        }
        if (missing.isEmpty()) {
            result.success(currentPermissionMap())
            return
        }
        pendingPermResult?.success(currentPermissionMap())
        pendingPermResult = result
        ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_PERMISSIONS)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMISSIONS) {
            val cb = pendingPermResult
            pendingPermResult = null
            cb?.success(currentPermissionMap())
        }
    }

    private fun openDocumentPicker(result: MethodChannel.Result) {
        pendingFileResult?.success(null)
        pendingFileResult = result
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(
                    Intent.EXTRA_MIME_TYPES,
                    arrayOf(
                        "application/pdf",
                        "application/msword",
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "image/*"
                    )
                )
            }
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_PICK_FILE)
        } catch (e: Exception) {
            pendingFileResult = null
            result.success(mapOf("error" to "Не удалось открыть системный выбор файлов"))
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PICK_FILE) {
            val cb = pendingFileResult
            pendingFileResult = null
            if (cb == null) return
            if (resultCode != Activity.RESULT_OK || data?.data == null) {
                cb.success(null)
                return
            }
            val uri: Uri = data.data!!
            thread(start = true, name = "LiaperFileRead") {
                try {
                    var displayName = "attachment"
                    var fileSize = -1L
                    contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx >= 0) {
                                displayName = cursor.getString(nameIdx) ?: "attachment"
                            }
                            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                                fileSize = cursor.getLong(sizeIdx)
                            }
                        }
                    }
                    if (fileSize > MAX_PLAIN_FILE_BYTES) {
                        mainHandler.post {
                            cb.success(mapOf("error" to "Файл превышает лимит 128 МиБ"))
                        }
                        return@thread
                    }
                    val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
                    val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    if (bytes == null || bytes.isEmpty()) {
                        mainHandler.post {
                            cb.success(mapOf("error" to "Выбранный файл пуст или недоступен"))
                        }
                        return@thread
                    }
                    if (bytes.size.toLong() > MAX_PLAIN_FILE_BYTES) {
                        mainHandler.post {
                            cb.success(mapOf("error" to "Файл превышает лимит 128 МиБ"))
                        }
                        return@thread
                    }
                    mainHandler.post {
                        cb.success(
                            mapOf(
                                "name" to displayName,
                                "mimeType" to mimeType,
                                "bytes" to bytes
                            )
                        )
                    }
                } catch (e: Exception) {
                    mainHandler.post {
                        cb.success(mapOf("error" to "Не удалось прочитать выбранный файл"))
                    }
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startNoteAudioCapture(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return false
        }
        stopNoteAudioCapture(cancel = true)
        synchronized(notePcmStream) {
            notePcmStream.reset()
        }
        noteStartTimeMs = System.currentTimeMillis()

        // Если уже активен голосовой движок звонка, пишем PCM напрямую из него без конфликта микрофона
        if (isRecording && audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            isNoteRecording = true
            return true
        }

        val sampleRate = 16000
        val minRecBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(6400)

        return try {
            var recorder = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minRecBuf * 2
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                recorder = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    minRecBuf * 2
                )
            }
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                return false
            }
            noteAudioRecord = recorder
            isNoteRecording = true
            recorder.startRecording()

            noteCaptureThread = thread(start = true, name = "LiaperNoteAudioCapture") {
                val buf = ByteArray(2048)
                try {
                    while (isNoteRecording) {
                        val read = recorder.read(buf, 0, buf.size)
                        if (read > 0 && isNoteRecording) {
                            synchronized(notePcmStream) {
                                notePcmStream.write(buf, 0, read)
                            }
                        }
                    }
                } catch (_: Exception) {
                }
            }
            true
        } catch (_: Exception) {
            isNoteRecording = false
            false
        }
    }

    private fun stopNoteAudioCapture(cancel: Boolean): Map<String, Any>? {
        val wasRecording = isNoteRecording
        isNoteRecording = false
        val durationMs = (System.currentTimeMillis() - noteStartTimeMs).coerceAtLeast(300L).toInt()
        val rec = noteAudioRecord
        val thr = noteCaptureThread
        noteAudioRecord = null
        noteCaptureThread = null
        try {
            rec?.stop()
        } catch (_: Exception) {
        }
        try {
            thr?.join(300)
        } catch (_: Exception) {
        }
        try {
            rec?.release()
        } catch (_: Exception) {
        }

        val pcmBytes: ByteArray
        synchronized(notePcmStream) {
            pcmBytes = if (cancel || !wasRecording) ByteArray(0) else notePcmStream.toByteArray()
            notePcmStream.reset()
        }
        if (cancel || !wasRecording) return null

        val safePcm = if (pcmBytes.isEmpty()) ByteArray(16000) else pcmBytes
        val wavBytes = encodePcm16ToWav(safePcm, 16000)
        return mapOf(
            "wavBytes" to wavBytes,
            "durationMs" to durationMs
        )
    }

    private fun encodePcm16ToWav(pcmBytes: ByteArray, sampleRate: Int): ByteArray {
        val dataLen = pcmBytes.size
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + dataLen)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16) // PCM chunk size
        header.putShort(1) // PCM format
        header.putShort(1) // Mono
        header.putInt(sampleRate)
        header.putInt(sampleRate * 2)
        header.putShort(2) // Block align
        header.putShort(16) // Bits per sample
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(dataLen)

        val out = ByteArray(44 + dataLen)
        System.arraycopy(header.array(), 0, out, 0, 44)
        System.arraycopy(pcmBytes, 0, out, 44, dataLen)
        return out
    }

    private fun playWavFromBytes(wavBytes: ByteArray, attachmentId: String): Boolean {
        stopWavPlayer()
        return try {
            val tempFile = File(cacheDir, "liaper_play_${System.currentTimeMillis()}.wav")
            tempFile.writeBytes(wavBytes)
            val mp = MediaPlayer()
            mediaPlayer = mp
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            FileInputStream(tempFile).use { fis ->
                mp.setDataSource(fis.fd)
            }
            mp.setOnCompletionListener {
                stopWavPlayer()
                tempFile.delete()
                mainHandler.post {
                    methodChannel?.invokeMethod("onWavPlaybackComplete", attachmentId)
                }
            }
            mp.prepare()
            mp.start()
            true
        } catch (_: Exception) {
            stopWavPlayer()
            false
        }
    }

    private fun stopWavPlayer() {
        try {
            mediaPlayer?.stop()
        } catch (_: Exception) {
        }
        try {
            mediaPlayer?.release()
        } catch (_: Exception) {
        }
        mediaPlayer = null
    }

    @SuppressLint("MissingPermission")
    private fun startAudioEngine() {
        if (isRecording) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return
        }
        isRecording = true

        val sampleRate = 16000
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isSpeakerphoneOn = true

        val minPlayBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(6400)

        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(minPlayBuf * 2)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        audioTrack?.play()

        val minRecBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(6400)

        thread(start = true, name = "LiaperAudioCapture") {
            try {
                val recorder = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    minRecBuf * 2
                )
                audioRecord = recorder
                recorder.startRecording()

                val chunkBuf = ByteArray(2560)
                while (isRecording) {
                    val read = recorder.read(chunkBuf, 0, chunkBuf.size)
                    if (read > 0 && isRecording) {
                        if (isNoteRecording) {
                            synchronized(notePcmStream) {
                                notePcmStream.write(chunkBuf, 0, read)
                            }
                        }
                        if (!micMuted) {
                            val copy = chunkBuf.copyOf(read)
                            mainHandler.post {
                                if (isRecording && !micMuted) {
                                    methodChannel?.invokeMethod("onPcm16Chunk", copy)
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun playPcmChunk(bytes: ByteArray) {
        try {
            audioTrack?.write(bytes, 0, bytes.size)
        } catch (_: Exception) {
        }
    }

    private fun stopAudioEngine() {
        isRecording = false
        try {
            audioRecord?.stop()
            audioRecord?.release()
        } catch (_: Exception) {
        }
        audioRecord = null

        try {
            audioTrack?.stop()
            audioTrack?.release()
        } catch (_: Exception) {
        }
        audioTrack = null
    }

    override fun onDestroy() {
        stopNoteAudioCapture(cancel = true)
        stopWavPlayer()
        stopAudioEngine()
        super.onDestroy()
    }
}
