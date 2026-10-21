import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import '../services/e2ee_attachments.dart';

class ChatAttachmentCard extends StatefulWidget {
  final ChatAttachmentMeta attachment;
  final String serverUrl;
  final String token;
  final bool isMe;
  final MethodChannel mediaChannel;

  const ChatAttachmentCard({
    super.key,
    required this.attachment,
    required this.serverUrl,
    required this.token,
    required this.isMe,
    required this.mediaChannel,
  });

  @override
  State<ChatAttachmentCard> createState() => _ChatAttachmentCardState();
}

class _ChatAttachmentCardState extends State<ChatAttachmentCard> {
  String _status = 'idle'; // 'idle' | 'loading' | 'ready' | 'expired' | 'error'
  double _progress = 0.0;
  String? _errorMsg;
  Uint8List? _decryptedBytes;
  DecodedLpvnVideoNote? _videoNote;

  bool _playing = false;
  int _playElapsedMs = 0;
  int _currentFrameIdx = 0;
  Timer? _playTimer;

  bool get _isLocallyExpired {
    if (widget.attachment.expiresAt.isEmpty) return false;
    final dt = DateTime.tryParse(widget.attachment.expiresAt);
    if (dt == null) return false;
    return dt.millisecondsSinceEpoch <= DateTime.now().millisecondsSinceEpoch;
  }

  @override
  void initState() {
    super.initState();
    final cached = AndroidAttachmentService.getCachedBytes(widget.attachment.id);
    if (cached != null) {
      _applyDecryptedBytes(cached);
    } else if (_isLocallyExpired) {
      _status = 'expired';
    } else if (widget.attachment.kind == 'image' ||
        widget.attachment.kind == 'voice' ||
        widget.attachment.kind == 'video_note') {
      _loadAttachment(openAfterDownload: false);
    }
  }

  @override
  void dispose() {
    _stopPlayback(silent: true);
    super.dispose();
  }

  void _applyDecryptedBytes(Uint8List bytes) {
    DecodedLpvnVideoNote? note;
    if (widget.attachment.kind == 'video_note') {
      try {
        note = AndroidAttachmentService.decodeLpvnVideoNote(bytes);
      } catch (e) {
        if (mounted) {
          setState(() {
            _status = 'error';
            _errorMsg = e.toString();
          });
        }
        return;
      }
    }
    if (mounted) {
      setState(() {
        _decryptedBytes = bytes;
        _videoNote = note;
        _status = 'ready';
        _progress = 1.0;
      });
    }
  }

