import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'widgets/draggable_self_view.dart';
import 'widgets/archive_unlock_dialog.dart';
import 'widgets/storage_usage.dart';
import 'services/lesson_archive.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const LiaperMobileApp());
}

const String kCurrentAppVersion = '0.1.0';
const String kPlatformAndroid = 'android_arm64';

class LiaperMobileApp extends StatelessWidget {
  const LiaperMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Liaper',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.light,
        scaffoldBackgroundColor: const Color(0xFFF8FAFC),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF0F172A),
          brightness: Brightness.light,
          primary: const Color(0xFF0F172A),
          surface: Colors.white,
        ),
        useMaterial3: true,
        visualDensity: VisualDensity.standard,
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xFFF8FAFC),
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
        ),
      ),
      home: const LiaperHomeScreen(),
    );
  }
}

class ChatMessageItem {
  final String id;
  final String roomId;
  final String senderId;
  final String senderUsername;
  final String senderDisplayName;
  final String text;
  final String sentAt;

  ChatMessageItem({
    required this.id,
    required this.roomId,
    required this.senderId,
    required this.senderUsername,
    required this.senderDisplayName,
    required this.text,
    required this.sentAt,
  });
}

class LiaperHomeScreen extends StatefulWidget {
  const LiaperHomeScreen({super.key});

  @override
  State<LiaperHomeScreen> createState() => _LiaperHomeScreenState();
}

class _LiaperHomeScreenState extends State<LiaperHomeScreen> {
  static const MethodChannel _mediaChannel = MethodChannel('com.liaper.audio');

  String _serverUrl = 'http://127.0.0.1:4000';
  final TextEditingController _serverUrlCtrl =
      TextEditingController(text: 'http://127.0.0.1:4000');

  // Авторизация
  bool _isRegister = false;
  bool _showPassword = false;
  bool _identityReady = false;
  bool _sendingChat = false;
  bool _checkingUpdates = false;
  String _selectedRole = 'student';
  final TextEditingController _usernameCtrl = TextEditingController();
  final TextEditingController _displayNameCtrl = TextEditingController();
  final TextEditingController _passwordCtrl = TextEditingController();
  bool _authLoading = false;
  String? _authError;
  bool _showServerConfig = false;

  String? _token;
  Map<String, dynamic>? _currentUser;

  // Ключи идентификации (генерируются автоматически и прозрачно)
  String _publicKeyB64 = '';
  String _fingerprint = '';

  // Навигация
  int _selectedTabIndex = 0; // 0: Контакты, 1: Звонок, 2: Чат, 3: Профиль
  int _unreadChatCount = 0;

  // Состояние WebSocket и контактов
  WebSocketChannel? _wsChannel;
  bool _wsConnected = false;
  Timer? _reconnectTimer;
  int _reconnectFailures = 0;
  List<dynamic> _contacts = [];
  List<dynamic> _incomingRequests = [];
  List<dynamic> _outgoingRequests = [];
  Map<String, dynamic>? _currentRoom;
  Map<String, dynamic>? _incomingCall;

  // Поля контактов и комнат
  final TextEditingController _addContactCtrl = TextEditingController();
  final TextEditingController _searchContactCtrl = TextEditingController();
  final TextEditingController _inviteInCallCtrl = TextEditingController();

  // Чат урока, личные диалоги и архив уроков
  final TextEditingController _chatInputCtrl = TextEditingController();
  final ScrollController _chatScrollCtrl = ScrollController();
  final List<ChatMessageItem> _chatMessages = [];
  final Set<String> _seenMessageIds = {};
  String _chatMode = 'lesson'; // 'lesson' | 'direct' | 'archive'
  Map<String, dynamic>? _selectedChatContact;
  List<Map<String, dynamic>> _archivedChats = [];
  SecretKey? _archiveKey;
  bool _archiveSyncing = false;
  bool _archiveSyncAgain = false;
  String _archiveSyncStatus =
      'Для синхронизации разблокируйте архив паролем аккаунта';
  Timer? _archiveSaveTimer;

  // Локальная камера и микрофон + подключение к SFU-ноде
  final RTCVideoRenderer _localRenderer = RTCVideoRenderer();
  MediaStream? _localStream;
  bool _micEnabled = true;
  bool _camEnabled = false;
  bool _usingFrontCamera = true;
  bool _fitContain =
      true; // Удобно для просмотра демонстрации экрана по умолчанию
  String? _focusedPeerId;

  WebSocketChannel? _sfuChannel;
  String? _connectedSfuRoomId;
  Timer? _videoFrameTimer;
  Timer? _callDurationTimer;
  int _callSeconds = 0;
  bool _sendingFrame = false;
  final Map<String, Uint8List> _remoteVideoFrames = {};

  // Автообновление
  Map<String, dynamic>? _latestRelease;
  bool _updateAvailable = false;
  bool _downloadingApk = false;
  double _downloadProgress = 0.0;
  String? _statusMessage;

  @override
  void initState() {
    super.initState();
    _localRenderer.initialize();
    _mediaChannel.setMethodCallHandler((call) async {
      if (call.method == 'onPcm16Chunk') {
        final dynamic raw = call.arguments;
        if (raw is Uint8List) {
          _sendAudioPcmToSfu(raw);
        }
      }
    });
    _initIdentityAndSession();
  }

  @override
  void dispose() {
    _reconnectTimer?.cancel();
    _archiveSaveTimer?.cancel();
    _token = null;
    _mediaChannel.setMethodCallHandler(null);
    _stopLocalMediaAndSfu();
    _localRenderer.dispose();
    _wsChannel?.sink.close();
    _serverUrlCtrl.dispose();
    _usernameCtrl.dispose();
    _displayNameCtrl.dispose();
    _passwordCtrl.dispose();
    _addContactCtrl.dispose();
    _searchContactCtrl.dispose();
    _inviteInCallCtrl.dispose();
    _chatInputCtrl.dispose();
    _chatScrollCtrl.dispose();
    super.dispose();
  }

  // ===========================================================================
  // Прозрачное E2EE для чата (совместимое с Web/Desktop AES-256-GCM)
  // ===========================================================================
  String _computeDmRoomId(String u1, String u2) {
    final s1 = u1.toLowerCase();
    final s2 = u2.toLowerCase();
    final first = s1.compareTo(s2) <= 0 ? s1 : s2;
    final second = s1.compareTo(s2) <= 0 ? s2 : s1;
    if (first.length < 18 || second.length < 36) return u1;
    return '${first.substring(0, 18)}${second.substring(18, 36)}';
  }

  String? get _activeChatRoomId {
    if (_chatMode == 'lesson') return _currentRoom?['id']?.toString();
    if (_chatMode == 'direct' &&
        _selectedChatContact != null &&
        _currentUser != null) {
      return _computeDmRoomId(_currentUser!['id'].toString(),
          _selectedChatContact!['id'].toString());
    }
    return null;
  }

  String get _archiveStorageKey =>
      'liaper_chat_archives:${_currentUser?['id']}';

  Future<void> _loadUserArchives() async {
    final key = _archiveStorageKey;
    final prefs = await SharedPreferences.getInstance();
    List<Map<String, dynamic>> archives = [];
    try {
      final raw = jsonDecode(prefs.getString(key) ?? '[]') as List;
      archives = raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (_) {}
    if (mounted && key == _archiveStorageKey) {
      setState(() => _archivedChats = archives);
    }
  }

  Future<void> _syncArchives() async {
    final key = _archiveKey;
    final token = _token;
    final ownerId = _currentUser?['id']?.toString();
    if (key == null || token == null || ownerId == null) return;
    if (_archiveSyncing) {
      _archiveSyncAgain = true;
      return;
    }
    setState(() {
      _archiveSyncing = true;
      _archiveSyncStatus = 'Синхронизация…';
    });
    try {
      final remote = await syncLessonArchives(
          baseUrl: _serverUrl,
          token: token,
          key: key,
          userId: ownerId,
          local: List.of(_archivedChats));
      if (!mounted || _currentUser?['id'] != ownerId) return;
      final combined = mergeArchiveLists(remote, _archivedChats);
      setState(() {
        _archivedChats = combined;
        _archiveSyncStatus = 'Архив синхронизирован с сервером';
      });
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
          'liaper_chat_archives:$ownerId', jsonEncode(combined));
    } catch (error) {
      if (mounted && _currentUser?['id'] == ownerId) {
        setState(() => _archiveSyncStatus = error is ArchiveSyncException
            ? error.message
            : 'Не удалось синхронизировать архив. Проверьте подключение и пароль. Локальная копия сохранена.');
      }
    } finally {
      if (mounted && _currentUser?['id'] == ownerId) {
        setState(() => _archiveSyncing = false);
      }
      if (_archiveSyncAgain) {
        _archiveSyncAgain = false;
        if (mounted && _currentUser?['id'] == ownerId) _syncArchives();
      }
    }
  }

