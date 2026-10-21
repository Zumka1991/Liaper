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
  bool _isRegister = true;
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
  List<dynamic> _contacts = [];
  List<dynamic> _incomingRequests = [];
  List<dynamic> _outgoingRequests = [];
  Map<String, dynamic>? _currentRoom;
  Map<String, dynamic>? _incomingCall;

  // Поля контактов и комнат
  final TextEditingController _addContactCtrl = TextEditingController();
  final TextEditingController _searchContactCtrl = TextEditingController();
  final TextEditingController _inviteInCallCtrl = TextEditingController();

  // Чат урока
  final TextEditingController _chatInputCtrl = TextEditingController();
  final ScrollController _chatScrollCtrl = ScrollController();
  final List<ChatMessageItem> _chatMessages = [];
  final Set<String> _seenMessageIds = {};

  // Локальная камера и микрофон + подключение к SFU-ноде
  final RTCVideoRenderer _localRenderer = RTCVideoRenderer();
  MediaStream? _localStream;
  bool _micEnabled = true;
  bool _camEnabled = false;
  bool _usingFrontCamera = true;
  bool _fitContain = true; // Удобно для просмотра демонстрации экрана по умолчанию
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
  SecretKey _deriveRoomSecretKey(String roomId) {
    final digest = sha256.convert(utf8.encode('liaper-room-e2ee-v1:$roomId'));
    return SecretKey(digest.bytes);
  }

  Future<Map<String, String>> _encryptChatText(String plaintext, String roomId) async {
    final algorithm = AesGcm.with256bits();
    final secretKey = _deriveRoomSecretKey(roomId);
    final nonce = algorithm.newNonce();
    final secretBox = await algorithm.encrypt(
      utf8.encode(plaintext),
      secretKey: secretKey,
      nonce: nonce,
    );
    final combined = Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length);
    combined.setRange(0, secretBox.cipherText.length, secretBox.cipherText);
    combined.setRange(secretBox.cipherText.length, combined.length, secretBox.mac.bytes);

    return {
      'ciphertext_b64': base64Encode(combined),
      'iv_b64': base64Encode(nonce),
      'room_key_id': 'rk-${roomId.length >= 8 ? roomId.substring(0, 8) : roomId}',
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
      if (combined.length < 16) return ciphertextB64;

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
      return ciphertextB64;
    }
  }

  Future<void> _handleIncomingEncryptedChat(Map<String, dynamic> rawMsg) async {
    final msgId = (rawMsg['id'] ?? '').toString();
    if (msgId.isNotEmpty && _seenMessageIds.contains(msgId)) return;
    if (msgId.isNotEmpty) _seenMessageIds.add(msgId);

    final roomId = (rawMsg['room_id'] ?? '').toString();
    final senderId = (rawMsg['sender_id'] ?? '').toString();
    final senderUsername = (rawMsg['sender_username'] ?? '').toString();
    final senderDisplayName = (rawMsg['sender_display_name'] ?? senderUsername).toString();
    final ciphertextB64 = (rawMsg['ciphertext_b64'] ?? '').toString();
    final ivB64 = (rawMsg['iv_b64'] ?? '').toString();
    final sentAt = (rawMsg['sent_at'] ?? '').toString();

    final decrypted = await _decryptChatText(ciphertextB64, ivB64, roomId);
    if (!mounted) return;

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
      if (_selectedTabIndex != 2 && senderId != _currentUser?['id']) {
        _unreadChatCount++;
      }
    });

    Future.delayed(const Duration(milliseconds: 100), () {
      if (_chatScrollCtrl.hasClients) {
        _chatScrollCtrl.animateTo(
          _chatScrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _sendChatMessage() async {
    final room = _currentRoom;
    final text = _chatInputCtrl.text.trim();
    if (room == null || text.isEmpty) return;

    _chatInputCtrl.clear();
    final roomId = room['id'].toString();
    final encrypted = await _encryptChatText(text, roomId);

    _sendWs({
      'type': 'send_encrypted_chat',
      'payload': {
        'room_id': roomId,
        'ciphertext_b64': encrypted['ciphertext_b64'],
        'iv_b64': encrypted['iv_b64'],
        'room_key_id': encrypted['room_key_id'],
      },
    });
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
    _connectToSfuNode(room);
  }

  Future<void> _startLocalMedia({
    required bool withAudio,
    required bool withVideo,
  }) async {
    try {
      await _mediaChannel.invokeMethod('startAudio');
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
        _localStream?.dispose();
        _localStream = stream;
        _localRenderer.srcObject = stream;
      } else {
        await _localStream?.dispose();
        _localStream = null;
        _localRenderer.srcObject = null;
      }
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) {
        setState(() {
          _statusMessage = 'Не удалось получить доступ к камере';
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
          if (mounted && _currentRoom != null && _connectedSfuRoomId == room['id']) {
            Future.delayed(const Duration(seconds: 2), () {
              if (mounted && _currentRoom != null && _connectedSfuRoomId == room['id']) {
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
      final iv = base64Encode(utf8.encode('aud-${DateTime.now().millisecondsSinceEpoch}'));
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
      final iv = base64Encode(utf8.encode('vid-${DateTime.now().millisecondsSinceEpoch}'));

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
          'video_enabled': nextCam,
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

    setState(() {
      _publicKeyB64 = pubKey!;
      _fingerprint = fp!;
      _token = prefs.getString('liaper_token');
      final rawUser = prefs.getString('liaper_user');
      if (rawUser != null) {
        _currentUser = jsonDecode(rawUser) as Map<String, dynamic>;
      }
    });

    if (_token != null) {
      _connectWebSocket();
    }
    _checkForUpdates();
  }

  void _connectWebSocket() {
    if (_token == null) return;
    _wsChannel?.sink.close();

    final wsUri = Uri.parse(
      '${_serverUrl.replaceFirst(RegExp(r'^http'), 'ws')}/ws?token=${Uri.encodeComponent(_token!)}',
    );

    final channel = WebSocketChannel.connect(wsUri);
    _wsChannel = channel;

    channel.stream.listen(
      (message) {
        final data = jsonDecode(message as String) as Map<String, dynamic>;
        _handleServerMessage(data);
      },
      onDone: () {
        if (mounted) {
          setState(() {
            _wsConnected = false;
          });
        }
      },
      onError: (_) {
        if (mounted) {
          setState(() {
            _wsConnected = false;
          });
        }
      },
    );
  }

  void _handleServerMessage(Map<String, dynamic> msg) {
    final type = msg['type'] as String?;
    final payload = msg['payload'] as Map<String, dynamic>?;

    if (!mounted) return;

    switch (type) {
      case 'welcome':
        setState(() {
          _wsConnected = true;
          _currentUser = payload?['self_profile'] as Map<String, dynamic>?;
          _contacts = (payload?['contacts'] as List<dynamic>?) ?? [];
          _incomingRequests = (payload?['incoming_requests'] as List<dynamic>?) ?? [];
          _outgoingRequests = (payload?['outgoing_requests'] as List<dynamic>?) ?? [];
        });
        break;

      case 'contacts_updated':
        setState(() {
          _contacts = (payload?['contacts'] as List<dynamic>?) ?? [];
          _incomingRequests = (payload?['incoming_requests'] as List<dynamic>?) ?? [];
          _outgoingRequests = (payload?['outgoing_requests'] as List<dynamic>?) ?? [];
        });
        break;

      case 'room_updated':
        final room = payload?['room'] as Map<String, dynamic>?;
        final wasInRoom = _currentRoom != null && _currentRoom!['id'] == room?['id'];
        setState(() {
          _currentRoom = room;
          _incomingCall = null;
          if (!wasInRoom && room != null) {
            _selectedTabIndex = 1; // Переключаем на экран звонка при старте урока
          }
        });
        if (room != null) {
          _ensureRoomMediaConnected(room);
        }
        break;

      case 'incoming_call':
        setState(() {
          _incomingCall = payload;
        });
        break;

      case 'call_declined':
        setState(() {
          _statusMessage = 'Пользователь @${payload?['declined_by']} отклонил звонок';
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
        _chatMessages.clear();
        _seenMessageIds.clear();
        for (final item in list) {
          if (item is Map<String, dynamic>) {
            _handleIncomingEncryptedChat(item);
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

  void _sendWs(Map<String, dynamic> data) {
    _wsChannel?.sink.add(jsonEncode(data));
  }

  Future<void> _submitAuth() async {
    setState(() {
      _authLoading = true;
      _authError = null;
      _serverUrl = _serverUrlCtrl.text.trim();
    });

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('liaper_server_url', _serverUrl);

    try {
      final endpoint = _isRegister ? '/api/auth/register' : '/api/auth/login';
      final body = _isRegister
          ? {
              'username': _usernameCtrl.text.trim(),
              'display_name': _displayNameCtrl.text.trim().isEmpty
                  ? _usernameCtrl.text.trim()
                  : _displayNameCtrl.text.trim(),
              'password': _passwordCtrl.text,
              'role': _selectedRole,
              'e2ee_public_key': _publicKeyB64,
              'key_fingerprint': _fingerprint,
            }
          : {
              'username': _usernameCtrl.text.trim(),
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

      setState(() {
        _token = token;
        _currentUser = user;
        _authLoading = false;
      });

      _connectWebSocket();
    } catch (_) {
      setState(() {
        _authError = 'Нет связи с сервером ($_serverUrl). Проверьте подключение.';
        _authLoading = false;
      });
    }
  }

  Future<void> _logout() async {
    await _stopLocalMediaAndSfu();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('liaper_token');
    await prefs.remove('liaper_user');
    _wsChannel?.sink.close();
    setState(() {
      _token = null;
      _currentUser = null;
      _currentRoom = null;
      _chatMessages.clear();
      _seenMessageIds.clear();
    });
  }

  // ===========================================================================
  // Действия с контактами и звонками
  // ===========================================================================
  void _sendContactRequest() {
    final nick = _addContactCtrl.text.trim().replaceAll('@', '');
    if (nick.isEmpty) return;
    _sendWs({
      'type': 'send_contact_request',
      'payload': {'target_username': nick},
    });
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

  void _removeContact(String contactUserId, String username) {
    _sendWs({
      'type': 'remove_contact',
      'payload': {'contact_user_id': contactUserId},
    });
    setState(() {
      _statusMessage = 'Контакт @$username удалён';
    });
  }

  void _callByNick(String username, {bool withVideo = true}) {
    final clean = username.trim().replaceAll('@', '');
    if (clean.isEmpty) return;
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
    _sendWs({
      'type': 'leave_room',
      'payload': {'room_id': _currentRoom!['id']},
    });
    _stopLocalMediaAndSfu();
    setState(() {
      _currentRoom = null;
      _chatMessages.clear();
      _seenMessageIds.clear();
      _selectedTabIndex = 0;
    });
  }

  void _showCreateGroupDialog() {
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
                        style: TextStyle(color: Color(0xFF64748B), fontSize: 13),
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
    try {
      final uri = Uri.parse(
        '$_serverUrl/api/releases/check?platform=$kPlatformAndroid&version=$kCurrentAppVersion',
      );
      final res = await http.get(uri).timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        if (!mounted) return;
        setState(() {
          _updateAvailable = data['update_available'] == true;
          _latestRelease = data['latest'] as Map<String, dynamic>?;
        });
      }
    } catch (_) {}
  }

  Future<void> _downloadAndInstallApk() async {
    if (_latestRelease == null) return;
    final downloadUrl = _latestRelease!['download_url'] as String;
    final expectedSha256 = (_latestRelease!['sha256'] as String).toLowerCase();
    final version = _latestRelease!['version'] as String;

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
      if (expectedSha256.isNotEmpty &&
          expectedSha256 !=
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' &&
          actualSha256 != expectedSha256) {
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

    return Scaffold(
      backgroundColor: isInCallTab ? const Color(0xFF0F172A) : const Color(0xFFF8FAFC),
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
            // Уведомление или статус
            if (_statusMessage != null)
              Container(
                margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: const Color(0xFF1E293B),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        _statusMessage!,
                        style: const TextStyle(color: Colors.white, fontSize: 12),
                      ),
                    ),
                    GestureDetector(
                      onTap: () => setState(() => _statusMessage = null),
                      child: const Icon(Icons.close, size: 16, color: Colors.white70),
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
      bottomNavigationBar: NavigationBar(
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
            label: 'Звонок',
          ),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: _unreadChatCount > 0,
              label: Text('$_unreadChatCount'),
              child: const Icon(Icons.chat_bubble_outline),
            ),
            selectedIcon: const Icon(Icons.chat_bubble),
            label: 'Чат',
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
                  icon: const Icon(Icons.call_end, size: 18, color: Color(0xFFF43F5E)),
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
    final search = _searchContactCtrl.text.trim().toLowerCase();
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
                  const Expanded(
                    child: Text(
                      'Добавить контакт по @нику',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton.icon(
                    onPressed: _showCreateGroupDialog,
                    style: OutlinedButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: const Color(0xFF0F172A),
                      side: const BorderSide(color: Color(0xFFCBD5E1)),
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    ),
                    icon: const Icon(Icons.group_add_outlined, size: 16),
                    label: const Text(
                      'Группа',
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              const Text(
                'Звонки доступны только после взаимного подтверждения заявки',
                style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _addContactCtrl,
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
                          borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(10),
                          borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                        ),
                      ),
                      onSubmitted: (_) => _sendContactRequest(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _sendContactRequest,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
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
                                onPressed: () =>
                                    _respondContactRequest(r['id'] as String, true),
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
                                onPressed: () =>
                                    _respondContactRequest(r['id'] as String, false),
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
            child: const Column(
              children: [
                Icon(Icons.people_outline, size: 40, color: Color(0xFF94A3B8)),
                SizedBox(height: 10),
                Text(
                  'Список контактов пуст',
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                    color: Color(0xFF334155),
                  ),
                ),
                SizedBox(height: 4),
                Text(
                  'Отправьте заявку по @нику выше и дождитесь подтверждения, чтобы начать звонки и уроки.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
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
                          displayName.substring(0, displayName.length >= 2 ? 2 : 1).toUpperCase(),
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
                  const SizedBox(width: 6),
                  IconButton.filledTonal(
                    onPressed: () => _callByNick(username, withVideo: false),
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                    padding: EdgeInsets.zero,
                    style: IconButton.styleFrom(
                      backgroundColor: const Color(0xFFF1F5F9),
                      foregroundColor: const Color(0xFF0F172A),
                    ),
                    tooltip: 'Аудиозвонок',
                    icon: const Icon(Icons.call, size: 18),
                  ),
                  const SizedBox(width: 4),
                  IconButton.filled(
                    onPressed: () => _callByNick(username, withVideo: true),
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                    padding: EdgeInsets.zero,
                    style: IconButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      foregroundColor: Colors.white,
                    ),
                    tooltip: 'Видеозвонок',
                    icon: const Icon(Icons.videocam, size: 18),
                  ),
                  const SizedBox(width: 2),
                  IconButton(
                    onPressed: () => _removeContact(u['id'] as String, username),
                    visualDensity: VisualDensity.compact,
                    constraints: const BoxConstraints(minWidth: 32, minHeight: 36),
                    padding: EdgeInsets.zero,
                    tooltip: 'Удалить из контактов',
                    icon: const Icon(
                      Icons.delete_outline,
                      size: 18,
                      color: Color(0xFF94A3B8),
                    ),
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
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
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

    final participants = (_currentRoom!['participants'] as List<dynamic>?) ?? [];
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
    final primaryRemoteFrame =
        primaryPeerId != null ? _remoteVideoFrames[primaryPeerId] : null;
    final isPrimaryScreenShare = primaryPeer?['screen_share_enabled'] == true;

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
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xFF1E293B).withValues(alpha: 0.85),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.white12),
              ),
              child: Row(
                children: [
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
                  if (primaryRemoteFrame != null)
                    IconButton(
                      onPressed: () {
                        setState(() {
                          _fitContain = !_fitContain;
                        });
                      },
                      tooltip: _fitContain ? 'Заполнить экран' : 'Вписать целиком',
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
          if (remoteParticipants.length > 1)
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
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: isSelected
                            ? const Color(0xFF334155)
                            : const Color(0xFF1E293B).withValues(alpha: 0.8),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: isSelected ? const Color(0xFF38BDF8) : Colors.white12,
                        ),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            peer['audio_enabled'] == true ? Icons.mic : Icons.mic_off,
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

          // 4. Локальное превью камеры (Picture-in-Picture в углу)
          if (_camEnabled && _localStream != null)
            Positioned(
              right: 14,
              bottom: 100,
              width: 108,
              height: 152,
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
                        objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
                      ),
                      Positioned(
                        top: 6,
                        right: 6,
                        child: GestureDetector(
                          onTap: _switchCameraDirection,
                          child: Container(
                            padding: const EdgeInsets.all(5),
                            decoration: const BoxDecoration(
                              color: Colors.black54,
                              shape: BoxShape.circle,
                            ),
                            child: const Icon(
                              Icons.cameraswitch,
                              size: 16,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                    ],
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
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
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
                  if (_camEnabled)
                    _buildCallControlButton(
                      icon: Icons.cameraswitch_outlined,
                      label: 'Поворот',
                      active: false,
                      onTap: _switchCameraDirection,
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
    final name = (peer['display_name'] ?? peer['username'] ?? 'Участник').toString();
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
                  color: audioOn ? const Color(0xFF34D399) : const Color(0xFFF43F5E),
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

    return GestureDetector(
      onTap: onTap,
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
            style: const TextStyle(
              color: Colors.white70,
              fontSize: 11,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
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
  // ВКЛАДКА 3: Чат урока (совместимый с веб-приложением)
  // ===========================================================================
  Widget _buildChatTab() {
    if (_currentRoom == null) {
      return Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: Colors.white,
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: const Icon(
                  Icons.chat_bubble_outline,
                  size: 28,
                  color: Color(0xFF64748B),
                ),
              ),
              const SizedBox(height: 14),
              const Text(
                'Чат доступен во время урока',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF0F172A),
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Позвоните контакту или присоединитесь к групповому уроку, чтобы обмениваться сообщениями и материалами.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
              ),
            ],
          ),
        ),
      );
    }

    final myId = _currentUser?['id']?.toString();

    return Column(
      children: [
        // Шапка чата комнаты
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: const BoxDecoration(
            color: Colors.white,
            border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
          ),
          child: Row(
            children: [
              const Icon(Icons.forum_outlined, size: 20, color: Color(0xFF0F172A)),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Чат: ${_currentRoom!['title']}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                    const Text(
                      'Сообщения синхронизируются со всеми участниками урока',
                      style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                    ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: () => setState(() => _selectedTabIndex = 1),
                icon: const Icon(Icons.videocam, size: 16),
                label: const Text('К видео'),
              ),
            ],
          ),
        ),

        // Список сообщений
        Expanded(
          child: _chatMessages.isEmpty
              ? const Center(
                  child: Text(
                    'Сообщений пока нет. Напишите первым!',
                    style: TextStyle(color: Color(0xFF94A3B8), fontSize: 13),
                  ),
                )
              : ListView.builder(
                  controller: _chatScrollCtrl,
                  padding: const EdgeInsets.all(16),
                  itemCount: _chatMessages.length,
                  itemBuilder: (_, idx) {
                    final m = _chatMessages[idx];
                    final isMe = m.senderId == myId;
                    String timeLabel = '';
                    try {
                      final dt = DateTime.parse(m.sentAt).toLocal();
                      timeLabel =
                          '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
                    } catch (_) {}

                    return Align(
                      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.only(bottom: 10),
                        constraints: BoxConstraints(
                          maxWidth: MediaQuery.of(context).size.width * 0.78,
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: isMe ? const Color(0xFF0F172A) : Colors.white,
                          borderRadius: BorderRadius.circular(16),
                          border: isMe
                              ? null
                              : Border.all(color: const Color(0xFFE2E8F0)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  isMe
                                      ? 'Вы'
                                      : '${m.senderDisplayName} (@${m.senderUsername})',
                                  style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                    color: isMe
                                        ? const Color(0xFF94A3B8)
                                        : const Color(0xFF64748B),
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
                                color: isMe ? Colors.white : const Color(0xFF0F172A),
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
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _sendChatMessage(),
                  decoration: InputDecoration(
                    hintText: 'Написать сообщение в чат урока...',
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
                onPressed: _sendChatMessage,
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
                  displayName
                      .substring(0, displayName.length >= 2 ? 2 : 1)
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
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text(
                    'Версия приложения',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 14,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                  Text(
                    'v$kCurrentAppVersion',
                    style: const TextStyle(
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
                  style: const TextStyle(fontSize: 13, color: Color(0xFF334155)),
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
                  onPressed: _checkForUpdates,
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Проверить наличие обновлений'),
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
                      segments: const [
                        ButtonSegment(value: true, label: Text('Регистрация')),
                        ButtonSegment(value: false, label: Text('Вход')),
                      ],
                      selected: {_isRegister},
                      onSelectionChanged: (s) {
                        setState(() {
                          _isRegister = s.first;
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _usernameCtrl,
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
                        decoration: InputDecoration(
                          labelText: 'Ваше имя',
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
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
                      obscureText: true,
                      decoration: InputDecoration(
                        labelText: 'Пароль',
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
                        decoration: InputDecoration(
                          labelText: 'Адрес сервера управления',
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
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
                      onPressed: _authLoading ? null : _submitAuth,
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