  Future<void> _loadAttachment({required bool openAfterDownload}) async {
    if (_status == 'loading') return;
    if (_isLocallyExpired &&
        AndroidAttachmentService.getCachedBytes(widget.attachment.id) == null) {
      setState(() => _status = 'expired');
      return;
    }

    setState(() {
      _status = 'loading';
      _progress = 0.08;
      _errorMsg = null;
    });

    try {
      final bytes = await AndroidAttachmentService.downloadAndDecryptAttachment(
        controlBaseUrl: widget.serverUrl,
        token: widget.token,
        meta: widget.attachment,
        onProgress: (p) {
          if (mounted) {
            setState(() => _progress = p);
          }
        },
      );
      if (!mounted) return;
      _applyDecryptedBytes(bytes);
      if (openAfterDownload) {
        await _saveAndOpenExternally(bytes);
      }
    } on AttachmentExpiredException {
      if (mounted) {
        setState(() => _status = 'expired');
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _status = 'error';
          _errorMsg = e.toString().replaceFirst('Exception: ', '');
        });
      }
    }
  }

  Future<void> _saveAndOpenExternally(Uint8List bytes) async {
    try {
      final dir = await getTemporaryDirectory();
      final safeName = sanitizeAttachmentFilename(widget.attachment.name);
      final file = File('${dir.path}/$safeName');
      await file.writeAsBytes(bytes, flush: true);
      await OpenFilex.open(file.path);
    } catch (_) {}
  }

  Future<void> _toggleVoicePlayback() async {
    if (_decryptedBytes == null) return;
    if (_playing) {
      await _stopPlayback();
      return;
    }
    final durationMs = widget.attachment.durationMs ?? 3000;
    try {
      await widget.mediaChannel.invokeMethod('playWavBytes', {
        'bytes': _decryptedBytes!,
      });
    } catch (_) {}

    final startedAt = DateTime.now().millisecondsSinceEpoch;
    setState(() {
      _playing = true;
      _playElapsedMs = 0;
    });
    _playTimer?.cancel();
    _playTimer = Timer.periodic(const Duration(milliseconds: 80), (timer) {
      final elapsed = DateTime.now().millisecondsSinceEpoch - startedAt;
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (elapsed >= durationMs) {
        _stopPlayback();
      } else {
        setState(() => _playElapsedMs = elapsed);
      }
    });
  }

  Future<void> _toggleVideoNotePlayback() async {
    final note = _videoNote;
    if (note == null) return;
    if (_playing) {
      await _stopPlayback();
      return;
    }
    final durationMs = note.durationMs > 0
        ? note.durationMs
        : (widget.attachment.durationMs ?? 3000);
    if (note.wavBytes.isNotEmpty) {
      try {
        await widget.mediaChannel.invokeMethod('playWavBytes', {
          'bytes': note.wavBytes,
        });
      } catch (_) {}
    }

    final startedAt = DateTime.now().millisecondsSinceEpoch;
    setState(() {
      _playing = true;
      _playElapsedMs = 0;
      _currentFrameIdx = 0;
    });
    _playTimer?.cancel();
    _playTimer = Timer.periodic(const Duration(milliseconds: 35), (timer) {
      final elapsed = DateTime.now().millisecondsSinceEpoch - startedAt;
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (elapsed >= durationMs) {
        _stopPlayback();
        return;
      }
      int idx = 0;
      for (int i = 0; i < note.frames.length; i++) {
        if (note.frames[i].timestampMs <= elapsed) {
          idx = i;
        } else {
          break;
        }
      }
      setState(() {
        _playElapsedMs = elapsed;
        _currentFrameIdx = idx;
      });
    });
  }

  Future<void> _stopPlayback({bool silent = false}) async {
    _playTimer?.cancel();
    _playTimer = null;
    try {
      await widget.mediaChannel.invokeMethod('stopWavPlayback');
    } catch (_) {}
    if (!silent && mounted) {
      setState(() {
        _playing = false;
        _playElapsedMs = 0;
        _currentFrameIdx = 0;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final att = widget.attachment;
    const cardBg = Colors.white;
    const borderColor = Color(0xFFE2E8F0);
    const titleColor = Color(0xFF0F172A);
    const subColor = Color(0xFF64748B);

    if (_status == 'expired') {
      return Container(
        margin: const EdgeInsets.only(top: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFFFFFBEB),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: const Color(0xFFFDE68A)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.history_toggle_off,
                size: 18, color: Color(0xFFD97706)),
            const SizedBox(width: 8),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    att.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF92400E),
                      decoration: TextDecoration.lineThrough,
                    ),
                  ),
                  const SizedBox(height: 2),
                  const Text(
                    'Срок хранения истёк',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFFD97706),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    // Круглое видеосообщение (Видеокружок) — чистое круглое превью без прямоугольной рамки вокруг
    if (_status == 'ready' &&
        att.kind == 'video_note' &&
        _videoNote != null &&
        _videoNote!.frames.isNotEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: GestureDetector(
          onTap: _toggleVideoNotePlayback,
          child: SizedBox(
            width: 192,
            height: 192,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Container(
                  width: 192,
                  height: 192,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    boxShadow: const [
                      BoxShadow(
                        color: Colors.black12,
                        blurRadius: 10,
                        offset: Offset(0, 3),
                      ),
                    ],
                    border: Border.all(
                      color: _playing
                          ? const Color(0xFF10B981)
                          : const Color(0xFFE2E8F0),
                      width: 2.5,
                    ),
                  ),
                  child: ClipOval(
                    child: Image.memory(
                      _videoNote!
                          .frames[_currentFrameIdx.clamp(
                              0, _videoNote!.frames.length - 1)]
                          .jpegBytes,
                      fit: BoxFit.cover,
                      gaplessPlayback: true,
                    ),
                  ),
                ),
                if (!_playing)
                  Container(
                    width: 46,
                    height: 46,
                    decoration: const BoxDecoration(
                      color: Colors.black45,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.play_arrow_rounded,
                      color: Colors.white,
                      size: 30,
                    ),
                  ),
                Positioned(
                  bottom: 8,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.black54,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      _playing
                          ? AndroidAttachmentService.formatDurationMmSs(
                              _playElapsedMs)
                          : AndroidAttachmentService.formatDurationMmSs(
                              _videoNote!.durationMs > 0
                                  ? _videoNote!.durationMs
                                  : (att.durationMs ?? 0)),
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: borderColor),
        boxShadow: const [
          BoxShadow(
            color: Color(0x08000000),
            blurRadius: 6,
            offset: Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_status == 'loading') ...[
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    'Загрузка и расшифровка (${(_progress * 100).round()}%)…',
                    style: const TextStyle(fontSize: 11, color: subColor),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            LinearProgressIndicator(
              value: _progress.clamp(0.05, 1.0),
              minHeight: 4,
              borderRadius: BorderRadius.circular(4),
            ),
          ],
          if (_status == 'error') ...[
            Text(
              _errorMsg ?? 'Ошибка загрузки вложения',
              style: const TextStyle(fontSize: 11, color: Color(0xFFF43F5E)),
            ),
            const SizedBox(height: 6),
            SizedBox(
              height: 30,
              child: OutlinedButton.icon(
                onPressed: () => _loadAttachment(
                  openAfterDownload: att.kind == 'pdf' || att.kind == 'word',
                ),
                icon: const Icon(Icons.refresh, size: 14),
                label: const Text('Повторить', style: TextStyle(fontSize: 11)),
              ),
            ),
          ],
          if (_status == 'ready' &&
              att.kind == 'image' &&
              _decryptedBytes != null) ...[
            GestureDetector(
              onTap: () => _saveAndOpenExternally(_decryptedBytes!),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    maxHeight: 220,
                    maxWidth: 250,
                  ),
                  child: Image.memory(
                    _decryptedBytes!,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => const Padding(
                      padding: EdgeInsets.all(12),
                      child: Text(
                        'Не удалось отобразить изображение',
                        style: TextStyle(fontSize: 11, color: subColor),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 6),
          ],
          if (_status == 'ready' &&
              att.kind == 'voice' &&
              _decryptedBytes != null) ...[
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton.filled(
                  onPressed: _toggleVoicePlayback,
                  style: IconButton.styleFrom(
                    backgroundColor: const Color(0xFF4F46E5),
                    foregroundColor: Colors.white,
                    minimumSize: const Size(38, 38),
                  ),
                  icon: Icon(
                    _playing ? Icons.stop_rounded : Icons.play_arrow_rounded,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Голосовое сообщение',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: titleColor,
                        ),
                      ),
                      const SizedBox(height: 4),
                      LinearProgressIndicator(
                        value: (att.durationMs ?? 0) > 0
                            ? (_playElapsedMs / (att.durationMs ?? 1))
                                .clamp(0.0, 1.0)
                            : (_playing ? null : 0.0),
                        minHeight: 4,
                        borderRadius: BorderRadius.circular(4),
                        backgroundColor: const Color(0xFFF1F5F9),
                        color: const Color(0xFF4F46E5),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '${AndroidAttachmentService.formatDurationMmSs(_playing ? _playElapsedMs : (att.durationMs ?? 0))} · ${AndroidAttachmentService.formatBytesRu(att.plaintextSize)}',
                        style: const TextStyle(fontSize: 10, color: subColor),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ],
          if (att.kind == 'pdf' ||
              att.kind == 'word' ||
              att.kind == 'image') ...[
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  att.kind == 'pdf'
                      ? Icons.picture_as_pdf_outlined
                      : att.kind == 'word'
                          ? Icons.description_outlined
                          : Icons.image_outlined,
                  size: 20,
                  color: const Color(0xFF4F46E5),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        att.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: titleColor,
                        ),
                      ),
                      Text(
                        '${AndroidAttachmentService.formatBytesRu(att.plaintextSize)} · E2EE',
                        style: const TextStyle(fontSize: 10, color: subColor),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                TextButton.icon(
                  onPressed: _status == 'loading'
                      ? null
                      : () {
                          if (_decryptedBytes != null) {
                            _saveAndOpenExternally(_decryptedBytes!);
                          } else {
                            _loadAttachment(openAfterDownload: true);
                          }
                        },
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    foregroundColor: const Color(0xFF4F46E5),
                  ),
                  icon: Icon(
                    _decryptedBytes != null
                        ? Icons.open_in_new
                        : Icons.download_rounded,
                    size: 15,
                  ),
                  label: Text(
                    _decryptedBytes != null ? 'Открыть' : 'Скачать',
                    style: const TextStyle(fontSize: 11),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class OutgoingTransferCardWidget extends StatelessWidget {
  final OutgoingAttachmentTransfer transfer;
  final VoidCallback onCancel;
  final VoidCallback onRetry;

  const OutgoingTransferCardWidget({
    super.key,
    required this.transfer,
    required this.onCancel,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final isError = transfer.status == 'error';
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        constraints: const BoxConstraints(
          maxWidth: 280,
        ),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(
                  isError ? Icons.error_outline : Icons.cloud_upload_outlined,
                  color: isError
                      ? const Color(0xFFF43F5E)
                      : const Color(0xFF4F46E5),
                  size: 18,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    transfer.fileName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Color(0xFF0F172A),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  AndroidAttachmentService.formatBytesRu(
                      transfer.plaintextBytes.length),
                  style: const TextStyle(
                    color: Color(0xFF64748B),
                    fontSize: 10,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (!isError) ...[
              LinearProgressIndicator(
                value: transfer.progress.clamp(0.05, 1.0),
                minHeight: 5,
                borderRadius: BorderRadius.circular(4),
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Шифрование и отправка (${(transfer.progress * 100).round()}%)',
                    style: const TextStyle(
                      color: Color(0xFF64748B),
                      fontSize: 11,
                    ),
                  ),
                  TextButton(
                    onPressed: onCancel,
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: const Color(0xFFFDA4AF),
                    ),
                    child: const Text('Отмена', style: TextStyle(fontSize: 11)),
                  ),
                ],
              ),
            ] else ...[
              Text(
                transfer.errorMessage ?? 'Ошибка отправки файла',
                style: const TextStyle(
                  color: Color(0xFFFDA4AF),
                  fontSize: 11,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton.icon(
                    onPressed: onRetry,
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: const Color(0xFF38BDF8),
                    ),
                    icon: const Icon(Icons.refresh, size: 15),
                    label:
                        const Text('Повторить', style: TextStyle(fontSize: 11)),
                  ),
                  const SizedBox(width: 6),
                  TextButton(
                    onPressed: onCancel,
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: const Color(0xFF94A3B8),
                    ),
                    child: const Text('Убрать', style: TextStyle(fontSize: 11)),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