  Future<void> _unlockArchives() async {
    final ownerId = _currentUser?['id']?.toString();
    if (ownerId == null || _token == null) return;
    final password = await showDialog<String>(
        context: context, builder: (_) => const ArchiveUnlockDialog());
    if (!mounted || password == null || _currentUser?['id'] != ownerId) return;
    setState(() => _archiveSyncStatus = 'Разблокировка…');
    try {
      final response = await http
          .post(Uri.parse('$_serverUrl/api/lesson-archives/unlock'),
              headers: {
                'Authorization': 'Bearer $_token',
                'Content-Type': 'application/json'
              },
              body: jsonEncode({'password': password}))
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 204) {
        final data = jsonDecode(response.body) as Map;
        throw ArchiveSyncException(
            (data['error'] ?? 'Не удалось разблокировать архив').toString());
      }
      final key = await ArchiveCrypto.deriveKey(password, ownerId);
      if (!mounted || _currentUser?['id'] != ownerId) return;
      setState(() => _archiveKey = key);
      await _syncArchives();
    } catch (error) {
      if (mounted && _currentUser?['id'] == ownerId) {
        setState(() => _archiveSyncStatus = error is ArchiveSyncException
            ? error.message
            : 'Нет связи с сервером. Повторите попытку.');
      }
    }
  }

  SecretKey _deriveRoomSecretKey(String roomId) {
    final digest = sha256.convert(utf8.encode('liaper-room-e2ee-v1:$roomId'));
    return SecretKey(digest.bytes);
  }

  Future<Map<String, String>> _encryptChatText(
      String plaintext, String roomId) async {
    final algorithm = AesGcm.with256bits();
    final secretKey = _deriveRoomSecretKey(roomId);
    final nonce = algorithm.newNonce();
    final secretBox = await algorithm.encrypt(
      utf8.encode(plaintext),
      secretKey: secretKey,
      nonce: nonce,
    );
    final combined =
        Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length);
    combined.setRange(0, secretBox.cipherText.length, secretBox.cipherText);
    combined.setRange(
        secretBox.cipherText.length, combined.length, secretBox.mac.bytes);

    return {
      'ciphertext_b64': base64Encode(combined),
      'iv_b64': base64Encode(nonce),
      'room_key_id':
          'rk-${roomId.length >= 8 ? roomId.substring(0, 8) : roomId}',
    };
  }

  Future<String> _decryptChatText(
    String ciphertextB64,
    String ivB64,
    String roomId,
  ) async {
    try {
      final combined = base64Decode(ciphertextB64);
      final nonce = base64Decode(ivB64);
      if (combined.length < 16) return 'Не удалось расшифровать сообщение';

      final cipherText = combined.sublist(0, combined.length - 16);
      final macBytes = combined.sublist(combined.length - 16);
      final algorithm = AesGcm.with256bits();
      final secretKey = _deriveRoomSecretKey(roomId);

      final clearBytes = await algorithm.decrypt(
        SecretBox(cipherText, nonce: nonce, mac: Mac(macBytes)),
        secretKey: secretKey,
      );
      return utf8.decode(clearBytes);
    } catch (_) {
      return 'Не удалось расшифровать сообщение';
    }
  }

  Future<void> _handleIncomingEncryptedChat(Map<String, dynamic> rawMsg,
      {bool fromHistory = false}) async {
    final sessionToken = _token;
    final msgId = (rawMsg['id'] ?? '').toString();
    if (msgId.isNotEmpty && _seenMessageIds.contains(msgId)) return;
    if (msgId.isNotEmpty) _seenMessageIds.add(msgId);

    final roomId = (rawMsg['room_id'] ?? '').toString();
    final senderId = (rawMsg['sender_id'] ?? '').toString();
    final senderUsername = (rawMsg['sender_username'] ?? '').toString();
    final senderDisplayName =
        (rawMsg['sender_display_name'] ?? senderUsername).toString();
    final ciphertextB64 = (rawMsg['ciphertext_b64'] ?? '').toString();
    final ivB64 = (rawMsg['iv_b64'] ?? '').toString();
    final sentAt = (rawMsg['created_at'] ?? rawMsg['sent_at'] ?? '').toString();

    final decrypted = await _decryptChatText(ciphertextB64, ivB64, roomId);
    if (!mounted || sessionToken != _token) return;

    setState(() {
      _chatMessages.add(
        ChatMessageItem(
          id: msgId,
          roomId: roomId,
          senderId: senderId,
          senderUsername: senderUsername,
          senderDisplayName: senderDisplayName,
          text: decrypted,
          sentAt: sentAt,
        ),
      );
      if (!fromHistory &&
          senderId != _currentUser?['id'] &&
          (_selectedTabIndex != 2 || _activeChatRoomId != roomId)) {
        _unreadChatCount++;
      }
    });

    if (_currentRoom?['id'] == roomId) {
      _archiveSaveTimer?.cancel();
      _archiveSaveTimer = Timer(const Duration(seconds: 1), () {
        if (mounted && _currentRoom?['id'] == roomId) {
          _saveCurrentLessonToArchive(
              showNotification: false, completed: false);
        }
      });
    }
    Future.delayed(const Duration(milliseconds: 100), () {
      if (mounted &&
          _chatScrollCtrl.hasClients &&
          _activeChatRoomId == roomId) {
        _chatScrollCtrl.animateTo(
          _chatScrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _sendChatMessage() async {
    final targetRoomId = _activeChatRoomId;
    final text = _chatInputCtrl.text;
    final sessionToken = _token;
    if (targetRoomId == null ||
        text.trim().isEmpty ||
        _sendingChat ||
        !_wsConnected) {
      return;
    }
    setState(() => _sendingChat = true);
    try {
      final encrypted = await _encryptChatText(text.trim(), targetRoomId);
      if (!mounted || _token != sessionToken) return;
      final sent = _sendWs({
        'type': 'send_encrypted_chat',
        'payload': {
          'room_id': targetRoomId,
          'ciphertext_b64': encrypted['ciphertext_b64'],
          'iv_b64': encrypted['iv_b64'],
          'room_key_id': encrypted['room_key_id'],
        },
      });
      if (sent && _chatInputCtrl.text == text) _chatInputCtrl.clear();
    } catch (_) {
      if (mounted) {
        setState(() => _statusMessage =
            'Сообщение не отправлено. Текст сохранён в поле ввода.');
      }
    } finally {
      if (mounted) setState(() => _sendingChat = false);
    }
  }

  Future<void> _saveCurrentLessonToArchive(
      {bool showNotification = true, bool completed = true}) async {
    if (_currentRoom == null) return;
    final archiveKey = _archiveStorageKey;
    final roomId = _currentRoom!['id'].toString();
    final roomTitle = (_currentRoom!['title'] ?? 'Урок').toString();
    final roomMsgs = _chatMessages.where((m) => m.roomId == roomId).toList();
    final entry = {
      'id': roomId,
      'title': roomTitle,
      'savedAt': DateTime.now().toUtc().toIso8601String(),
      'startedAt': _currentRoom!['created_at'],
      if (completed) 'endedAt': DateTime.now().toUtc().toIso8601String(),
      'messages': roomMsgs
          .map((m) => {
                'id': m.id,
                'time': DateTime.tryParse(m.sentAt)
                        ?.toLocal()
                        .toString()
                        .substring(11, 16) ??
                    '',
                'sender': m.senderDisplayName,
                'username': m.senderUsername,
                'text': m.text,
                'sentAt': m.sentAt,
              })
          .toList(),
    };

    setState(() {
      _archivedChats = mergeArchiveLists(_archivedChats, [entry]);
      if (showNotification) {
        _statusMessage = 'Чат урока «$roomTitle» сохранён в архив';
      }
    });

    final archiveJson = jsonEncode(_archivedChats);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(archiveKey, archiveJson);
    if (mounted) _syncArchives();
  }

  // ===========================================================================
  // Управление камерой, микрофоном и SFU Media Node
  // ===========================================================================
  Future<void> _ensureRoomMediaConnected(Map<String, dynamic> room) async {
    final roomId = room['id'] as String;
    if (_connectedSfuRoomId == roomId && _sfuChannel != null) {
      return;
    }

    await _stopLocalMediaAndSfu();
    if (!mounted || _currentRoom?['id'] != roomId) return;
    _connectedSfuRoomId = roomId;

    _callSeconds = 0;
    _callDurationTimer?.cancel();
    _callDurationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) {
        setState(() {
          _callSeconds++;
        });
      }
    });

    await _startLocalMedia(withAudio: _micEnabled, withVideo: _camEnabled);
    if (!mounted || _currentRoom?['id'] != roomId) return;
    _connectToSfuNode(room);
  }

  Future<void> _startLocalMedia({
    required bool withAudio,
    required bool withVideo,
  }) async {
    try {
      await _mediaChannel.invokeMethod('startAudio');
      await _mediaChannel.invokeMethod('setMicMute', {'micEnabled': withAudio});
    } catch (_) {}

    try {
      if (withVideo) {
        final stream = await navigator.mediaDevices.getUserMedia({
          'audio': false,
          'video': {
            'facingMode': _usingFrontCamera ? 'user' : 'environment',
            'width': {'ideal': 1280},
            'height': {'ideal': 720},
          },
        });
        if (!mounted || _currentRoom == null) {
          for (final track in stream.getTracks()) {
            track.stop();
          }
          await stream.dispose();
          return;
        }
        for (final track in _localStream?.getTracks() ?? <MediaStreamTrack>[]) {
          track.stop();
        }
        await _localStream?.dispose();
        _localStream = stream;
        _localRenderer.srcObject = stream;
      } else {
        for (final track in _localStream?.getTracks() ?? <MediaStreamTrack>[]) {
          track.stop();
        }
        await _localStream?.dispose();
        _localStream = null;
        _localRenderer.srcObject = null;
      }
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) {
        setState(() {
          _camEnabled = false;
          _statusMessage =
              'Не удалось получить доступ к камере. Проверьте разрешения приложения.';
        });
      }
    }
  }

  Future<void> _switchCameraDirection() async {
    if (_localStream == null || !_camEnabled) return;
    final videoTracks = _localStream!.getVideoTracks();
    if (videoTracks.isEmpty) return;
    try {
      await Helper.switchCamera(videoTracks.first);
      setState(() {
        _usingFrontCamera = !_usingFrontCamera;
      });
    } catch (_) {}
  }

  String _resolveSfuWsUrl(String rawWsUrl) {
    try {
      final serverUri = Uri.parse(_serverUrl);
      final nodeUri = Uri.parse(rawWsUrl);
      if ((nodeUri.host == '127.0.0.1' || nodeUri.host == 'localhost') &&
          serverUri.host.isNotEmpty &&
          serverUri.host != '127.0.0.1' &&
          serverUri.host != 'localhost') {
        return nodeUri.replace(host: serverUri.host).toString();
      }
    } catch (_) {}
    return rawWsUrl;
  }

  void _connectToSfuNode(Map<String, dynamic> room) {
    final assignedNode = room['assigned_node'] as Map<String, dynamic>?;
    if (assignedNode == null || _currentUser == null) return;

    final rawWsUrl = assignedNode['ws_url'] as String;
    final wsUrl = _resolveSfuWsUrl(rawWsUrl);
    final roomId = room['id'] as String;

    try {
      _sfuChannel?.sink.close();
      final channel = WebSocketChannel.connect(Uri.parse(wsUrl));
      _sfuChannel = channel;

      channel.sink.add(
        jsonEncode({
          'type': 'join_sfu_room',
          'payload': {
            'room_id': roomId,
            'user_id': _currentUser!['id'],
            'username': _currentUser!['username'],
            'display_name': _currentUser!['display_name'],
            'e2ee_enabled': true,
            'room_key_id': 'AES256',
          },
        }),
      );

      channel.stream.listen(
        (raw) {
          try {
            final msg = jsonDecode(raw as String) as Map<String, dynamic>;
            final type = msg['type'] as String?;
            final payload = msg['payload'] as Map<String, dynamic>?;

            if (type == 'relayed_encrypted_media_frame' && payload != null) {
              final senderId = payload['from_peer_id'] as String?;
              if (senderId == null || senderId == _currentUser?['id']) return;

              final kind = payload['kind'] as String?;
              final cipherB64 = payload['ciphertext_b64'] as String?;
              if (cipherB64 == null) return;

              final bytes = base64Decode(cipherB64);
              if (kind == 'video_jpeg' || kind == 'video') {
                if (mounted) {
                  setState(() {
                    _remoteVideoFrames[senderId] = bytes;
                  });
                }
              } else if (kind == 'audio_pcm16') {
                _mediaChannel.invokeMethod('playPcm16', {'bytes': bytes});
              }
            } else if (type == 'peer_left_sfu' && payload != null) {
              final peerId = payload['user_id'] as String?;
              if (peerId != null && mounted) {
                setState(() {
                  _remoteVideoFrames.remove(peerId);
                });
              }
            }
          } catch (_) {}
        },
        onDone: () {
          if (mounted &&
              _currentRoom != null &&
              _connectedSfuRoomId == room['id']) {
            Future.delayed(const Duration(seconds: 2), () {
              if (mounted &&
                  _currentRoom != null &&
                  _connectedSfuRoomId == room['id']) {
                _connectToSfuNode(_currentRoom!);
              }
            });
          }
        },
      );

      _videoFrameTimer?.cancel();
      // ~15 FPS (65 мс) для плавной передачи 720p видео с телефона
      _videoFrameTimer = Timer.periodic(
        const Duration(milliseconds: 65),
        (_) => _captureAndSendVideoFrame(),
      );
    } catch (_) {}
  }

  void _sendAudioPcmToSfu(Uint8List pcmBytes) {
    if (!_micEnabled ||
        _sfuChannel == null ||
        _currentRoom == null ||
        _currentUser == null) {
      return;
    }

    try {
      final b64 = base64Encode(pcmBytes);
      final iv = base64Encode(
          utf8.encode('aud-${DateTime.now().millisecondsSinceEpoch}'));
      _sfuChannel?.sink.add(
        jsonEncode({
          'type': 'encrypted_media_frame',
          'payload': {
            'room_id': _currentRoom!['id'],
            'kind': 'audio_pcm16',
            'ciphertext_b64': b64,
            'iv_b64': iv,
            'room_key_id': 'AES256',
            'timestamp_ms': DateTime.now().millisecondsSinceEpoch,
          },
        }),
      );
    } catch (_) {}
  }

  Future<void> _captureAndSendVideoFrame() async {
    if (_sendingFrame ||
        !_camEnabled ||
        _localStream == null ||
        _sfuChannel == null ||
        _currentRoom == null ||
        _currentUser == null) {
      return;
    }

    final videoTracks = _localStream!.getVideoTracks();
    if (videoTracks.isEmpty) return;

    _sendingFrame = true;
    try {
      final byteBuffer = await videoTracks.first.captureFrame();
      final rawBytes = byteBuffer.asUint8List();

      Uint8List bytesToSend = rawBytes;
      try {
        final compressed = await _mediaChannel.invokeMethod<Uint8List>(
          'compressFrame',
          {'bytes': rawBytes},
        );
        if (compressed != null && compressed.isNotEmpty) {
          bytesToSend = compressed;
        }
      } catch (_) {}

      final b64 = base64Encode(bytesToSend);
      final iv = base64Encode(
          utf8.encode('vid-${DateTime.now().millisecondsSinceEpoch}'));

      _sfuChannel?.sink.add(
        jsonEncode({
          'type': 'encrypted_media_frame',
          'payload': {
            'room_id': _currentRoom!['id'],
            'kind': 'video_jpeg',
            'ciphertext_b64': b64,
            'iv_b64': iv,
            'room_key_id': 'AES256',
            'timestamp_ms': DateTime.now().millisecondsSinceEpoch,
          },
        }),
      );
    } catch (_) {
    } finally {
      _sendingFrame = false;
    }
  }

  Future<void> _stopLocalMediaAndSfu() async {
    _videoFrameTimer?.cancel();
    _videoFrameTimer = null;
    _callDurationTimer?.cancel();
    _callDurationTimer = null;
    _callSeconds = 0;
    if (_sfuChannel != null && _connectedSfuRoomId != null) {
      try {
        _sfuChannel?.sink.add(
          jsonEncode({
            'type': 'leave_sfu_room',
            'payload': {'room_id': _connectedSfuRoomId},
          }),
        );
      } catch (_) {}
    }
    _sfuChannel?.sink.close();
    _sfuChannel = null;
    _connectedSfuRoomId = null;
    _remoteVideoFrames.clear();

    try {
      await _mediaChannel.invokeMethod('stopAudio');
    } catch (_) {}

    try {
      final stream = _localStream;
      _localStream = null;
      _localRenderer.srcObject = null;
      if (stream != null) {
        for (final track in stream.getTracks()) {
          track.stop();
        }
        await stream.dispose();
      }
    } catch (_) {}
  }

  void _toggleMic() {
    setState(() {
      _micEnabled = !_micEnabled;
    });
    _mediaChannel.invokeMethod('setMicMute', {'micEnabled': _micEnabled});

    if (_currentRoom != null) {
      _sendWs({
        'type': 'update_media_state',
        'payload': {
          'room_id': _currentRoom!['id'],
          'audio_enabled': _micEnabled,
          'video_enabled': _camEnabled,
          'screen_share_enabled': false,
          'speaking': false,
        },
      });
    }
  }

  Future<void> _toggleCamera() async {
    final nextCam = !_camEnabled;
    setState(() {
      _camEnabled = nextCam;
    });

    if (_currentRoom != null) {
      await _startLocalMedia(withAudio: _micEnabled, withVideo: nextCam);
      _sendWs({
        'type': 'update_media_state',
        'payload': {
          'room_id': _currentRoom!['id'],
          'audio_enabled': _micEnabled,
          'video_enabled': _camEnabled,
          'screen_share_enabled': false,
          'speaking': false,
        },
      });
    }
  }

  // ===========================================================================
  // Инициализация сессии и подключение к серверу управления
  // ===========================================================================
  Future<void> _initIdentityAndSession() async {
    final prefs = await SharedPreferences.getInstance();
    final savedUrl = prefs.getString('liaper_server_url');
    if (savedUrl != null && savedUrl.isNotEmpty) {
      _serverUrl = savedUrl;
      _serverUrlCtrl.text = savedUrl;
    }

    String? pubKey = prefs.getString('liaper_pub_key');
    String? fp = prefs.getString('liaper_fp');

    if (pubKey == null || fp == null) {
      final algorithm = X25519();
      final keyPair = await algorithm.newKeyPair();
      final pub = await keyPair.extractPublicKey();
      pubKey = base64Encode(pub.bytes);

      final digest = sha256.convert(pub.bytes).bytes;
      fp = digest
          .take(8)
          .map((b) => b.toRadixString(16).padLeft(2, '0').toUpperCase())
          .join(':');

      await prefs.setString('liaper_pub_key', pubKey);
      await prefs.setString('liaper_fp', fp);
    }

    Map<String, dynamic>? savedUser;
    try {
      final rawUser = prefs.getString('liaper_user');
      if (rawUser != null) {
        savedUser = jsonDecode(rawUser) as Map<String, dynamic>;
      }
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _publicKeyB64 = pubKey!;
      _fingerprint = fp!;
      _identityReady = true;
      _token = savedUser == null ? null : prefs.getString('liaper_token');
      _currentUser = savedUser;
    });
    await _loadUserArchives();
    if (!mounted) return;
    if (_token != null) _connectWebSocket();
  }

  void _scheduleReconnect(WebSocketChannel channel) {
    if (!mounted || _token == null || _wsChannel != channel) return;
    setState(() => _wsConnected = false);
    _reconnectTimer?.cancel();
    final seconds = (2 * (1 << _reconnectFailures.clamp(0, 3))).clamp(2, 16);
    _reconnectFailures++;
    _reconnectTimer = Timer(Duration(seconds: seconds), _connectWebSocket);
  }

  void _connectWebSocket() {
    if (_token == null || !mounted) return;
    _reconnectTimer?.cancel();
    final previous = _wsChannel;
    _wsChannel = null;
    previous?.sink.close();
    final wsUri = Uri.parse(
      '${_serverUrl.replaceFirst(RegExp(r'^http'), 'ws')}/ws?token=${Uri.encodeComponent(_token!)}',
    );
    final channel = WebSocketChannel.connect(wsUri);
    _wsChannel = channel;
    channel.stream.listen(
      (message) {
        if (!mounted || _wsChannel != channel) return;
        try {
          final data = jsonDecode(message as String) as Map<String, dynamic>;
          _handleServerMessage(data);
        } catch (_) {}
      },
      onDone: () => _scheduleReconnect(channel),
      onError: (_) => _scheduleReconnect(channel),
    );
  }

  void _handleServerMessage(Map<String, dynamic> msg) {
    final type = msg['type'] as String?;
    final payload = msg['payload'] as Map<String, dynamic>?;

    if (!mounted) return;

    switch (type) {
      case 'welcome':
        _reconnectFailures = 0;
        setState(() {
          _wsConnected = true;
          _currentUser = payload?['self_profile'] as Map<String, dynamic>?;
          _contacts = (payload?['contacts'] as List<dynamic>?) ?? [];
          _incomingRequests =
              (payload?['incoming_requests'] as List<dynamic>?) ?? [];
          _outgoingRequests =
              (payload?['outgoing_requests'] as List<dynamic>?) ?? [];
        });
        _syncArchives();
        break;

      case 'contacts_updated':
        setState(() {
          _contacts = (payload?['contacts'] as List<dynamic>?) ?? [];
          _incomingRequests =
              (payload?['incoming_requests'] as List<dynamic>?) ?? [];
          _outgoingRequests =
              (payload?['outgoing_requests'] as List<dynamic>?) ?? [];
        });
        break;

      case 'room_updated':
        final room = payload?['room'] as Map<String, dynamic>?;
        final wasInRoom =
            _currentRoom != null && _currentRoom!['id'] == room?['id'];
        setState(() {
          _currentRoom = room;
          _incomingCall = null;
          if (!wasInRoom && room != null) {
            _chatMode = 'lesson';
            _selectedTabIndex =
                1; // Переключаем на экран звонка при старте урока
          }
        });
        if (room != null) {
          _ensureRoomMediaConnected(room);
          if (!wasInRoom) {
            _saveCurrentLessonToArchive(
                showNotification: false, completed: false);
          }
        }
        break;

      case 'incoming_call':
        setState(() {
          _incomingCall = payload;
        });
        break;

      case 'call_declined':
        setState(() {
          _statusMessage =
              'Пользователь @${payload?['declined_by']} отклонил звонок';
        });
        break;

      case 'encrypted_chat_received':
        final rawMsg = payload?['message'] as Map<String, dynamic>?;
        if (rawMsg != null) {
          _handleIncomingEncryptedChat(rawMsg);
        }
        break;

      case 'room_chat_history':
        final list = (payload?['messages'] as List<dynamic>?) ?? [];
        for (final item in list) {
          if (item is Map<String, dynamic>) {
            _handleIncomingEncryptedChat(item, fromHistory: true);
          }
        }
        break;

      case 'error':
        setState(() {
          _statusMessage = payload?['message'] as String?;
        });
        break;
    }
  }

  bool _sendWs(Map<String, dynamic> data) {
    if (!_wsConnected || _wsChannel == null) {
      if (mounted) {
        setState(() => _statusMessage =
            'Нет связи с сервером. Дождитесь подключения и повторите действие.');
      }
      return false;
    }
    _wsChannel!.sink.add(jsonEncode(data));
    return true;
  }

  Future<void> _submitAuth() async {
    if (_authLoading || !_identityReady) return;
    final username = _usernameCtrl.text.trim().replaceFirst(RegExp(r'^@'), '');
    final server = _serverUrlCtrl.text.trim().replaceFirst(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(server);
    String? error;
    if (username.isEmpty || _passwordCtrl.text.isEmpty) {
      error = 'Введите никнейм и пароль.';
    } else if (_isRegister && _passwordCtrl.text.length < 4) {
      error = 'Пароль должен содержать не менее 4 символов.';
    } else if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      error = 'Укажите адрес сервера, например https://lessons.example.ru';
    }
    if (error != null) {
      setState(() => _authError = error);
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _authLoading = true;
      _authError = null;
      _serverUrl = server;
    });

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('liaper_server_url', _serverUrl);

    try {
      final endpoint = _isRegister ? '/api/auth/register' : '/api/auth/login';
      final body = _isRegister
          ? {
              'username': username,
              'display_name': _displayNameCtrl.text.trim().isEmpty
                  ? _usernameCtrl.text.trim()
                  : _displayNameCtrl.text.trim(),
              'password': _passwordCtrl.text,
              'role': _selectedRole,
              'e2ee_public_key': _publicKeyB64,
              'key_fingerprint': _fingerprint,
            }
          : {
              'username': username,
              'password': _passwordCtrl.text,
              'e2ee_public_key': _publicKeyB64,
              'key_fingerprint': _fingerprint,
            };

      final res = await http
          .post(
            Uri.parse('$_serverUrl$endpoint'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 8));

      if (!mounted) return;
      final json = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode >= 400) {
        setState(() {
          _authError = (json['error'] ?? 'Ошибка авторизации').toString();
          _authLoading = false;
        });
        return;
      }

      final token = json['token'] as String;
      final user = json['user'] as Map<String, dynamic>;

      await prefs.setString('liaper_token', token);
      await prefs.setString('liaper_user', jsonEncode(user));

      if (!mounted) return;
      final archiveKey = await ArchiveCrypto.deriveKey(
          _passwordCtrl.text, user['id'].toString());
      if (!mounted) return;
      _passwordCtrl.clear();
      setState(() {
        _archiveKey = archiveKey;
        _token = token;
        _currentUser = user;
        _authLoading = false;
      });

      await _loadUserArchives();
      if (mounted) _connectWebSocket();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _authError =
            'Нет связи с сервером ($_serverUrl). Проверьте подключение.';
        _authLoading = false;
      });
    }
  }

  Future<void> _logout() async {
    if (_currentRoom != null) {
      await _saveCurrentLessonToArchive(showNotification: false);
    }
    _archiveKey = null;
    _archiveSyncing = false;
    _archiveSyncAgain = false;
    _archiveSyncStatus =
        'Для синхронизации разблокируйте архив паролем аккаунта';
    _reconnectTimer?.cancel();
    _archiveSaveTimer?.cancel();
    _token = null;
    _wsConnected = false;
    await _stopLocalMediaAndSfu();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('liaper_token');
    await prefs.remove('liaper_user');
    _wsChannel?.sink.close();
    if (!mounted) return;
    setState(() {
      _token = null;
      _currentUser = null;
      _selectedTabIndex = 0;
      _selectedChatContact = null;
      _incomingCall = null;
      _contacts = [];
      _incomingRequests = [];
      _outgoingRequests = [];
      _archivedChats = [];
      _unreadChatCount = 0;
      _statusMessage = null;
      _chatInputCtrl.clear();
      _passwordCtrl.clear();
      _currentRoom = null;
      _chatMessages.clear();
      _seenMessageIds.clear();
    });
  }

  // ===========================================================================
  // Действия с контактами и звонками
  // ===========================================================================
  void _sendContactRequest() {
    if (_currentUser?['role'] != 'tutor' ||
        _contacts.where((u) => u['role'] == 'student').length >= 10) {
      return;
    }
    final nick = _addContactCtrl.text.trim().replaceAll('@', '');
    if (nick.isEmpty) return;
    if (!_sendWs({
      'type': 'send_contact_request',
      'payload': {'target_username': nick},
    })) {
      return;
    }
    _addContactCtrl.clear();
    setState(() {
      _statusMessage = 'Запрос в контакты отправлен @$nick';
    });
  }

  void _respondContactRequest(String requestId, bool accept) {
    _sendWs({
      'type': 'respond_contact_request',
      'payload': {
        'request_id': requestId,
        'accept': accept,
      },
    });
  }

  Future<void> _removeContact(String contactUserId, String username) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
              title: const Text('Удалить контакт?'),
              content: Text(
                  'Для новых звонков и сообщений с @$username потребуется снова обменяться заявками.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Отмена')),
                TextButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('Удалить')),
              ],
            ));
    if (confirmed != true || !mounted) return;
    if (!_sendWs({
      'type': 'remove_contact',
      'payload': {'contact_user_id': contactUserId},
    })) {
      return;
    }
    setState(() {
      _statusMessage = 'Запрос на удаление контакта отправлен';
      if (_selectedChatContact?['id'] == contactUserId) {
        _selectedChatContact = null;
      }
    });
  }

  void _callByNick(String username, {bool withVideo = true}) {
    final clean = username.trim().replaceAll('@', '');
    if (clean.isEmpty || !_wsConnected || _currentRoom != null) return;
    setState(() {
      _micEnabled = true;
      _camEnabled = withVideo;
    });
    _sendWs({
      'type': 'call_by_nick',
      'payload': {
        'target_username': clean,
        'with_video': withVideo,
      },
    });
  }

  void _leaveCurrentRoom() {
    if (_currentRoom == null) return;
    _saveCurrentLessonToArchive(showNotification: true);
    _sendWs({
      'type': 'leave_room',
      'payload': {'room_id': _currentRoom!['id']},
    });
    _stopLocalMediaAndSfu();
    setState(() {
      _currentRoom = null;
      _selectedTabIndex = 0;
    });
  }

  void _showCreateGroupDialog() {
    if (!_wsConnected || _currentRoom != null) return;
    final titleCtrl = TextEditingController();
    final selectedNicks = <String>{};

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 24,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Создать групповой урок',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                      IconButton(
                        onPressed: () => Navigator.pop(ctx),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: titleCtrl,
                    decoration: InputDecoration(
                      labelText: 'Название урока',
                      hintText: 'Математика — подготовка к ЕГЭ',
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Выберите участников из ваших контактов:',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF475569),
                    ),
                  ),
                  const SizedBox(height: 8),
                  if (_contacts.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Text(
                        'Сначала добавьте участников во взаимные контакты.',
                        style:
                            TextStyle(color: Color(0xFF64748B), fontSize: 13),
                      ),
                    )
                  else
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 220),
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: _contacts.length,
                        itemBuilder: (_, i) {
                          final u = _contacts[i] as Map<String, dynamic>;
                          final nick = u['username'] as String;
                          final checked = selectedNicks.contains(nick);
                          return CheckboxListTile(
                            value: checked,
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            activeColor: const Color(0xFF0F172A),
                            title: Text(
                              '${u['display_name']} (@$nick)',
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                            subtitle: Text(
                              u['role'] == 'tutor' ? 'Репетитор' : 'Ученик',
                              style: const TextStyle(fontSize: 12),
                            ),
                            onChanged: (val) {
                              setModalState(() {
                                if (val == true) {
                                  selectedNicks.add(nick);
                                } else {
                                  selectedNicks.remove(nick);
                                }
                              });
                            },
                          );
                        },
                      ),
                    ),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: () {
                      final title = titleCtrl.text.trim().isEmpty
                          ? 'Групповой урок'
                          : titleCtrl.text.trim();
                      _sendWs({
                        'type': 'create_room',
                        'payload': {
                          'title': title,
                          'is_group': true,
                          'invited_usernames': selectedNicks.toList(),
                        },
                      });
                      Navigator.pop(ctx);
                    },
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    icon: const Icon(Icons.groups_outlined),
                    label: const Text('Начать групповой звонок'),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  // ===========================================================================
  // Автообновление APK
  // ===========================================================================
  Future<void> _checkForUpdates() async {
    if (_checkingUpdates) return;
    setState(() => _checkingUpdates = true);
    try {
      final uri = Uri.parse(
          '$_serverUrl/api/releases/check?platform=$kPlatformAndroid&version=$kCurrentAppVersion');
      final res = await http.get(uri).timeout(const Duration(seconds: 6));
      if (res.statusCode != 200) {
        throw const HttpException('Update check failed');
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _updateAvailable = data['update_available'] == true;
        _latestRelease = data['latest'] as Map<String, dynamic>?;
        _statusMessage = _updateAvailable
            ? 'Доступна новая версия приложения'
            : 'Установлена последняя версия';
      });
    } catch (_) {
      if (mounted) {
        setState(() => _statusMessage =
            'Не удалось проверить обновления. Повторите попытку позже.');
      }
    } finally {
      if (mounted) setState(() => _checkingUpdates = false);
    }
  }

  Future<void> _downloadAndInstallApk() async {
    if (_latestRelease == null) return;
    final downloadUrl = _latestRelease!['download_url'] as String;
    final expectedSha256 = (_latestRelease!['sha256'] as String).toLowerCase();
    final version = _latestRelease!['version'] as String;
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedSha256)) {
      setState(() => _statusMessage =
          'Обновление недоступно: сервер не предоставил контрольную сумму файла.');
      return;
    }

    setState(() {
      _downloadingApk = true;
      _downloadProgress = 0.1;
      _statusMessage = 'Скачивание обновления v$version...';
    });

    try {
      final client = http.Client();
      final req = http.Request('GET', Uri.parse(downloadUrl));
      final streamedRes = await client.send(req);

      final totalBytes = streamedRes.contentLength ?? 0;
      int receivedBytes = 0;
      final List<int> bytes = [];

      await for (final chunk in streamedRes.stream) {
        bytes.addAll(chunk);
        receivedBytes += chunk.length;
        if (totalBytes > 0 && mounted) {
          setState(() {
            _downloadProgress = receivedBytes / totalBytes;
          });
        }
      }

      final actualSha256 = sha256.convert(bytes).toString().toLowerCase();
      if (actualSha256 != expectedSha256) {
        setState(() {
          _downloadingApk = false;
          _statusMessage = 'Ошибка проверки контрольной суммы SHA-256';
        });
        return;
      }

      final dir = await getTemporaryDirectory();
      final apkFile = File('${dir.path}/liaper-v$version.apk');
      await apkFile.writeAsBytes(bytes, flush: true);

      setState(() {
        _downloadingApk = false;
        _statusMessage = 'Обновление v$version готово к установке';
      });

      await OpenFilex.open(apkFile.path);
    } catch (e) {
      setState(() {
        _downloadingApk = false;
        _statusMessage = 'Не удалось скачать APK: $e';
      });
    }
  }

  String _formatCallDuration(int totalSeconds) {
    final mins = (totalSeconds ~/ 60).toString().padLeft(2, '0');
    final secs = (totalSeconds % 60).toString().padLeft(2, '0');
    return '$mins:$secs';
  }

  // ===========================================================================
  // Главный метод отрисовки
  // ===========================================================================
  @override
  Widget build(BuildContext context) {
    if (_token == null || _currentUser == null) {
      return _buildAuthScreen();
    }

    final isInCallTab = _selectedTabIndex == 1 && _currentRoom != null;

    return PopScope(
      canPop: _currentRoom == null && _selectedTabIndex == 0,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        if (_selectedTabIndex != 0) {
          setState(() => _selectedTabIndex = 0);
        } else {
          setState(() => _statusMessage =
              'Урок продолжается. Чтобы выйти из него, нажмите «Выйти» на экране урока.');
        }
      },
      child: Scaffold(
        backgroundColor:
            isInCallTab ? const Color(0xFF0F172A) : const Color(0xFFF8FAFC),
        appBar: isInCallTab
            ? null
            : AppBar(
                backgroundColor: Colors.white,
                surfaceTintColor: Colors.white,
                elevation: 0,
                titleSpacing: 16,
                title: Row(
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: const Color(0xFF0F172A),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      alignment: Alignment.center,
                      child: const Text(
                        'L',
                        style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w700,
                          fontSize: 15,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Liaper',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF0F172A),
                            ),
                          ),
                          Row(
                            children: [
                              Container(
                                width: 7,
                                height: 7,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: _wsConnected
                                      ? const Color(0xFF10B981)
                                      : const Color(0xFFF43F5E),
                                ),
                              ),
                              const SizedBox(width: 5),
                              Flexible(
                                child: Text(
                                  '@${_currentUser!['username']} · ${_currentUser!['role'] == 'tutor' ? 'Репетитор' : 'Ученик'}',
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Color(0xFF64748B),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                actions: [
                  if (_currentRoom != null)
                    Padding(
                      padding: const EdgeInsets.only(right: 12),
                      child: FilledButton.tonalIcon(
                        onPressed: () {
                          setState(() {
                            _selectedTabIndex = 1;
                          });
                        },
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFFDCFCE7),
                          foregroundColor: const Color(0xFF047857),
                          visualDensity: VisualDensity.compact,
                        ),
                        icon: const Icon(Icons.call, size: 16),
                        label: Text(_formatCallDuration(_callSeconds)),
                      ),
                    ),
                ],
                bottom: PreferredSize(
                  preferredSize: const Size.fromHeight(1),
                  child: Container(height: 1, color: const Color(0xFFE2E8F0)),
                ),
              ),
        body: SafeArea(
          child: Column(
            children: [
              if (!_wsConnected)
                MaterialBanner(
                  content: const Text('Нет связи. Переподключаемся…'),
                  leading: const Icon(Icons.wifi_off, size: 20),
                  actions: [
                    TextButton(
                        onPressed: _connectWebSocket,
                        child: const Text('Повторить')),
                    TextButton(
                        onPressed: _logout, child: const Text('Войти заново')),
                  ],
                ),
              // Уведомление или статус
              if (_statusMessage != null)
                Container(
                  margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF1E293B),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _statusMessage!,
                          style: const TextStyle(
                              color: Colors.white, fontSize: 12),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Закрыть уведомление',
                        onPressed: () => setState(() => _statusMessage = null),
                        icon: const Icon(Icons.close,
                            size: 20, color: Colors.white70),
                      ),
                    ],
                  ),
                ),

              // Глобальное окно входящего звонка
              if (_incomingCall != null) _buildIncomingCallBanner(),

              // Основное содержимое выбранной вкладки
              Expanded(
                child: IndexedStack(
                  index: _selectedTabIndex,
                  children: [
                    _buildContactsTab(),
                    _buildCallTab(),
                    _buildChatTab(),
                    _buildProfileTab(),
                  ],
                ),
              ),
            ],
          ),
        ),
        bottomNavigationBar: isInCallTab
            ? null
            : NavigationBar(
                selectedIndex: _selectedTabIndex,
                onDestinationSelected: (idx) {
                  setState(() {
                    _selectedTabIndex = idx;
                    if (idx == 2) {
                      _unreadChatCount = 0;
                    }
                  });
                },
                backgroundColor: Colors.white,
                surfaceTintColor: Colors.white,
                indicatorColor: const Color(0xFFE2E8F0),
                destinations: [
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: _incomingRequests.isNotEmpty,
                      label: Text('${_incomingRequests.length}'),
                      child: const Icon(Icons.people_outline),
                    ),
                    selectedIcon: Badge(
                      isLabelVisible: _incomingRequests.isNotEmpty,
                      label: Text('${_incomingRequests.length}'),
                      child: const Icon(Icons.people),
                    ),
                    label: 'Контакты',
                  ),
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: _currentRoom != null,
                      backgroundColor: const Color(0xFF10B981),
                      smallSize: 8,
                      child: const Icon(Icons.videocam_outlined),
                    ),
                    selectedIcon: const Icon(Icons.videocam),
                    label: 'Урок',
                  ),
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: _unreadChatCount > 0,
                      label: Text('$_unreadChatCount'),
                      child: const Icon(Icons.chat_bubble_outline),
                    ),
                    selectedIcon: const Icon(Icons.chat_bubble),
                    label: 'Сообщения',
                  ),
                  NavigationDestination(
                    icon: Badge(
                      isLabelVisible: _updateAvailable,
                      smallSize: 8,
                      child: const Icon(Icons.person_outline),
                    ),
                    selectedIcon: const Icon(Icons.person),
                    label: 'Профиль',
                  ),
                ],
              ),
      ),
    );
  }

  // ===========================================================================
  // Баннер входящего звонка
  // ===========================================================================
  Widget _buildIncomingCallBanner() {
    final caller = _incomingCall!['caller'] as Map<String, dynamic>;
    final room = _incomingCall!['room'] as Map<String, dynamic>;
    final withVideo = _incomingCall!['with_video'] == true;

    return Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        borderRadius: BorderRadius.circular(16),
        boxShadow: const [
          BoxShadow(
            color: Colors.black26,
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFF10B981).withValues(alpha: 0.2),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.ring_volume,
                  color: Color(0xFF34D399),
                  size: 22,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${caller['display_name']} (@${caller['username']})',
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w700,
                        fontSize: 15,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Приглашает в урок «${room['title']}»',
                      style: const TextStyle(
                        color: Color(0xFF94A3B8),
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: () {
                    setState(() {
                      _micEnabled = true;
                      _camEnabled = withVideo;
                      _incomingCall = null;
                      _selectedTabIndex = 1;
                    });
                    _sendWs({
                      'type': 'join_room',
                      'payload': {
                        'room_id': room['id'],
                        'audio_enabled': true,
                        'video_enabled': withVideo,
                      },
                    });
                  },
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF10B981),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  icon: const Icon(Icons.call, size: 18),
                  label: const Text('Принять'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () {
                    _sendWs({
                      'type': 'decline_call',
                      'payload': {
                        'room_id': room['id'],
                        'reason': 'busy',
                      },
                    });
                    setState(() {
                      _incomingCall = null;
                    });
                  },
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: Color(0xFF475569)),
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  icon: const Icon(Icons.call_end,
                      size: 18, color: Color(0xFFF43F5E)),
                  label: const Text('Отклонить'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ===========================================================================
  // ВКЛАДКА 1: Контакты и взаимное добавление
  // ===========================================================================
  Widget _buildContactsTab() {
    final isTutorAccount = _currentUser?['role'] == 'tutor';
    final studentCount = _contacts.where((u) => u['role'] == 'student').length;
    final search = _searchContactCtrl.text
        .trim()
        .replaceFirst(RegExp(r'^@'), '')
        .toLowerCase();
    final filteredContacts = _contacts.where((c) {
      final map = c as Map<String, dynamic>;
      final u = (map['username'] ?? '').toString().toLowerCase();
      final d = (map['display_name'] ?? '').toString().toLowerCase();
      return search.isEmpty || u.contains(search) || d.contains(search);
    }).toList();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Добавление контакта по @нику
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      isTutorAccount
                          ? 'Ученики: $studentCount из 10'
                          : 'Ваши преподаватели',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton.icon(
                    onPressed: _wsConnected && _currentRoom == null
                        ? _showCreateGroupDialog
                        : null,
                    style: OutlinedButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: const Color(0xFF0F172A),
                      side: const BorderSide(color: Color(0xFFCBD5E1)),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 6),
                    ),
                    icon: const Icon(Icons.group_add_outlined, size: 16),
                    label: const Text(
                      'Группа',
                      style:
                          TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                isTutorAccount
                    ? studentCount >= 10
                        ? 'Достигнут лимит. Удалите ученика, чтобы пригласить нового.'
                        : 'Пригласите ученика по его @нику. Он сможет принять или отклонить заявку.'
                    : 'Сообщите преподавателю свой @${_currentUser?['username']} и примите его заявку ниже.',
                style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 12),
              if (isTutorAccount)
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _addContactCtrl,
                        enabled: _wsConnected && studentCount < 10,
                        decoration: InputDecoration(
                          hintText: '@username',
                          isDense: true,
                          filled: true,
                          fillColor: const Color(0xFFF8FAFC),
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 12,
                          ),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide:
                                const BorderSide(color: Color(0xFFCBD5E1)),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(10),
                            borderSide:
                                const BorderSide(color: Color(0xFFE2E8F0)),
                          ),
                        ),
                        onSubmitted: (_) => _sendContactRequest(),
                      ),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: _wsConnected && studentCount < 10
                          ? _sendContactRequest
                          : null,
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF0F172A),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                      child: const Text('Добавить'),
                    ),
                  ],
                ),
            ],
          ),
        ),

        // Входящие заявки в контакты
        if (_incomingRequests.isNotEmpty) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFFFBEB),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: const Color(0xFFFDE68A)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Входящие заявки в контакты (${_incomingRequests.length})',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF92400E),
                  ),
                ),
                const SizedBox(height: 10),
                ..._incomingRequests.map((req) {
                  final r = req as Map<String, dynamic>;
                  final fromUser = r['from_user'] as Map<String, dynamic>;
                  return Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color(0xFFFDE68A)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${fromUser['display_name']}',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                            color: Color(0xFF0F172A),
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '@${fromUser['username']} · ${fromUser['role'] == 'tutor' ? 'Репетитор' : 'Ученик'}',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12,
                            color: Color(0xFF64748B),
                          ),
                        ),
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            Expanded(
                              child: FilledButton(
                                onPressed: () => _respondContactRequest(
                                    r['id'] as String, true),
                                style: FilledButton.styleFrom(
                                  backgroundColor: const Color(0xFF0F172A),
                                  visualDensity: VisualDensity.compact,
                                ),
                                child: const Text(
                                  'Принять',
                                  style: TextStyle(fontSize: 12),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: OutlinedButton(
                                onPressed: () => _respondContactRequest(
                                    r['id'] as String, false),
                                style: OutlinedButton.styleFrom(
                                  visualDensity: VisualDensity.compact,
                                ),
                                child: const Text(
                                  'Отклонить',
                                  style: TextStyle(fontSize: 12),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  );
                }),
              ],
            ),
          ),
        ],

        // Исходящие заявки
        if (_outgoingRequests.isNotEmpty) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Ожидают подтверждения (${_outgoingRequests.length})',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF64748B),
                  ),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: _outgoingRequests.map((req) {
                    final r = req as Map<String, dynamic>;
                    final toUser = r['to_user'] as Map<String, dynamic>;
                    return Chip(
                      visualDensity: VisualDensity.compact,
                      label: Text(
                        '@${toUser['username']}',
                        style: const TextStyle(fontSize: 12),
                      ),
                    );
                  }).toList(),
                ),
              ],
            ),
          ),
        ],

        const SizedBox(height: 16),

        // Заголовок списка контактов и поиск
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(
                'Мои контакты (${_contacts.length})',
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF0F172A),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (_contacts.length > 3)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: TextField(
              controller: _searchContactCtrl,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search, size: 18),
                hintText: 'Фильтр по контактам...',
                isDense: true,
                filled: true,
                fillColor: Colors.white,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                ),
              ),
            ),
          ),

        if (filteredContacts.isEmpty)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 36, horizontal: 20),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            child: Column(
              children: [
                const Icon(Icons.people_outline,
                    size: 40, color: Color(0xFF94A3B8)),
                const SizedBox(height: 10),
                Text(
                  search.isEmpty
                      ? isTutorAccount
                          ? 'Пригласите первого ученика'
                          : 'Пока нет преподавателей'
                      : 'Ничего не найдено',
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                    color: Color(0xFF334155),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  search.isEmpty
                      ? isTutorAccount
                          ? 'Отправьте заявку по @нику выше. После подтверждения можно начать урок.'
                          : 'Преподаватель появится здесь после того, как вы примете его заявку.'
                      : 'Попробуйте другое имя или никнейм.',
                  textAlign: TextAlign.center,
                  style:
                      const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                ),
              ],
            ),
          )
        else
          ...filteredContacts.map((raw) {
            final u = raw as Map<String, dynamic>;
            final online = u['online'] == true;
            final isTutor = u['role'] == 'tutor';
            final displayName = (u['display_name'] ?? u['username']).toString();
            final username = (u['username'] ?? '').toString();

            return Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFE2E8F0)),
              ),
              child: Row(
                children: [
                  Stack(
                    children: [
                      CircleAvatar(
                        radius: 20,
                        backgroundColor: const Color(0xFFF1F5F9),
                        child: Text(
                          (displayName.isEmpty
                                  ? '?'
                                  : displayName.substring(
                                      0, displayName.length >= 2 ? 2 : 1))
                              .toUpperCase(),
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF0F172A),
                            fontSize: 13,
                          ),
                        ),
                      ),
                      Positioned(
                        right: 0,
                        bottom: 0,
                        child: Container(
                          width: 11,
                          height: 11,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: online
                                ? const Color(0xFF10B981)
                                : const Color(0xFFCBD5E1),
                            border: Border.all(color: Colors.white, width: 2),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          displayName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 14,
                            color: Color(0xFF0F172A),
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '@$username · ${isTutor ? 'Репетитор' : 'Ученик'} · ${online ? 'В сети' : 'Не в сети'}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xFF64748B),
                          ),
                        ),
                      ],
                    ),
                  ),
                  PopupMenuButton<String>(
                    tooltip: 'Действия с контактом',
                    onSelected: (action) {
                      if (action == 'chat') {
                        setState(() {
                          _selectedChatContact = u;
                          _chatMode = 'direct';
                          _selectedTabIndex = 2;
                          _unreadChatCount = 0;
                        });
                      } else if (action == 'audio') {
                        _callByNick(username, withVideo: false);
                      } else if (action == 'video') {
                        _callByNick(username);
                      } else if (action == 'remove') {
                        _removeContact(u['id'] as String, username);
                      }
                    },
                    itemBuilder: (_) => [
                      const PopupMenuItem(
                          value: 'chat',
                          child: ListTile(
                              leading: Icon(Icons.chat_bubble_outline),
                              title: Text('Написать сообщение'))),
                      PopupMenuItem(
                          value: 'audio',
                          enabled: _wsConnected && _currentRoom == null,
                          child: const ListTile(
                              leading: Icon(Icons.call_outlined),
                              title: Text('Аудиозвонок'))),
                      PopupMenuItem(
                          value: 'video',
                          enabled: _wsConnected && _currentRoom == null,
                          child: const ListTile(
                              leading: Icon(Icons.videocam_outlined),
                              title: Text('Видеозвонок'))),
                      const PopupMenuDivider(),
                      PopupMenuItem(
                          value: 'remove',
                          enabled: _wsConnected,
                          child: const ListTile(
                              leading: Icon(Icons.person_remove_outlined),
                              title: Text('Удалить контакт'))),
                    ],
                  ),
                ],
              ),
            );
          }),
      ],
    );
  }

  // ===========================================================================
  // ВКЛАДКА 2: Современное полноэкранное окно звонка (как в Telegram / Zoom)
  // ===========================================================================
  Widget _buildCallTab() {
    if (_currentRoom == null) {
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 68,
                height: 68,
                decoration: BoxDecoration(
                  color: Colors.white,
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: const Icon(
                  Icons.videocam_outlined,
                  size: 32,
                  color: Color(0xFF64748B),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Нет активного звонка',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF0F172A),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Выберите собеседника во вкладке «Контакты» или создайте групповой урок.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: () => setState(() => _selectedTabIndex = 0),
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF0F172A),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                icon: const Icon(Icons.people_outline, size: 18),
                label: const Text('Перейти к контактам'),
              ),
            ],
          ),
        ),
      );
    }

    final participants =
        (_currentRoom!['participants'] as List<dynamic>?) ?? [];
    final myId = _currentUser?['id']?.toString();
    final remoteParticipants = participants
        .map((p) => p as Map<String, dynamic>)
        .where((p) => p['user_id'] != myId)
        .toList();

    Map<String, dynamic>? primaryPeer;
    if (remoteParticipants.isNotEmpty) {
      primaryPeer = remoteParticipants.firstWhere(
        (p) => p['user_id'] == _focusedPeerId,
        orElse: () => remoteParticipants.first,
      );
    }

    final primaryPeerId = primaryPeer?['user_id']?.toString();
    final primaryRemoteFrame = primaryPeerId != null &&
            (primaryPeer?['video_enabled'] == true ||
                primaryPeer?['screen_share_enabled'] == true)
        ? _remoteVideoFrames[primaryPeerId]
        : null;
    final isPrimaryScreenShare = primaryPeer?['screen_share_enabled'] == true;

    return LayoutBuilder(builder: (context, callConstraints) {
      final showParticipantStrip =
          remoteParticipants.length > 1 && callConstraints.maxHeight >= 480;
      return Container(
        color: const Color(0xFF0F172A),
        child: Stack(
          children: [
            // 1. Главная сцена (Видео собеседника или демонстрация экрана с Pinch-to-Zoom)
            Positioned.fill(
              child: primaryPeer == null
                  ? _buildWaitingForPeerStage()
                  : primaryRemoteFrame != null
                      ? InteractiveViewer(
                          minScale: 1.0,
                          maxScale: 4.5,
                          child: Center(
                            child: Image.memory(
                              primaryRemoteFrame,
                              gaplessPlayback: true,
                              fit: (_fitContain || isPrimaryScreenShare)
                                  ? BoxFit.contain
                                  : BoxFit.cover,
                              width: double.infinity,
                              height: double.infinity,
                            ),
                          ),
                        )
                      : _buildAudioOnlyPeerStage(primaryPeer),
            ),

            // 2. Верхняя панель управления звонком
            Positioned(
              top: 12,
              left: 12,
              right: 12,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: const Color(0xFF1E293B).withValues(alpha: 0.85),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Colors.white12),
                ),
                child: Row(
                  children: [
                    IconButton(
                      tooltip: 'Свернуть урок',
                      onPressed: () => setState(() => _selectedTabIndex = 0),
                      icon: const Icon(Icons.keyboard_arrow_down,
                          color: Colors.white),
                    ),
                    Container(
                      width: 8,
                      height: 8,
                      decoration: const BoxDecoration(
                        color: Color(0xFF10B981),
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            (_currentRoom!['title'] ?? 'Урок').toString(),
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                              fontSize: 14,
                            ),
                          ),
                          Text(
                            '${_formatCallDuration(_callSeconds)} · Участников: ${participants.length}',
                            style: const TextStyle(
                              color: Color(0xFF94A3B8),
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (remoteParticipants.length > 1 && !showParticipantStrip)
                      PopupMenuButton<String>(
                        tooltip: 'Выбрать участника',
                        icon: const Icon(Icons.people_outline,
                            color: Colors.white),
                        onSelected: (id) => setState(() => _focusedPeerId = id),
                        itemBuilder: (_) => remoteParticipants
                            .map((peer) => PopupMenuItem(
                                  value: peer['user_id'].toString(),
                                  child: Text(peer['display_name'].toString()),
                                ))
                            .toList(),
                      ),
                    if (primaryRemoteFrame != null)
                      IconButton(
                        onPressed: () {
                          setState(() {
                            _fitContain = !_fitContain;
                          });
                        },
                        tooltip:
                            _fitContain ? 'Заполнить экран' : 'Вписать целиком',
                        icon: Icon(
                          _fitContain ? Icons.fullscreen : Icons.fit_screen,
                          color: Colors.white,
                          size: 20,
                        ),
                      ),
                    IconButton(
                      onPressed: _showInviteParticipantSheet,
                      tooltip: 'Пригласить контакт в звонок',
                      icon: const Icon(
                        Icons.person_add_alt,
                        color: Colors.white,
                        size: 20,
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // 3. Миниатюры других участников (если групповой звонок)
            if (showParticipantStrip)
              Positioned(
                top: 80,
                left: 12,
                right: 120,
                height: 68,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: remoteParticipants.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (_, idx) {
                    final peer = remoteParticipants[idx];
                    final peerId = peer['user_id'].toString();
                    final isSelected = peerId == primaryPeerId;
                    return GestureDetector(
                      onTap: () => setState(() => _focusedPeerId = peerId),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: isSelected
                              ? const Color(0xFF334155)
                              : const Color(0xFF1E293B).withValues(alpha: 0.8),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: isSelected
                                ? const Color(0xFF38BDF8)
                                : Colors.white12,
                          ),
                        ),
                        child: Row(
                          children: [
                            Icon(
                              peer['audio_enabled'] == true
                                  ? Icons.mic
                                  : Icons.mic_off,
                              size: 14,
                              color: peer['audio_enabled'] == true
                                  ? const Color(0xFF34D399)
                                  : const Color(0xFFF43F5E),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              peer['display_name'].toString(),
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),

            // Preview position survives camera toggles and follows the usable area.
            Positioned.fill(
              child: DraggableSelfView(
                visible: _camEnabled && _localStream != null,
                reservedInsets: EdgeInsets.fromLTRB(
                    12, showParticipantStrip ? 160 : 88, 12, 116),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.black,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: Colors.white24, width: 1.5),
                    ),
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        RTCVideoView(
                          _localRenderer,
                          mirror: _usingFrontCamera,
                          objectFit:
                              RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                        ),
                        Positioned(
                          top: 0,
                          right: 0,
                          child: IconButton(
                            tooltip: 'Переключить камеру',
                            onPressed: _switchCameraDirection,
                            style: IconButton.styleFrom(
                                backgroundColor: Colors.black54),
                            icon: const Icon(Icons.cameraswitch,
                                size: 20, color: Colors.white),
                          ),
                        ),
                        const Positioned(
                          left: 8,
                          bottom: 8,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                                color: Colors.black54,
                                borderRadius:
                                    BorderRadius.all(Radius.circular(6))),
                            child: Padding(
                                padding: EdgeInsets.symmetric(
                                    horizontal: 6, vertical: 3),
                                child: Text('Вы · ↔',
                                    style: TextStyle(
                                        fontSize: 11, color: Colors.white))),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),

            // 5. Нижняя панель кнопок звонка (Микрофон, Камера, Чат, Завершить)
            Positioned(
              left: 16,
              right: 16,
              bottom: 18,
              child: Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: const Color(0xFF1E293B).withValues(alpha: 0.92),
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: Colors.white12),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    _buildCallControlButton(
                      icon: _micEnabled ? Icons.mic : Icons.mic_off,
                      label: _micEnabled ? 'Микрофон' : 'Выкл.',
                      active: _micEnabled,
                      onTap: _toggleMic,
                    ),
                    _buildCallControlButton(
                      icon: _camEnabled ? Icons.videocam : Icons.videocam_off,
                      label: _camEnabled ? 'Камера' : 'Выкл.',
                      active: _camEnabled,
                      onTap: _toggleCamera,
                    ),
                    _buildCallControlButton(
                      icon: Icons.chat_bubble_outline,
                      label: 'Чат урока',
                      active: false,
                      badgeCount: _unreadChatCount,
                      onTap: () {
                        setState(() {
                          _selectedTabIndex = 2;
                          _unreadChatCount = 0;
                        });
                      },
                    ),
                    _buildCallControlButton(
                      icon: Icons.call_end,
                      label: 'Выйти',
                      active: true,
                      isDanger: true,
                      onTap: _leaveCurrentRoom,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    });
  }

  Widget _buildWaitingForPeerStage() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(
              color: const Color(0xFF1E293B),
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white12),
            ),
            child: const Icon(
              Icons.person_outline,
              color: Colors.white70,
              size: 40,
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Ожидание подключения собеседника...',
            style: TextStyle(
              color: Colors.white,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'Вы можете написать сообщение в чате урока или пригласить ещё участников',
            textAlign: TextAlign.center,
            style: TextStyle(color: Color(0xFF94A3B8), fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _buildAudioOnlyPeerStage(Map<String, dynamic> peer) {
    final name =
        (peer['display_name'] ?? peer['username'] ?? 'Участник').toString();
    final username = (peer['username'] ?? '').toString();
    final role = peer['role'] == 'tutor' ? 'Репетитор' : 'Ученик';
    final audioOn = peer['audio_enabled'] == true;

    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 96,
            height: 96,
            decoration: BoxDecoration(
              color: const Color(0xFF1E293B),
              shape: BoxShape.circle,
              border: Border.all(
                color: audioOn ? const Color(0xFF10B981) : Colors.white24,
                width: 2.5,
              ),
            ),
            alignment: Alignment.center,
            child: Text(
              name.substring(0, name.length >= 2 ? 2 : 1).toUpperCase(),
              style: const TextStyle(
                color: Colors.white,
                fontSize: 28,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            name,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 20,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '@$username · $role',
            style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 13),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFF1E293B),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  audioOn ? Icons.mic : Icons.mic_off,
                  size: 15,
                  color: audioOn
                      ? const Color(0xFF34D399)
                      : const Color(0xFFF43F5E),
                ),
                const SizedBox(width: 6),
                Text(
                  audioOn ? 'Микрофон включён' : 'Микрофон выключен',
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCallControlButton({
    required IconData icon,
    required String label,
    required bool active,
    required VoidCallback onTap,
    bool isDanger = false,
    int badgeCount = 0,
  }) {
    final bgColor = isDanger
        ? const Color(0xFFE11D48)
        : active
            ? Colors.white
            : const Color(0xFF334155);
    final iconColor = isDanger
        ? Colors.white
        : active
            ? const Color(0xFF0F172A)
            : Colors.white;

    return Expanded(
        child: Semantics(
      button: true,
      label: label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Badge(
                isLabelVisible: badgeCount > 0,
                label: Text('$badgeCount'),
                child: Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: bgColor,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(icon, color: iconColor, size: 22),
                ),
              ),
              const SizedBox(height: 5),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Colors.white70,
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    ));
  }

  void _showInviteParticipantSheet() {
    if (_currentRoom == null) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Пригласить контакт в текущий урок',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF0F172A),
                ),
              ),
              const SizedBox(height: 12),
              if (_contacts.isEmpty)
                const Text(
                  'У вас пока нет взаимных контактов.',
                  style: TextStyle(color: Color(0xFF64748B)),
                )
              else
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 240),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: _contacts.length,
                    itemBuilder: (_, i) {
                      final c = _contacts[i] as Map<String, dynamic>;
                      final nick = c['username'] as String;
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text('${c['display_name']} (@$nick)'),
                        subtitle: Text(
                          c['online'] == true ? 'В сети' : 'Не в сети',
                        ),
                        trailing: FilledButton(
                          onPressed: () {
                            _sendWs({
                              'type': 'invite_by_nick',
                              'payload': {
                                'room_id': _currentRoom!['id'],
                                'target_username': nick,
                              },
                            });
                            Navigator.pop(ctx);
                            setState(() {
                              _statusMessage = 'Приглашение отправлено @$nick';
                            });
                          },
                          style: FilledButton.styleFrom(
                            backgroundColor: const Color(0xFF0F172A),
                          ),
                          child: const Text('Позвать'),
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  // ===========================================================================
  // ВКЛАДКА 3: Чат урока, Личные сообщения контактам и Архив уроков
  // ===========================================================================
  Widget _buildChatTab() {
    final myId = _currentUser?['id']?.toString();
    final targetRoomId = _activeChatRoomId;
    final visibleMessages = targetRoomId == null
        ? <ChatMessageItem>[]
        : _chatMessages.where((m) => m.roomId == targetRoomId).toList();

    return Column(
      children: [
        // Панель выбора режима чата (Урок / Личный диалог / Архив)
        Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: const BoxDecoration(
            color: Colors.white,
            border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SegmentedButton<String>(
                showSelectedIcon: false,
                segments: [
                  const ButtonSegment(value: 'lesson', label: Text('Урок')),
                  const ButtonSegment(value: 'direct', label: Text('Личный')),
                  ButtonSegment(
                    value: 'archive',
                    label: Text('Архив (${_archivedChats.length})'),
                  ),
                ],
                selected: {_chatMode},
                onSelectionChanged: (s) {
                  setState(() {
                    _chatMode = s.first;
                  });
                  if (s.first == 'archive') _syncArchives();
                },
              ),
              if (_chatMode == 'lesson' && _currentRoom != null) ...[
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Урок: ${_currentRoom!['title']}',
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 13,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                    ),
                    TextButton.icon(
                      onPressed: () => _saveCurrentLessonToArchive(
                          showNotification: true, completed: false),
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                      ),
                      icon: const Icon(Icons.bookmark_add_outlined, size: 16),
                      label:
                          const Text('В архив', style: TextStyle(fontSize: 12)),
                    ),
                    TextButton.icon(
                      onPressed: () => setState(() => _selectedTabIndex = 1),
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                      ),
                      icon: const Icon(Icons.videocam, size: 16),
                      label:
                          const Text('К видео', style: TextStyle(fontSize: 12)),
                    ),
                  ],
                ),
              ],
              if (_chatMode == 'direct') ...[
                const SizedBox(height: 8),
                if (_contacts.isEmpty)
                  const Text(
                    'Выберите контакт после подтверждения приглашения преподавателя',
                    style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                  )
                else
                  SizedBox(
                    height: 36,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: _contacts.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 6),
                      itemBuilder: (_, idx) {
                        final c = _contacts[idx] as Map<String, dynamic>;
                        final isSelected =
                            _selectedChatContact?['id'] == c['id'];
                        return ChoiceChip(
                          selected: isSelected,
                          visualDensity: VisualDensity.compact,
                          label: Text(
                            '${c['display_name']} (@${c['username']})',
                            style: const TextStyle(fontSize: 12),
                          ),
                          onSelected: (_) {
                            setState(() {
                              _selectedChatContact = c;
                            });
                          },
                        );
                      },
                    ),
                  ),
              ],
            ],
          ),
        ),

        if (_chatMode == 'archive')
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: Colors.white,
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_archiveSyncStatus,
                  style:
                      const TextStyle(fontSize: 12, color: Color(0xFF64748B))),
              TextButton.icon(
                onPressed: _archiveSyncing
                    ? null
                    : _archiveKey == null
                        ? _unlockArchives
                        : _syncArchives,
                icon: Icon(
                    _archiveKey == null ? Icons.lock_open_outlined : Icons.sync,
                    size: 18),
                label: Text(_archiveKey == null
                    ? 'Разблокировать архив'
                    : 'Синхронизировать'),
              ),
            ]),
          ),
        // Режим Архива уроков
        if (_chatMode == 'archive')
          Expanded(
            child: _archivedChats.isEmpty
                ? const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text(
                        'Сохранённых чатов уроков пока нет. По завершении урока переписка сохраняется в архив автоматически или по кнопке «В архив».',
                        textAlign: TextAlign.center,
                        style:
                            TextStyle(color: Color(0xFF64748B), fontSize: 13),
                      ),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(14),
                    itemCount: _archivedChats.length,
                    itemBuilder: (_, idx) {
                      final arch = _archivedChats[idx];
                      final msgs = (arch['messages'] as List<dynamic>?) ?? [];
                      return Container(
                        margin: const EdgeInsets.only(bottom: 12),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: const Color(0xFFE2E8F0)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    (arch['title'] ?? 'Урок').toString(),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                      fontSize: 14,
                                      color: Color(0xFF0F172A),
                                    ),
                                  ),
                                ),
                                IconButton(
                                  onPressed: () {
                                    final buf = StringBuffer();
                                    buf.writeln('=== ${arch['title']} ===');
                                    for (final m in msgs) {
                                      final map = m as Map<String, dynamic>;
                                      buf.writeln(
                                          '${map['sender']} (@${map['username']}): ${map['text']}');
                                    }
                                    Clipboard.setData(
                                      ClipboardData(text: buf.toString()),
                                    );
                                    setState(() {
                                      _statusMessage =
                                          'Текст архива скопирован в буфер обмена';
                                    });
                                  },
                                  tooltip: 'Скопировать конспект чата',
                                  icon: const Icon(Icons.copy, size: 17),
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            ...msgs.map((m) {
                              final map = m as Map<String, dynamic>;
                              return Padding(
                                padding: const EdgeInsets.only(bottom: 4),
                                child: Text(
                                  '${map['sender']}: ${map['text']}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Color(0xFF334155),
                                  ),
                                ),
                              );
                            }),
                          ],
                        ),
                      );
                    },
                  ),
          )
        else ...[
          // Список сообщений (Урок или Личный чат)
          Expanded(
            child: targetRoomId == null
                ? Center(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        _chatMode == 'direct'
                            ? 'Выберите контакт выше или нажмите на иконку сообщения рядом с контактом, чтобы написать напрямую.'
                            : 'Нет активного урока. Вы можете переключиться на вкладку «Личный», чтобы написать любому контакту напрямую.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            color: Color(0xFF64748B), fontSize: 13),
                      ),
                    ),
                  )
                : visibleMessages.isEmpty
                    ? const Center(
                        child: Text(
                          'Сообщений пока нет. Напишите первым!',
                          style:
                              TextStyle(color: Color(0xFF94A3B8), fontSize: 13),
                        ),
                      )
                    : ListView.builder(
                        controller: _chatScrollCtrl,
                        padding: const EdgeInsets.all(16),
                        itemCount: visibleMessages.length,
                        itemBuilder: (_, idx) {
                          final m = visibleMessages[idx];
                          final isMe = m.senderId == myId;
                          String timeLabel = '';
                          try {
                            final dt = DateTime.parse(m.sentAt).toLocal();
                            timeLabel =
                                '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
                          } catch (_) {}

                          return Align(
                            alignment: isMe
                                ? Alignment.centerRight
                                : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.only(bottom: 10),
                              constraints: BoxConstraints(
                                maxWidth:
                                    MediaQuery.of(context).size.width * 0.78,
                              ),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 14,
                                vertical: 10,
                              ),
                              decoration: BoxDecoration(
                                color: isMe
                                    ? const Color(0xFF0F172A)
                                    : Colors.white,
                                borderRadius: BorderRadius.circular(16),
                                border: isMe
                                    ? null
                                    : Border.all(
                                        color: const Color(0xFFE2E8F0)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Flexible(
                                        child: Text(
                                          isMe
                                              ? 'Вы'
                                              : '${m.senderDisplayName} (@${m.senderUsername})',
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontSize: 11,
                                            fontWeight: FontWeight.w600,
                                            color: isMe
                                                ? const Color(0xFF94A3B8)
                                                : const Color(0xFF64748B),
                                          ),
                                        ),
                                      ),
                                      if (timeLabel.isNotEmpty) ...[
                                        const SizedBox(width: 8),
                                        Text(
                                          timeLabel,
                                          style: TextStyle(
                                            fontSize: 10,
                                            color: isMe
                                                ? const Color(0xFF64748B)
                                                : const Color(0xFF94A3B8),
                                          ),
                                        ),
                                      ],
                                    ],
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    m.text,
                                    style: TextStyle(
                                      fontSize: 14,
                                      color: isMe
                                          ? Colors.white
                                          : const Color(0xFF0F172A),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
          ),

          // Поле ввода сообщения
          Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            decoration: const BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _chatInputCtrl,
                    enabled: targetRoomId != null && _wsConnected,
                    onChanged: (_) => setState(() {}),
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _sendChatMessage(),
                    decoration: InputDecoration(
                      hintText: targetRoomId == null
                          ? 'Выберите контакт или начните урок'
                          : _chatMode == 'direct' &&
                                  _selectedChatContact != null
                              ? 'Сообщение для @${_selectedChatContact!['username']}...'
                              : 'Написать сообщение в чат урока...',
                      isDense: true,
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 12,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: 'Отправить сообщение',
                  onPressed: targetRoomId == null ||
                          !_wsConnected ||
                          _sendingChat ||
                          _chatInputCtrl.text.trim().isEmpty
                      ? null
                      : _sendChatMessage,
                  style: IconButton.styleFrom(
                    backgroundColor: const Color(0xFF0F172A),
                    foregroundColor: Colors.white,
                  ),
                  icon: const Icon(Icons.send_rounded, size: 20),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  // ===========================================================================
  // ВКЛАДКА 4: Профиль и обновления
  // ===========================================================================
  Widget _buildProfileTab() {
    final displayName =
        (_currentUser!['display_name'] ?? _currentUser!['username']).toString();
    final username = (_currentUser!['username'] ?? '').toString();
    final isTutor = _currentUser!['role'] == 'tutor';

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        StorageUsageCard(
            key: ValueKey(_currentUser!['id']),
            baseUrl: _serverUrl,
            token: _token!,
            active: _selectedTabIndex == 3),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Row(
            children: [
              CircleAvatar(
                radius: 28,
                backgroundColor: const Color(0xFF0F172A),
                child: Text(
                  (displayName.isEmpty
                          ? '?'
                          : displayName.substring(
                              0, displayName.length >= 2 ? 2 : 1))
                      .toUpperCase(),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      displayName,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '@$username · ${isTutor ? 'Репетитор' : 'Ученик'}',
                      style: const TextStyle(
                        fontSize: 13,
                        color: Color(0xFF64748B),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Блок обновлений приложения
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                      child: Text(
                    'Версия приложения',
                    style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                        color: Color(0xFF0F172A)),
                  )),
                  SizedBox(width: 12),
                  Text(
                    'v$kCurrentAppVersion',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF64748B),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              if (_updateAvailable && _latestRelease != null) ...[
                Text(
                  'Доступно обновление v${_latestRelease!['version']}: ${_latestRelease!['release_notes']}',
                  style:
                      const TextStyle(fontSize: 13, color: Color(0xFF334155)),
                ),
                const SizedBox(height: 12),
                if (_downloadingApk)
                  LinearProgressIndicator(value: _downloadProgress)
                else
                  FilledButton.icon(
                    onPressed: _downloadAndInstallApk,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                    ),
                    icon: const Icon(Icons.system_update_alt, size: 18),
                    label: const Text('Скачать и установить APK'),
                  ),
              ] else
                OutlinedButton.icon(
                  onPressed: _checkingUpdates ? null : _checkForUpdates,
                  icon: const Icon(Icons.refresh, size: 18),
                  label: Text(
                      _checkingUpdates ? 'Проверяем…' : 'Проверить обновления'),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Выход из аккаунта
        OutlinedButton.icon(
          onPressed: _logout,
          style: OutlinedButton.styleFrom(
            foregroundColor: const Color(0xFFE11D48),
            side: const BorderSide(color: Color(0xFFFECDD3)),
            padding: const EdgeInsets.symmetric(vertical: 14),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
          icon: const Icon(Icons.logout),
          label: const Text('Выйти из аккаунта'),
        ),
      ],
    );
  }

  // ===========================================================================
  // Экран авторизации (Логин / Регистрация)
  // ===========================================================================
  Widget _buildAuthScreen() {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(
                            color: const Color(0xFF0F172A),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          alignment: Alignment.center,
                          child: const Text(
                            'L',
                            style: TextStyle(
                              fontWeight: FontWeight.bold,
                              fontSize: 20,
                              color: Colors.white,
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Liaper',
                                style: TextStyle(
                                  fontSize: 20,
                                  fontWeight: FontWeight.bold,
                                  color: Color(0xFF0F172A),
                                ),
                              ),
                              Text(
                                'Видеозвонки и уроки для репетиторов и учеников',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Color(0xFF64748B),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 20),
                    SegmentedButton<bool>(
                      showSelectedIcon: false,
                      style: SegmentedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8)),
                      segments: const [
                        ButtonSegment(value: true, label: Text('Регистрация')),
                        ButtonSegment(value: false, label: Text('Вход')),
                      ],
                      selected: {_isRegister},
                      onSelectionChanged: (s) {
                        setState(() {
                          _isRegister = s.first;
                          _authError = null;
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _usernameCtrl,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.username],
                      autocorrect: false,
                      enableSuggestions: false,
                      decoration: InputDecoration(
                        labelText: 'Никнейм (@username)',
                        prefixText: '@',
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    if (_isRegister) ...[
                      TextField(
                        controller: _displayNameCtrl,
                        textCapitalization: TextCapitalization.words,
                        textInputAction: TextInputAction.next,
                        autofillHints: const [AutofillHints.name],
                        decoration: InputDecoration(
                          labelText: 'Ваше имя',
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        isExpanded: true,
                        initialValue: _selectedRole,
                        decoration: InputDecoration(
                          labelText: 'Ваша роль',
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'tutor',
                            child: Text('Репетитор'),
                          ),
                          DropdownMenuItem(
                            value: 'student',
                            child: Text('Ученик'),
                          ),
                        ],
                        onChanged: (v) {
                          if (v != null) setState(() => _selectedRole = v);
                        },
                      ),
                      const SizedBox(height: 12),
                    ],
                    TextField(
                      controller: _passwordCtrl,
                      obscureText: !_showPassword,
                      textInputAction: TextInputAction.done,
                      autofillHints: [
                        _isRegister
                            ? AutofillHints.newPassword
                            : AutofillHints.password
                      ],
                      onSubmitted: (_) => _submitAuth(),
                      decoration: InputDecoration(
                        labelText: 'Пароль',
                        helperText: _isRegister ? 'Не менее 4 символов' : null,
                        suffixIcon: IconButton(
                          tooltip: _showPassword
                              ? 'Скрыть пароль'
                              : 'Показать пароль',
                          onPressed: () =>
                              setState(() => _showPassword = !_showPassword),
                          icon: Icon(_showPassword
                              ? Icons.visibility_off_outlined
                              : Icons.visibility_outlined),
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () {
                          setState(() {
                            _showServerConfig = !_showServerConfig;
                          });
                        },
                        icon: const Icon(Icons.dns_outlined, size: 16),
                        label: Text(
                          _showServerConfig
                              ? 'Скрыть настройки сервера'
                              : 'Настроить адрес сервера',
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                    if (_showServerConfig) ...[
                      TextField(
                        controller: _serverUrlCtrl,
                        keyboardType: TextInputType.url,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'Адрес сервера',
                          helperText:
                              'На телефоне укажите адрес компьютера в сети.\n127.0.0.1 указывает на сам телефон.',
                          helperMaxLines: 3,
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (_authError != null) ...[
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFF1F2),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: const Color(0xFFFECDD3)),
                        ),
                        child: Text(
                          _authError!,
                          style: const TextStyle(
                            color: Color(0xFFE11D48),
                            fontSize: 12,
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    FilledButton(
                      onPressed:
                          _authLoading || !_identityReady ? null : _submitAuth,
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF0F172A),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 15),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: Text(
                        _authLoading
                            ? 'Подключение...'
                            : _isRegister
                                ? 'Создать аккаунт'
                                : 'Войти',
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
