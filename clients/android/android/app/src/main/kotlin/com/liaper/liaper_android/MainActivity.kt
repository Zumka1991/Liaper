package com.liaper.liaper_android

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    private val channelName = "com.liaper.audio"
    private var methodChannel: MethodChannel? = null

    @Volatile
    private var isRecording = false
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA),
                1001
            )
        }

        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
        methodChannel = channel

        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "startAudio" -> {
                    startAudioEngine()
                    result.success(true)
                }
                "stopAudio" -> {
                    stopAudioEngine()
                    result.success(true)
                }
                "playPcm16" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    if (bytes != null) {
                        playPcmChunk(bytes)
                    }
                    result.success(true)
                }
                "compressFrame" -> {
                    val bytes = call.argument<ByteArray>("bytes")
                    if (bytes != null) {
                        try {
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            if (bmp != null) {
                                // Высокое разрешение 720p с сохранением пропорций и высокой чёткостью (82%)
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
                        } catch (e: Exception) {
                            result.success(bytes)
                        }
                    } else {
                        result.success(null)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startAudioEngine() {
        if (isRecording) return
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

                // Чанки по 80 мс (1280 сэмплов * 2 байта = 2560 байт) для минимальной задержки
                val chunkBuf = ByteArray(2560)
                while (isRecording) {
                    val read = recorder.read(chunkBuf, 0, chunkBuf.size)
                    if (read > 0 && isRecording) {
                        val copy = chunkBuf.copyOf(read)
                        mainHandler.post {
                            if (isRecording) {
                                methodChannel?.invokeMethod("onPcm16Chunk", copy)
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
        stopAudioEngine()
        super.onDestroy()
    }
}
