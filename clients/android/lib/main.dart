import 'dart:async';
import 'dart:convert';
import 'dart:ui' show ImageFilter;
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
import 'widgets/chat_attachment_widgets.dart';
import 'services/lesson_archive.dart';
import 'services/e2ee_attachments.dart';
import 'services/pow.dart';
import 'widgets/liaper_logo.dart';

const SystemUiOverlayStyle kLiaperSystemUiStyle = SystemUiOverlayStyle(
  statusBarColor: Colors.transparent,
  statusBarIconBrightness: Brightness.dark,
  statusBarBrightness: Brightness.light,
  systemNavigationBarColor: Colors.white,
  systemNavigationBarDividerColor: Colors.white,
  systemNavigationBarIconBrightness: Brightness.dark,
  systemNavigationBarContrastEnforced: false,
);

/// Адрес сервера по умолчанию: `flutter build apk --dart-define=LIAPER_SERVER_URL=https://lessons.example.com`
const String _defaultServerUrl = String.fromEnvironment(
  'LIAPER_SERVER_URL',
  defaultValue: 'http://127.0.0.1:4000',
);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(kLiaperSystemUiStyle);
  runApp(const LiaperMobileApp());
}

const String kCurrentAppVersion = '0.2.0';
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
        scaffoldBackgroundColor: const Color(0xFFF6F7FB),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF4F46E5),
          brightness: Brightness.light,
          primary: const Color(0xFF4F46E5),
          onPrimary: Colors.white,
          secondary: const Color(0xFF7C3AED),
          surface: Colors.white,
          onSurface: const Color(0xFF0F172A),
          outline: const Color(0xFFCBD5E1),
          outlineVariant: const Color(0xFFE5E7EB),
        ),
        useMaterial3: true,
        visualDensity: VisualDensity.standard,
        appBarTheme: const AppBarTheme(
          systemOverlayStyle: kLiaperSystemUiStyle,
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          foregroundColor: Color(0xFF0F172A),
          elevation: 0,
          scrolledUnderElevation: 0.5,
          centerTitle: false,
          titleTextStyle: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: Color(0xFF0F172A)),
        ),
        cardTheme: CardThemeData(
          color: Colors.white,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: Color(0xFFE5E7EB)),
          ),
        ),
        dividerTheme:
            const DividerThemeData(color: Color(0xFFE5E7EB), space: 1),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Color(0xFF4F46E5), width: 2),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: const Size(48, 50),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            textStyle:
                const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            minimumSize: const Size(48, 50),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            side: const BorderSide(color: Color(0xFFCBD5E1)),
            textStyle:
                const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ),
        segmentedButtonTheme: SegmentedButtonThemeData(
          style: SegmentedButton.styleFrom(
            selectedBackgroundColor: const Color(0xFFEEF2FF),
            selectedForegroundColor: const Color(0xFF3730A3),
          ),
        ),
        navigationBarTheme: NavigationBarThemeData(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          indicatorColor: const Color(0xFFEEF2FF),
          labelTextStyle: WidgetStateProperty.resolveWith((states) => TextStyle(
                fontSize: 12,
                fontWeight: states.contains(WidgetState.selected)
                    ? FontWeight.w600
                    : FontWeight.w500,
              )),
        ),
        snackBarTheme: SnackBarThemeData(
          behavior: SnackBarBehavior.floating,
          backgroundColor: const Color(0xFF1E1B4B),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
        dialogTheme: DialogThemeData(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        ),
      ),
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        final bottomSystemInset = mq.viewPadding.bottom;
        final adjustedKeyboardBottom =
            (mq.viewInsets.bottom - bottomSystemInset)
                .clamp(0.0, double.infinity);

        return AnnotatedRegion<SystemUiOverlayStyle>(
          value: kLiaperSystemUiStyle,
          child: ColoredBox(
            color: Colors.white,
            child: Column(
              children: [
                Expanded(
                  child: MediaQuery(
                    data: mq.copyWith(
                      padding: mq.padding.copyWith(bottom: 0),
                      viewPadding: mq.viewPadding.copyWith(bottom: 0),
                      viewInsets: mq.viewInsets.copyWith(
                        bottom: adjustedKeyboardBottom,
                      ),
                    ),
                    child: child ?? const SizedBox.shrink(),
                  ),
                ),
                if (bottomSystemInset > 0)
                  Container(
                    width: double.infinity,
                    height: bottomSystemInset,
                    color: Colors.white,
                  ),
              ],
            ),
          ),
        );
      },
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
  final String? editedAt;
  final String ciphertextB64;
  final String ivB64;
  final String roomKeyId;
  final ChatAttachmentMeta? attachment;
  final ForwardedFrom? forwarded;
  final bool locked;
  final bool verifiedE2ee;

  ChatMessageItem({
    required this.id,
    required this.roomId,
    required this.senderId,
    required this.senderUsername,
    required this.senderDisplayName,
    required this.text,
    required this.sentAt,
    this.editedAt,
    this.ciphertextB64 = '',
    this.ivB64 = '',
    this.roomKeyId = '',
    this.attachment,
    this.forwarded,
    this.locked = false,
    this.verifiedE2ee = true,
  });
}

class LiaperHomeScreen extends StatefulWidget {
  const LiaperHomeScreen({super.key});

  @override
  State<LiaperHomeScreen> createState() => _LiaperHomeScreenState();
}

class _LiaperHomeScreenState extends State<LiaperHomeScreen> {
  static const MethodChannel _mediaChannel = MethodChannel('com.liaper.audio');

  String _serverUrl = _defaultServerUrl;
  final TextEditingController _serverUrlCtrl =
      TextEditingController(text: _defaultServerUrl);

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
  bool _authCheckingRobot = false;
  String? _authError;
  bool _showServerConfig = false;

  String? _token;
  Map<String, dynamic>? _currentUser;

  // Ключи идентификации X25519 и связка ключей комнат (E2EE)
  IdentityCryptoBundle? _myIdentity;
  String _publicKeyB64 = '';
  String _fingerprint = '';
  final Map<String, RoomKeyring> _roomKeyrings = {};
  final Set<String> _deliveredEnvelopeCache = {};
  List<String> _prevRoomParticipantIds = [];

  // Навигация
  int _selectedTabIndex = 0; // 0: Контакты, 1: Звонок, 2: Чат, 3: Профиль
  int _unreadChatCount = 0;
  int _storageRefreshTrigger = 0;

  // Состояние WebSocket и контактов
  WebSocketChannel? _wsChannel;
  bool _wsConnected = false;
  Timer? _reconnectTimer;
  int _reconnectFailures = 0;
  List<dynamic> _contacts = [];
  List<dynamic> _incomingRequests = [];
  List<dynamic> _outgoingRequests = [];
  Map<String, dynamic>? _currentRoom;
  Map<String, dynamic>? _incomingCallData;
  bool _notificationPermissionAsked = false;

  Map<String, dynamic>? get _incomingCall => _incomingCallData;
  // Любая смена входящего звонка включает/выключает рингтон, вибрацию и уведомление
  set _incomingCall(Map<String, dynamic>? call) {
    final prevId = _incomingCallData?['room']?['id']?.toString();
    final nextId = call?['room']?['id']?.toString();
    _incomingCallData = call;
    if (prevId == nextId) return;
    if (call == null) {
      _mediaChannel.invokeMethod('stopRinging').catchError((_) => null);
      return;
    }
    final caller = call['caller'] as Map<String, dynamic>? ?? const {};
    final displayName = (caller['display_name'] ?? '').toString();
    _mediaChannel.invokeMethod('startRinging', {
      'callerName':
          displayName.isNotEmpty ? displayName : '@${caller['username'] ?? ''}',
      'roomTitle': (call['room']?['title'] ?? '').toString(),
      'withVideo': call['with_video'] == true,
    }).catchError((_) => null);
  }
  // Урок этого аккаунта, который сейчас идёт на другом устройстве
  Map<String, dynamic>? _otherDeviceCall;
  // true — это не другое устройство, а урок, из которого выбило перезапуском приложения
  bool _otherDeviceIsResume = false;

  // Поля контактов и комнат
  final TextEditingController _addContactCtrl = TextEditingController();
  final TextEditingController _searchContactCtrl = TextEditingController();
  final TextEditingController _inviteInCallCtrl = TextEditingController();

  // Чат урока, личные диалоги, вложения и архив уроков
  final TextEditingController _chatInputCtrl = TextEditingController();
  final ScrollController _chatScrollCtrl = ScrollController();
  final List<ChatMessageItem> _chatMessages = [];
  final Set<String> _seenMessageIds = {};
  final List<OutgoingAttachmentTransfer> _outgoingTransfers = [];
  String _chatMode = 'lesson'; // 'lesson' | 'direct' | 'archive'
  Map<String, dynamic>? _selectedChatContact;
  String? _selectedArchiveId;
  final Set<String> _selectedArchiveMsgIds = {};
  bool _forwardingFromArchive = false;
  bool _showEmojiPicker = false;
  int _emojiCategoryIdx = 0;
  ChatMessageItem? _editingMessage;

  static const List<Map<String, dynamic>> _kEmojiCategories = [
    {
      'label': '😀 Эмоции',
      'items': [
        '😀',
        '😃',
        '😄',
        '😁',
        '😆',
        '😅',
        '😂',
        '🤣',
        '😊',
        '😇',
        '🙂',
        '🙃',
        '😉',
        '😌',
        '😍',
        '🥰',
        '😘',
        '😋',
        '😛',
        '😜',
        '🤪',
        '🤨',
        '🧐',
        '🤓',
        '😎',
        '🥳',
        '😏',
        '😒',
        '😞',
        '😔',
        '😟',
        '😕',
        '🙁',
        '😣',
        '😖',
        '😫',
        '🥺',
        '😢',
        '😭',
        '😤',
        '😠',
        '😡',
        '🤯',
        '😳',
        '😱',
        '🤗',
        '🤔',
        '🤭',
        '🤫',
        '😶',
        '😐',
        '🙄',
        '😯',
        '😮',
        '😲',
        '🥱',
        '😴',
        '🤤',
        '😷',
        '🤒',
      ],
    },
    {
      'label': '🎓 Учёба и жесты',
      'items': [
        '👍',
        '👎',
        '👌',
        '✌️',
        '🤞',
        '🤟',
        '🤘',
        '🤙',
        '👈',
        '👉',
        '👆',
        '👇',
        '☝️',
        '✋',
        '👋',
        '🤝',
        '🙏',
        '✍️',
        '💪',
        '🧠',
        '👀',
        '💡',
        '📚',
        '📖',
        '📝',
        '✏️',
        '🖊️',
        '📐',
        '📏',
        '📊',
        '📈',
        '📌',
        '📎',
        '🔍',
        '🎓',
        '🏫',
        '🏆',
        '🥇',
        '🥈',
        '🥉',
        '🎯',
        '✅',
        '❌',
        '❓',
        '❗',
        '💯',
        '🔥',
        '⭐',
        '🌟',
        '✨',
        '🎉',
        '🎊',
        '👏',
        '🙌',
        '🫶',
        '🫡',
        '💻',
        '🖥️',
        '📱',
        '🎧',
      ],
    },
    {
      'label': '❤️ Сердца и разное',
      'items': [
        '❤️',
        '🧡',
        '💛',
        '💚',
        '💙',
        '💜',
        '🖤',
        '🤍',
        '🤎',
        '💔',
        '❣️',
        '💕',
        '💞',
        '💓',
        '💗',
        '💖',
        '💘',
        '💝',
        '💟',
        '☀️',
        '🌈',
        '☁️',
        '❄️',
        '⚡',
        '🌸',
        '🌺',
        '🌻',
        '🍀',
        '🍎',
        '🍓',
        '🍕',
        '☕',
        '🍵',
        '🍰',
        '🍫',
        '🚀',
        '✈️',
        '⏰',
        '⏳',
        '🔔',
        '💬',
        '💭',
        '🎵',
        '🎶',
        '🎨',
        '🧩',
        '🎲',
        '🐱',
        '🐶',
        '🦊',
      ],
    },
  ];
  List<Map<String, dynamic>> _archivedChats = [];
  SecretKey? _archiveKey;
  bool _archiveSyncing = false;
  bool _archiveSyncAgain = false;
  String _archiveSyncStatus =
      'Для синхронизации разблокируйте архив паролем аккаунта';
  Timer? _archiveSaveTimer;

  // Запись голосовых сообщений (WAV) и видеокружков (LPVN v1)
  String _noteRecordMode =
      'idle'; // 'idle' | 'recording_voice' | 'recording_video' | 'preview_voice' | 'preview_video'
  int _noteElapsedMs = 0;
  int _noteStartedAtMs = 0;
  Timer? _noteTimer;
  Timer? _noteFrameCaptureTimer;
  bool _capturingNoteFrame = false;
  bool _noteUsingSharedCallStream = false;
  final RTCVideoRenderer _noteRenderer = RTCVideoRenderer();
  MediaStream? _noteCameraStream;
  final List<LpvnVideoFrame> _recordedNoteFrames = [];
  Uint8List? _previewPayloadBytes;
  Uint8List? _previewWavBytes;
  int _previewDurationMs = 0;
  bool _previewPlaying = false;
  int _previewPlayFrameIdx = 0;
  Timer? _previewPlayTimer;

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
    _noteRenderer.initialize();
    _mediaChannel.setMethodCallHandler((call) async {
      if (call.method == 'onPcm16Chunk') {
        final dynamic raw = call.arguments;
        if (raw is Uint8List) {
          _sendAudioPcmToSfu(raw);
        }
      } else if (call.method == 'onCallNotificationAction') {
        if (_incomingCall == null) return;
        if (call.arguments == 'accept') {
          _acceptIncomingCall();
        } else if (call.arguments == 'decline') {
          _declineIncomingCall();
        }
      }
    });
    _initIdentityAndSession();
  }

  @override
  void dispose() {
    _reconnectTimer?.cancel();
    _archiveSaveTimer?.cancel();
    _noteTimer?.cancel();
    _noteFrameCaptureTimer?.cancel();
    _previewPlayTimer?.cancel();
    _token = null;
    _mediaChannel.invokeMethod('stopRinging').catchError((_) => null);
    _mediaChannel.setMethodCallHandler(null);
    _stopNoteCameraStream();
    _stopLocalMediaAndSfu();
    _localRenderer.dispose();
    _noteRenderer.dispose();
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

  List<Map<String, dynamic>> _getRoomRecipients(String roomId) {
    final myId = _currentUser?['id']?.toString();
    if (myId == null) return [];
    final recipients = <Map<String, dynamic>>[];

    if (_currentRoom != null && _currentRoom!['id']?.toString() == roomId) {
      final participants =
          (_currentRoom!['participants'] as List<dynamic>?) ?? [];
      final participantIds = participants
          .map((p) => (p as Map<String, dynamic>)['user_id']?.toString())
          .whereType<String>()
          .where((id) => id != myId)
          .toSet();
      for (final raw in _contacts) {
        final c = raw as Map<String, dynamic>;
        final cId = c['id']?.toString();
        if (cId != null && participantIds.contains(cId)) {
          recipients.add(c);
        }
      }
      return recipients;
    }

    for (final raw in _contacts) {
      final c = raw as Map<String, dynamic>;
      final cId = c['id']?.toString();
      if (cId != null && _computeDmRoomId(myId, cId) == roomId) {
        recipients.add(c);
      }
    }
    return recipients;
  }

  Future<void> _registerRoomKey(
    String roomId,
    RoomSecretKeyBundle bundle, {
    bool makeActive = true,
  }) async {
    final existing = _roomKeyrings[roomId];
    if (existing == null) {
      _roomKeyrings[roomId] = RoomKeyring(
        activeKey: bundle,
        keysById: {bundle.roomKeyId: bundle},
      );
    } else {
      existing.keysById[bundle.roomKeyId] = bundle;
      if (makeActive) {
        existing.activeKey = bundle;
      }
    }
    final prefs = await SharedPreferences.getInstance();
    await AndroidE2eeService.saveRoomKeyrings(prefs, _roomKeyrings);

    final ring = _roomKeyrings[roomId];
    bool updatedAny = false;
    for (int i = 0; i < _chatMessages.length; i++) {
      final m = _chatMessages[i];
      if (m.roomId == roomId && m.locked && m.ciphertextB64.isNotEmpty) {
        try {
          final dec = await AndroidE2eeService.decryptChatMessageWithKeyring(
            roomId: roomId,
            ciphertextB64: m.ciphertextB64,
            ivB64: m.ivB64,
            roomKeyId: m.roomKeyId,
            keyring: ring,
          );
          _chatMessages[i] = ChatMessageItem(
            id: m.id,
            roomId: m.roomId,
            senderId: m.senderId,
            senderUsername: m.senderUsername,
            senderDisplayName: m.senderDisplayName,
            text: dec.plaintext,
            sentAt: m.sentAt,
            editedAt: m.editedAt,
            ciphertextB64: m.ciphertextB64,
            ivB64: m.ivB64,
            roomKeyId: m.roomKeyId,
            attachment: dec.attachment,
            forwarded: dec.forwarded,
            locked: false,
            verifiedE2ee: dec.verifiedE2ee,
          );
          updatedAny = true;
        } catch (_) {}
      }
    }
    if (updatedAny && mounted) {
      setState(() {});
    }
  }

  Future<void> _distributeRoomKeyToRecipients(
    String roomId,
    RoomSecretKeyBundle bundle, {
    bool forceResend = false,
  }) async {
    if (!_wsConnected || _currentUser == null || _myIdentity == null) return;
    final senderId = _currentUser!['id'].toString();
    final senderUsername = _currentUser!['username'].toString();
    final recipients = _getRoomRecipients(roomId);

    for (final r in recipients) {
      final rId = (r['id'] ?? '').toString();
      final rUsername = (r['username'] ?? '').toString();
      final rPubField = r['e2ee_public_key']?.toString();
      final cacheKey = '$roomId:${bundle.roomKeyId}:$rId:${rPubField ?? ''}';
      if (!forceResend && _deliveredEnvelopeCache.contains(cacheKey)) {
        continue;
      }
      final envelopes = await AndroidE2eeService.createKeyEnvelopesForUser(
        roomId: roomId,
        senderId: senderId,
        senderUsername: senderUsername,
        myIdentity: _myIdentity!,
        recipientId: rId,
        recipientUsername: rUsername,
        recipientPublicKeysField: rPubField,
        roomKeyBundle: bundle,
      );
      if (envelopes.isNotEmpty) {
        bool allSent = true;
        for (final env in envelopes) {
          if (!_sendWs({
            'type': 'send_key_envelope',
            'payload': {'envelope': env},
          })) {
            allSent = false;
          }
        }
        if (allSent) {
          _deliveredEnvelopeCache.add(cacheKey);
        }
      }
    }
  }

  Future<RoomSecretKeyBundle> _ensureActiveRoomKey(
    String roomId, {
    bool forceRotate = false,
  }) async {
    final existing = _roomKeyrings[roomId];
    if (existing != null && !forceRotate) {
      await _distributeRoomKeyToRecipients(roomId, existing.activeKey);
      return existing.activeKey;
    }
    final generated = await AndroidE2eeService.generateRoomKey();
    await _registerRoomKey(roomId, generated, makeActive: true);
    await _distributeRoomKeyToRecipients(
      roomId,
      generated,
      forceResend: true,
    );
    return generated;
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
    final roomKeyId = (rawMsg['room_key_id'] ?? '').toString();
    final sentAt = (rawMsg['created_at'] ?? rawMsg['sent_at'] ?? '').toString();
    final editedAt = rawMsg['edited_at']?.toString();

    String decryptedText = 'Ожидание ключа шифрования…';
    ChatAttachmentMeta? attachment;
    ForwardedFrom? forwarded;
    bool locked = true;
    bool verifiedE2ee = false;

    try {
      final res = await AndroidE2eeService.decryptChatMessageWithKeyring(
        roomId: roomId,
        ciphertextB64: ciphertextB64,
        ivB64: ivB64,
        roomKeyId: roomKeyId,
        keyring: _roomKeyrings[roomId],
      );
      decryptedText = res.plaintext;
      attachment = res.attachment;
      forwarded = res.forwarded;
      locked = false;
      verifiedE2ee = res.verifiedE2ee;
    } catch (_) {}

    if (!mounted || sessionToken != _token) return;

    setState(() {
      _chatMessages.add(
        ChatMessageItem(
          id: msgId,
          roomId: roomId,
          senderId: senderId,
          senderUsername: senderUsername,
          senderDisplayName: senderDisplayName,
          text: decryptedText,
          sentAt: sentAt,
          editedAt: editedAt,
          ciphertextB64: ciphertextB64,
          ivB64: ivB64,
          roomKeyId: roomKeyId,
          attachment: attachment,
          forwarded: forwarded,
          locked: locked,
          verifiedE2ee: verifiedE2ee,
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

  Future<void> _handleEditedEncryptedChat(Map<String, dynamic> rawMsg) async {
    final sessionToken = _token;
    final msgId = (rawMsg['id'] ?? '').toString();
    if (msgId.isEmpty) return;

    final roomId = (rawMsg['room_id'] ?? '').toString();
    final senderId = (rawMsg['sender_id'] ?? '').toString();
    final senderUsername = (rawMsg['sender_username'] ?? '').toString();
    final senderDisplayName =
        (rawMsg['sender_display_name'] ?? senderUsername).toString();
    final ciphertextB64 = (rawMsg['ciphertext_b64'] ?? '').toString();
    final ivB64 = (rawMsg['iv_b64'] ?? '').toString();
    final roomKeyId = (rawMsg['room_key_id'] ?? '').toString();
    final sentAt = (rawMsg['created_at'] ?? rawMsg['sent_at'] ?? '').toString();
    final editedAt =
        (rawMsg['edited_at'] ?? DateTime.now().toUtc().toIso8601String())
            .toString();

    String decryptedText = 'Ожидание ключа шифрования…';
    ChatAttachmentMeta? attachment;
    ForwardedFrom? forwarded;
    bool locked = true;
    bool verifiedE2ee = false;

    try {
      final res = await AndroidE2eeService.decryptChatMessageWithKeyring(
        roomId: roomId,
        ciphertextB64: ciphertextB64,
        ivB64: ivB64,
        roomKeyId: roomKeyId,
        keyring: _roomKeyrings[roomId],
      );
      decryptedText = res.plaintext;
      attachment = res.attachment;
      forwarded = res.forwarded;
      locked = false;
      verifiedE2ee = res.verifiedE2ee;
    } catch (_) {}

    if (!mounted || sessionToken != _token) return;

    setState(() {
      final idx = _chatMessages.indexWhere((m) => m.id == msgId);
      if (idx >= 0) {
        _chatMessages[idx] = ChatMessageItem(
          id: msgId,
          roomId: roomId,
          senderId: senderId,
          senderUsername: senderUsername,
          senderDisplayName: senderDisplayName,
          text: decryptedText,
          sentAt: sentAt,
          editedAt: editedAt,
          ciphertextB64: ciphertextB64,
          ivB64: ivB64,
          roomKeyId: roomKeyId,
          attachment: attachment ?? _chatMessages[idx].attachment,
          forwarded: forwarded ?? _chatMessages[idx].forwarded,
          locked: locked,
          verifiedE2ee: verifiedE2ee,
        );
      }
    });
  }

  void _handleDeletedEncryptedChat(Map<String, dynamic>? payload) {
    if (payload == null || !mounted) return;
    final msgId = (payload['message_id'] ?? '').toString();
    if (msgId.isEmpty) return;
    setState(() {
      _chatMessages.removeWhere((m) => m.id == msgId);
      if (_editingMessage?.id == msgId) {
        _editingMessage = null;
        _chatInputCtrl.clear();
      }
    });
  }

  void _startEditingChatMessage(ChatMessageItem m) {
    final isDefaultCaption = m.attachment != null &&
        (m.text.startsWith('Вложение: ') ||
            m.text.startsWith('Голосовое сообщение') ||
            m.text.startsWith('Видеокружок'));
    setState(() {
      _editingMessage = m;
      _chatInputCtrl.text = isDefaultCaption ? '' : m.text;
      _chatInputCtrl.selection = TextSelection.fromPosition(
        TextPosition(offset: _chatInputCtrl.text.length),
      );
    });
  }

  void _deleteChatMessage(ChatMessageItem m) {
    _sendWs({
      'type': 'delete_encrypted_chat',
      'payload': {
        'room_id': m.roomId,
        'message_id': m.id,
      },
    });
    setState(() {
      _chatMessages.removeWhere((item) => item.id == m.id);
      if (_editingMessage?.id == m.id) {
        _editingMessage = null;
        _chatInputCtrl.clear();
      }
    });
  }

  void _showMessageActionsSheet(ChatMessageItem m) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 38,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFCBD5E1),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                ListTile(
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  leading: Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: const Color(0xFFEEF2FF),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    alignment: Alignment.center,
                    child: const Icon(
                      Icons.edit_outlined,
                      size: 19,
                      color: Color(0xFF4F46E5),
                    ),
                  ),
                  title: const Text(
                    'Редактировать сообщение',
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                  subtitle: const Text(
                    'Изменить текст или подпись с сохранением E2EE',
                    style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _startEditingChatMessage(m);
                  },
                ),
                const SizedBox(height: 4),
                ListTile(
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  leading: Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFF1F2),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    alignment: Alignment.center,
                    child: const Icon(
                      Icons.delete_outline_rounded,
                      size: 19,
                      color: Color(0xFFE11D48),
                    ),
                  ),
                  title: const Text(
                    'Удалить сообщение',
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFFE11D48),
                    ),
                  ),
                  subtitle: const Text(
                    'Удалить у всех участников диалога',
                    style: TextStyle(fontSize: 11, color: Color(0xFF64748B)),
                  ),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _deleteChatMessage(m);
                  },
                ),
              ],
            ),
          ),
        );
      },
    );
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
      final roomKey = await _ensureActiveRoomKey(targetRoomId);
      final editing = _editingMessage;
      if (editing != null && editing.roomId == targetRoomId) {
        final serialized = AndroidE2eeService.serializeChatPayload(
          text.trim(),
          editing.attachment,
        );
        final encrypted =
            await AndroidE2eeService.encryptChatWithBundle(serialized, roomKey);
        if (!mounted || _token != sessionToken) return;
        final sent = _sendWs({
          'type': 'edit_encrypted_chat',
          'payload': {
            'room_id': targetRoomId,
            'message_id': editing.id,
            'ciphertext_b64': encrypted['ciphertext_b64'],
            'iv_b64': encrypted['iv_b64'],
            'room_key_id': encrypted['room_key_id'],
          },
        });
        if (sent) {
          setState(() {
            _editingMessage = null;
            if (_chatInputCtrl.text == text) _chatInputCtrl.clear();
          });
        }
      } else {
        final serialized =
            AndroidE2eeService.serializeChatPayload(text.trim(), null);
        final encrypted =
            await AndroidE2eeService.encryptChatWithBundle(serialized, roomKey);
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
      }
    } catch (_) {
      if (mounted) {
        setState(() => _statusMessage =
            'Сообщение не отправлено. Текст сохранён в поле ввода.');
      }
    } finally {
      if (mounted) setState(() => _sendingChat = false);
    }
  }

  Future<void> _queueAndSendAttachment({
    required String fileName,
    required String mimeType,
    required String kind,
    required Uint8List plaintextBytes,
    int? durationMs,
    int? width,
    int? height,
  }) async {
    final targetRoomId = _activeChatRoomId;
    if (targetRoomId == null || !_wsConnected || _token == null) return;

    if (plaintextBytes.length > kMaxAttachmentPlaintextBytes) {
      setState(() {
        _statusMessage = 'Файл превышает лимит 128 МиБ на одно вложение.';
      });
      return;
    }

    final caption = _chatInputCtrl.text.trim();
    if (caption.isNotEmpty) {
      _chatInputCtrl.clear();
    }

    final transfer = OutgoingAttachmentTransfer(
      localId:
          'att-${DateTime.now().millisecondsSinceEpoch}-${_outgoingTransfers.length}',
      roomId: targetRoomId,
      fileName: sanitizeAttachmentFilename(fileName),
      mimeType: mimeType,
      kind: kind,
      plaintextBytes: plaintextBytes,
      captionText: caption,
      durationMs: durationMs,
      width: width,
      height: height,
    );

    setState(() {
      _outgoingTransfers.add(transfer);
    });
    await _runAttachmentTransfer(transfer);
  }

  Future<void> _runAttachmentTransfer(
      OutgoingAttachmentTransfer transfer) async {
    final sessionToken = _token;
    if (sessionToken == null) return;
    setState(() {
      transfer.status = 'uploading';
      transfer.errorMessage = null;
      transfer.cancelled = false;
      transfer.progress = 0.05;
    });

    try {
      final roomKey = await _ensureActiveRoomKey(transfer.roomId);
      final meta = await AndroidAttachmentService.uploadEncryptedAttachment(
        controlBaseUrl: _serverUrl,
        token: sessionToken,
        roomId: transfer.roomId,
        fileName: transfer.fileName,
        mimeType: transfer.mimeType,
        kind: transfer.kind,
        plaintextBytes: transfer.plaintextBytes,
        durationMs: transfer.durationMs,
        width: transfer.width,
        height: transfer.height,
        onProgress: (p) {
          if (mounted && !transfer.cancelled) {
            setState(() => transfer.progress = p);
          }
        },
        isCancelled: () => transfer.cancelled || !mounted,
      );

      if (!mounted || transfer.cancelled || _token != sessionToken) return;

      final defaultLabel = transfer.kind == 'voice'
          ? 'Голосовое сообщение (${AndroidAttachmentService.formatDurationMmSs(transfer.durationMs ?? 0)})'
          : transfer.kind == 'video_note'
              ? 'Видеокружок (${AndroidAttachmentService.formatDurationMmSs(transfer.durationMs ?? 0)})'
              : 'Вложение: ${meta.name}';
      final textBody =
          transfer.captionText.isNotEmpty ? transfer.captionText : defaultLabel;
      final serialized =
          AndroidE2eeService.serializeChatPayload(textBody, meta);
      final encrypted =
          await AndroidE2eeService.encryptChatWithBundle(serialized, roomKey);

      final sent = _sendWs({
        'type': 'send_encrypted_chat',
        'payload': {
          'room_id': transfer.roomId,
          'ciphertext_b64': encrypted['ciphertext_b64'],
          'iv_b64': encrypted['iv_b64'],
          'room_key_id': encrypted['room_key_id'],
        },
      });
      if (!sent) {
        throw Exception('Нет связи с сервером для отправки вложения в чат');
      }

      if (mounted) {
        setState(() {
          _outgoingTransfers.removeWhere((t) => t.localId == transfer.localId);
          _storageRefreshTrigger++;
        });
      }
    } catch (e) {
      if (!mounted || transfer.cancelled) return;
      final msg = e.toString().replaceFirst('Exception: ', '');
      setState(() {
        transfer.status = 'error';
        transfer.errorMessage = msg;
        _statusMessage = msg;
      });
    }
  }

  Future<void> _pickAndSendAttachmentFile() async {
    if (_activeChatRoomId == null || !_wsConnected) return;
    try {
      final res = await _mediaChannel
          .invokeMethod<Map<dynamic, dynamic>>('pickAttachmentFile');
      if (res == null || !mounted) return;
      if (res['error'] != null) {
        setState(() => _statusMessage = res['error'].toString());
        return;
      }
      final name = (res['name'] ?? 'attachment').toString();
      final mimeType =
          (res['mimeType'] ?? 'application/octet-stream').toString();
      final bytes = res['bytes'] as Uint8List?;
      if (bytes == null || bytes.isEmpty) {
        setState(() => _statusMessage = 'Выбранный файл пуст.');
        return;
      }
      final classified = classifyAttachmentFile(name, mimeType);
      if (classified == null) {
        setState(() => _statusMessage =
            'Поддерживаются только файлы PDF, Word (.doc, .docx) и изображения.');
        return;
      }
      await _queueAndSendAttachment(
        fileName: name,
        mimeType: classified['mimeType']!,
        kind: classified['kind']!,
        plaintextBytes: bytes,
      );
    } on PlatformException catch (e) {
      if (mounted) {
        setState(
            () => _statusMessage = e.message ?? 'Не удалось выбрать файл.');
      }
    } catch (_) {}
  }

  Future<void> _stopNoteCameraStream() async {
    _noteFrameCaptureTimer?.cancel();
    _noteFrameCaptureTimer = null;
    final stream = _noteCameraStream;
    final shared = _noteUsingSharedCallStream;
    _noteCameraStream = null;
    _noteUsingSharedCallStream = false;
    _noteRenderer.srcObject = null;
    if (stream != null && !shared) {
      try {
        for (final t in stream.getTracks()) {
          t.stop();
        }
        await stream.dispose();
      } catch (_) {}
    }
  }

  Future<void> _startVoiceOrVideoNoteRecording({required bool isVideo}) async {
    if (_activeChatRoomId == null || !_wsConnected) return;
    try {
      final perms = await _mediaChannel.invokeMethod<Map<dynamic, dynamic>>(
        'requestPermissions',
        {'needAudio': true, 'needCamera': isVideo},
      );
      if (perms == null ||
          perms['audio'] != true ||
          (isVideo && perms['camera'] != true)) {
        if (mounted) {
          setState(() => _statusMessage = isVideo
              ? 'Для записи видеокружка необходим доступ к камере и микрофону.'
              : 'Для записи голосового сообщения необходим доступ к микрофону.');
        }
        return;
      }

      await _stopPreviewPlayback();
      _recordedNoteFrames.clear();
      _previewPayloadBytes = null;
      _previewWavBytes = null;
      _previewDurationMs = 0;

      if (isVideo) {
        if (_localStream != null && _localStream!.getVideoTracks().isNotEmpty) {
          _noteCameraStream = _localStream;
          _noteUsingSharedCallStream = true;
          _noteRenderer.srcObject = _localStream;
        } else {
          final stream = await navigator.mediaDevices.getUserMedia({
            'audio': false,
            'video': {
              'facingMode': 'user',
              'width': {'ideal': 640},
              'height': {'ideal': 480},
            },
          });
          _noteCameraStream = stream;
          _noteUsingSharedCallStream = false;
          _noteRenderer.srcObject = stream;
        }
      }

      if (_currentRoom != null && _micEnabled) {
        try {
          await _mediaChannel.invokeMethod('setMicMute', {'micEnabled': false});
        } catch (_) {}
      }

      final audioStarted =
          await _mediaChannel.invokeMethod<bool>('startNoteAudio');
      if (audioStarted != true) {
        throw Exception('Не удалось инициализировать запись микрофона');
      }

      final startedAt = DateTime.now().millisecondsSinceEpoch;
      _noteStartedAtMs = startedAt;
      setState(() {
        _noteRecordMode = isVideo ? 'recording_video' : 'recording_voice';
        _noteElapsedMs = 0;
      });

      _noteTimer?.cancel();
      _noteTimer = Timer.periodic(const Duration(milliseconds: 100), (timer) {
        if (!mounted) {
          timer.cancel();
          return;
        }
        final elapsed = DateTime.now().millisecondsSinceEpoch - startedAt;
        if (elapsed >= 60000) {
          _stopNoteRecordingToPreview();
        } else {
          setState(() => _noteElapsedMs = elapsed);
        }
      });

      if (isVideo) {
        _noteFrameCaptureTimer?.cancel();
        _noteFrameCaptureTimer = Timer.periodic(
          const Duration(milliseconds: 120),
          (_) => _captureNoteSquareFrame(startedAt),
        );
      }
    } catch (_) {
      await _cancelNoteRecording();
      if (mounted) {
        setState(() =>
            _statusMessage = 'Не удалось запустить запись медиасообщения.');
      }
    }
  }

  Future<void> _captureNoteSquareFrame(int startedAtMs) async {
    if (_capturingNoteFrame || _noteCameraStream == null) {
      return;
    }
    final tracks = _noteCameraStream!.getVideoTracks();
    if (tracks.isEmpty) return;
    _capturingNoteFrame = true;
    try {
      final buf = await tracks.first.captureFrame();
      final rawBytes = buf.asUint8List();
      final squareJpeg = await _mediaChannel.invokeMethod<Uint8List>(
        'compressSquareFrame',
        {'bytes': rawBytes, 'size': 320, 'quality': 72},
      );
      if (squareJpeg != null && squareJpeg.isNotEmpty) {
        final ts = DateTime.now().millisecondsSinceEpoch - startedAtMs;
        _recordedNoteFrames.add(
          LpvnVideoFrame(
              timestampMs: ts.clamp(0, 60000), jpegBytes: squareJpeg),
        );
      }
    } catch (_) {
    } finally {
      _capturingNoteFrame = false;
    }
  }

  Future<void> _stopNoteRecordingToPreview() async {
    final wasVideo = _noteRecordMode == 'recording_video';
    _noteTimer?.cancel();
    _noteTimer = null;
    _noteFrameCaptureTimer?.cancel();
    _noteFrameCaptureTimer = null;

    if (wasVideo) {
      for (int i = 0; i < 6 && _capturingNoteFrame; i++) {
        await Future.delayed(const Duration(milliseconds: 40));
      }
      if (_recordedNoteFrames.isEmpty && _noteCameraStream != null) {
        await _captureNoteSquareFrame(_noteStartedAtMs);
      }
      if (_recordedNoteFrames.isEmpty) {
        try {
          final fallbackJpeg = await _mediaChannel.invokeMethod<Uint8List>(
            'compressSquareFrame',
            {'bytes': Uint8List(0), 'size': 320, 'quality': 72},
          );
          if (fallbackJpeg != null && fallbackJpeg.isNotEmpty) {
            _recordedNoteFrames.add(
              LpvnVideoFrame(timestampMs: 0, jpegBytes: fallbackJpeg),
            );
          }
        } catch (_) {}
      }
    }
    await _stopNoteCameraStream();

    Uint8List wavBytes = Uint8List(0);
    int durationMs = _noteElapsedMs;
    try {
      final res = await _mediaChannel
          .invokeMethod<Map<dynamic, dynamic>>('stopNoteAudio');
      if (res != null) {
        final b = res['wavBytes'];
        if (b is Uint8List) wavBytes = b;
        final d = res['durationMs'];
        if (d is num && d.toInt() > 0) durationMs = d.toInt();
      }
    } catch (_) {}

    if (_currentRoom != null && _micEnabled) {
      try {
        await _mediaChannel.invokeMethod('setMicMute', {'micEnabled': true});
      } catch (_) {}
    }

    if (!mounted) return;
    if (wavBytes.isEmpty) {
      setState(() => _noteRecordMode = 'idle');
      return;
    }

    if (wasVideo) {
      final lpvn = AndroidAttachmentService.encodeLpvnVideoNote(
        durationMs: durationMs.clamp(200, 60000),
        wavBytes: wavBytes,
        frames: List.of(_recordedNoteFrames),
      );
      setState(() {
        _previewPayloadBytes = lpvn;
        _previewWavBytes = wavBytes;
        _previewDurationMs = durationMs.clamp(200, 60000);
        _noteRecordMode = 'preview_video';
      });
    } else {
      setState(() {
        _previewPayloadBytes = wavBytes;
        _previewWavBytes = wavBytes;
        _previewDurationMs = durationMs.clamp(200, 60000);
        _noteRecordMode = 'preview_voice';
      });
    }
  }

  Future<void> _stopPreviewPlayback() async {
    _previewPlayTimer?.cancel();
    _previewPlayTimer = null;
    try {
      await _mediaChannel.invokeMethod('stopWavPlayback');
    } catch (_) {}
    if (mounted && _previewPlaying) {
      setState(() {
        _previewPlaying = false;
        _previewPlayFrameIdx = 0;
      });
    }
  }

  Future<void> _togglePreviewPlayback() async {
    if (_previewPlaying) {
      await _stopPreviewPlayback();
      return;
    }
    final wav = _previewWavBytes;
    if (wav == null || wav.isEmpty) return;
    try {
      await _mediaChannel.invokeMethod('playWavBytes', {'bytes': wav});
    } catch (_) {}
    final startedAt = DateTime.now().millisecondsSinceEpoch;
    final dur = _previewDurationMs > 0 ? _previewDurationMs : 2000;
    setState(() {
      _previewPlaying = true;
      _previewPlayFrameIdx = 0;
    });
    _previewPlayTimer?.cancel();
    _previewPlayTimer =
        Timer.periodic(const Duration(milliseconds: 40), (timer) {
      final elapsed = DateTime.now().millisecondsSinceEpoch - startedAt;
      if (!mounted || elapsed >= dur) {
        _stopPreviewPlayback();
        return;
      }
      if (_noteRecordMode == 'preview_video' &&
          _recordedNoteFrames.isNotEmpty) {
        int idx = 0;
        for (int i = 0; i < _recordedNoteFrames.length; i++) {
          if (_recordedNoteFrames[i].timestampMs <= elapsed) {
            idx = i;
          } else {
            break;
          }
        }
        setState(() => _previewPlayFrameIdx = idx);
      }
    });
  }

  Future<void> _cancelNoteRecording() async {
    _noteTimer?.cancel();
    _noteTimer = null;
    await _stopNoteCameraStream();
    await _stopPreviewPlayback();
    try {
      await _mediaChannel.invokeMethod('cancelNoteAudio');
    } catch (_) {}
    if (_currentRoom != null && _micEnabled) {
      try {
        await _mediaChannel.invokeMethod('setMicMute', {'micEnabled': true});
      } catch (_) {}
    }
    _recordedNoteFrames.clear();
    _previewPayloadBytes = null;
    _previewWavBytes = null;
    _previewDurationMs = 0;
    if (mounted) {
      setState(() {
        _noteRecordMode = 'idle';
        _noteElapsedMs = 0;
      });
    }
  }

  Future<void> _sendRecordedNote() async {
    if (_noteRecordMode == 'recording_voice' ||
        _noteRecordMode == 'recording_video') {
      await _stopNoteRecordingToPreview();
    }
    await _stopPreviewPlayback();
    final bytes = _previewPayloadBytes;
    final isVideo = _noteRecordMode == 'preview_video';
    final dur = _previewDurationMs;
    _recordedNoteFrames.clear();
    _previewPayloadBytes = null;
    _previewWavBytes = null;
    _previewDurationMs = 0;
    setState(() {
      _noteRecordMode = 'idle';
      _noteElapsedMs = 0;
    });
    if (bytes == null || bytes.isEmpty) return;

    final stamp = DateTime.now().millisecondsSinceEpoch;
    await _queueAndSendAttachment(
      fileName: isVideo ? 'videonote-$stamp.lpvn' : 'voice-$stamp.wav',
      mimeType: isVideo ? 'application/x-liaper-videonote' : 'audio/wav',
      kind: isVideo ? 'video_note' : 'voice',
      plaintextBytes: bytes,
      durationMs: dur,
      width: isVideo ? 320 : null,
      height: isVideo ? 320 : null,
    );
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
                'sender_id': m.senderId,
                'time': DateTime.tryParse(m.sentAt)
                        ?.toLocal()
                        .toString()
                        .substring(11, 16) ??
                    '',
                'sender': m.senderDisplayName,
                'username': m.senderUsername,
                'text': m.text,
                'sentAt': m.sentAt,
                if (m.attachment != null) 'attachment': m.attachment!.toJson(),
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
      if (withAudio || withVideo) {
        await _mediaChannel.invokeMethod('requestPermissions', {
          'needAudio': withAudio,
          'needCamera': withVideo,
        });
      }
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

  /// Подписанный сервером допуск в медиа-комнату; null, если сервер в режиме разработки.
  Future<String?> _fetchSfuTicket(String roomId) async {
    final token = _token;
    if (token == null) return null;
    final response = await http
        .post(Uri.parse('$_serverUrl/api/rooms/$roomId/sfu-ticket'), headers: {
      'Authorization': 'Bearer $token'
    }).timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw Exception('SFU ticket: HTTP ${response.statusCode}');
    }
    return (jsonDecode(response.body) as Map)['ticket'] as String?;
  }

  Future<void> _connectToSfuNode(Map<String, dynamic> room) async {
    final assignedNode = room['assigned_node'] as Map<String, dynamic>?;
    if (assignedNode == null || _currentUser == null) return;

    final rawWsUrl = assignedNode['ws_url'] as String;
    final wsUrl = _resolveSfuWsUrl(rawWsUrl);
    final roomId = room['id'] as String;

    String? ticket;
    try {
      ticket = await _fetchSfuTicket(roomId);
    } catch (_) {
      // Нода отклонит вход без допуска; повторное подключение сработает в onDone
    }
    if (!mounted || _currentRoom?['id'] != roomId || _currentUser == null) {
      return;
    }

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
            'e2ee_enabled': false,
            'room_key_id': 'NONE',
            'ticket': ticket,
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
    try {
      await _initIdentityAndSessionUnsafe()
          .timeout(const Duration(seconds: 20));
    } catch (e) {
      if (!mounted) return;
      // Без ключей устройства вход невозможен — показываем причину вместо серой кнопки
      setState(() => _authError =
          'Не удалось подготовить ключи шифрования: $e. Перезапустите приложение.');
    }
  }

  Future<void> _initIdentityAndSessionUnsafe() async {
    final prefs = await SharedPreferences.getInstance();
    final savedUrl = prefs.getString('liaper_server_url');
    if (savedUrl != null && savedUrl.isNotEmpty) {
      _serverUrl = savedUrl;
      _serverUrlCtrl.text = savedUrl;
    }

    final identity = await AndroidE2eeService.getOrCreateIdentity(prefs);
    final savedKeyrings = AndroidE2eeService.loadSavedRoomKeyrings(prefs);

    Map<String, dynamic>? savedUser;
    try {
      final rawUser = prefs.getString('liaper_user');
      if (rawUser != null) {
        savedUser = jsonDecode(rawUser) as Map<String, dynamic>;
      }
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _myIdentity = identity;
      _publicKeyB64 = identity.publicKeyB64;
      _fingerprint = identity.fingerprint;
      _roomKeyrings
        ..clear()
        ..addAll(savedKeyrings);
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
        if (!_notificationPermissionAsked) {
          _notificationPermissionAsked = true;
          _mediaChannel
              .invokeMethod('requestNotificationPermission')
              .catchError((_) => null);
        }
        setState(() {
          _wsConnected = true;
          _currentUser = payload?['self_profile'] as Map<String, dynamic>?;
          _contacts = (payload?['contacts'] as List<dynamic>?) ?? [];
          _incomingRequests =
              (payload?['incoming_requests'] as List<dynamic>?) ?? [];
          _outgoingRequests =
              (payload?['outgoing_requests'] as List<dynamic>?) ?? [];
        });
        // Урок ждёт возвращения после обрыва связи или перезапуска приложения
        final activeRooms = (payload?['active_rooms'] as List<dynamic>?) ?? [];
        if (activeRooms.isNotEmpty &&
            activeRooms.first is Map<String, dynamic>) {
          final active = activeRooms.first as Map<String, dynamic>;
          if (_currentRoom != null &&
              _currentRoom!['id']?.toString() == active['id']?.toString()) {
            _sendWs({
              'type': 'join_room',
              'payload': {
                'room_id': active['id'],
                'audio_enabled': _micEnabled,
                'video_enabled': _camEnabled,
              },
            });
          } else if (_currentRoom == null) {
            setState(() {
              _otherDeviceCall = active;
              _otherDeviceIsResume = true;
            });
          }
        }
        if (_publicKeyB64.isNotEmpty) {
          _sendWs({
            'type': 'update_public_key',
            'payload': {
              'e2ee_public_key': _publicKeyB64,
              'key_fingerprint': _fingerprint,
            },
          });
        }
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
        final activeId = _activeChatRoomId;
        if (activeId != null && _roomKeyrings.containsKey(activeId)) {
          _distributeRoomKeyToRecipients(
              activeId, _roomKeyrings[activeId]!.activeKey);
        }
        break;

      case 'room_updated':
        final room = payload?['room'] as Map<String, dynamic>?;
        final wasInRoom =
            _currentRoom != null && _currentRoom!['id'] == room?['id'];
        final newParticipantIds =
            ((room?['participants'] as List<dynamic>?) ?? [])
                .map((p) => (p as Map<String, dynamic>)['user_id']?.toString())
                .whereType<String>()
                .toList();
        final someoneLeft = wasInRoom &&
            room != null &&
            _prevRoomParticipantIds
                .any((prevId) => !newParticipantIds.contains(prevId));
        _prevRoomParticipantIds = newParticipantIds;

        setState(() {
          _currentRoom = room;
          _incomingCall = null;
          if (room != null) _otherDeviceCall = null;
          if (!wasInRoom && room != null) {
            _chatMode = 'lesson';
            _selectedTabIndex =
                1; // Переключаем на экран звонка при старте урока
          }
        });
        if (room != null) {
          final rId = room['id'].toString();
          _ensureActiveRoomKey(rId, forceRotate: someoneLeft);
          _ensureRoomMediaConnected(room);
          if (!wasInRoom) {
            _saveCurrentLessonToArchive(
                showNotification: false, completed: false);
          }
        }
        break;

      case 'key_envelope_received':
        final env = payload?['envelope'] as Map<String, dynamic>?;
        if (env != null && _myIdentity != null) {
          final roomId = (env['room_id'] ?? '').toString();
          if (roomId.isNotEmpty) {
            AndroidE2eeService.openKeyEnvelope(env, _myIdentity!)
                .then((bundle) =>
                    _registerRoomKey(roomId, bundle, makeActive: true))
                .catchError((_) {});
          }
        }
        break;

      case 'incoming_call':
        setState(() {
          _incomingCall = payload;
        });
        break;

      case 'call_on_other_device':
        final roomId = payload?['room_id']?.toString();
        final otherRoom = payload?['room'] as Map<String, dynamic>?;
        final movedAway = otherRoom != null &&
            _currentRoom != null &&
            _currentRoom!['id']?.toString() == roomId;
        if (movedAway) {
          // Звонок перенесли на другое устройство: отключаемся, не выходя из урока
          _stopLocalMediaAndSfu();
        }
        setState(() {
          if (_incomingCall?['room']?['id']?.toString() == roomId) {
            _incomingCall = null;
          }
          if (otherRoom != null) {
            _otherDeviceCall = otherRoom;
            _otherDeviceIsResume = false;
          } else if (_otherDeviceCall?['id']?.toString() == roomId) {
            _otherDeviceCall = null;
          }
          if (movedAway) {
            _currentRoom = null;
            _prevRoomParticipantIds = [];
            _statusMessage = 'Урок продолжается на другом устройстве.';
          }
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

      case 'encrypted_chat_edited':
        final rawMsg = payload?['message'] as Map<String, dynamic>?;
        if (rawMsg != null) {
          _handleEditedEncryptedChat(rawMsg);
        }
        break;

      case 'encrypted_chat_deleted':
        _handleDeletedEncryptedChat(payload);
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
    } else if (_isRegister && _passwordCtrl.text.length < 8) {
      error = 'Пароль должен содержать не менее 8 символов.';
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
      // Проверка на робота: сервер выдаёт задачу, телефон решает её за секунду-другую
      String? powChallenge;
      String? powSolution;
      if (_isRegister) {
        setState(() => _authCheckingRobot = true);
        final chRes = await http
            .get(Uri.parse('$_serverUrl/api/auth/challenge'))
            .timeout(const Duration(seconds: 8));
        final ch = jsonDecode(chRes.body) as Map<String, dynamic>;
        if (chRes.statusCode >= 400) {
          if (!mounted) return;
          setState(() {
            _authError =
                (ch['error'] ?? 'Не удалось начать проверку').toString();
            _authLoading = false;
            _authCheckingRobot = false;
          });
          return;
        }
        powChallenge = ch['challenge'].toString();
        powSolution = await PowSolver.solve(
            powChallenge, (ch['difficulty'] as num).toInt());
        if (!mounted) return;
        setState(() => _authCheckingRobot = false);
      }
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
              'pow_challenge': powChallenge,
              'pow_solution': powSolution,
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
        _authCheckingRobot = false;
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
    final revokedToken = _token;
    if (revokedToken != null) {
      // Отзываем сессию на сервере; выход не ждёт сети
      http
          .post(Uri.parse('$_serverUrl/api/auth/logout'),
              headers: {'Authorization': 'Bearer $revokedToken'})
          .timeout(const Duration(seconds: 5))
          .catchError((_) => http.Response('', 0));
    }
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
      _selectedArchiveId = null;
      _selectedArchiveMsgIds.clear();
      _forwardingFromArchive = false;
      _incomingCall = null;
      _otherDeviceCall = null;
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
    final parentBottomInset = MediaQuery.viewPaddingOf(context).bottom;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            final modalBottomSafe =
                MediaQuery.viewPaddingOf(ctx).bottom > parentBottomInset
                    ? MediaQuery.viewPaddingOf(ctx).bottom
                    : parentBottomInset;
            return SafeArea(
              top: false,
              child: Padding(
                padding: EdgeInsets.only(
                  left: 20,
                  right: 20,
                  top: 20,
                  bottom: MediaQuery.viewInsetsOf(ctx).bottom +
                      modalBottomSafe +
                      44,
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
                              activeColor: const Color(0xFF4F46E5),
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
                        backgroundColor: const Color(0xFF4F46E5),
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

  Widget _buildActiveTabBody() {
    switch (_selectedTabIndex) {
      case 0:
        return _buildContactsTab();
      case 1:
        return _buildCallTab();
      case 2:
        return _buildChatTab();
      case 3:
        return _buildProfileTab();
      default:
        return _buildContactsTab();
    }
  }

  // ===========================================================================
  // Главный метод отрисовки
  // ===========================================================================
  @override
  Widget build(BuildContext context) {
    if (_token == null || _currentUser == null) {
      return AnnotatedRegion<SystemUiOverlayStyle>(
        value: kLiaperSystemUiStyle,
        child: _buildAuthScreen(),
      );
    }

    final isInCallTab = _selectedTabIndex == 1 && _currentRoom != null;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: kLiaperSystemUiStyle,
      child: PopScope(
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
                  systemOverlayStyle: kLiaperSystemUiStyle,
                  backgroundColor: Colors.white,
                  surfaceTintColor: Colors.white,
                  elevation: 0,
                  titleSpacing: 16,
                  title: Row(
                    children: [
                      const LiaperLogoMark(size: 36),
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
                          onPressed: _logout,
                          child: const Text('Войти заново')),
                    ],
                  ),
                // Уведомление или статус
                if (_statusMessage != null)
                  Container(
                    margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 10),
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
                          onPressed: () =>
                              setState(() => _statusMessage = null),
                          icon: const Icon(Icons.close,
                              size: 20, color: Colors.white70),
                        ),
                      ],
                    ),
                  ),

                // Глобальное окно входящего звонка
                if (_incomingCall != null) _buildIncomingCallBanner(),
                if (_otherDeviceCall != null &&
                    _currentRoom == null &&
                    _incomingCall == null)
                  _buildOtherDeviceCallBanner(),

                // Основное содержимое выбранной вкладки (без пересчёта неактивных вкладок при открытии клавиатуры)
                Expanded(
                  child: _buildActiveTabBody(),
                ),
              ],
            ),
          ),
          bottomNavigationBar: isInCallTab ? null : _buildBottomNavigation(),
        ),
      ),
    );
  }

  /// Нижняя навигация: фирменная подсветка активной вкладки, бейджи и тактильный отклик.
  Widget _buildBottomNavigation() {
    const accent = Color(0xFF4F46E5);
    const muted = Color(0xFF64748B);
    Widget badge(Widget icon,
        {int count = 0, bool dot = false, Color color = accent}) {
      return Badge(
        isLabelVisible: count > 0 || dot,
        backgroundColor: color,
        smallSize: 9,
        label: count > 0 ? Text(count > 99 ? '99+' : '$count') : null,
        child: icon,
      );
    }

    final isTutor = _currentUser?['role'] == 'tutor';
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: Color(0xFFEEF0F4))),
        boxShadow: [
          BoxShadow(
            color: Color(0x0F0F172A),
            blurRadius: 16,
            offset: Offset(0, -4),
          ),
        ],
      ),
      child: NavigationBarTheme(
        data: NavigationBarThemeData(
          height: 70,
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.transparent,
          indicatorColor: const Color(0xFFEEF2FF),
          indicatorShape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
          labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
          iconTheme: WidgetStateProperty.resolveWith(
            (states) => IconThemeData(
              size: 25,
              color: states.contains(WidgetState.selected) ? accent : muted,
            ),
          ),
          labelTextStyle: WidgetStateProperty.resolveWith(
            (states) => TextStyle(
              fontSize: 12,
              letterSpacing: -0.1,
              fontWeight: states.contains(WidgetState.selected)
                  ? FontWeight.w700
                  : FontWeight.w500,
              color: states.contains(WidgetState.selected)
                  ? const Color(0xFF312E81)
                  : muted,
            ),
          ),
        ),
        child: NavigationBar(
          selectedIndex: _selectedTabIndex,
          elevation: 0,
          animationDuration: const Duration(milliseconds: 260),
          onDestinationSelected: (idx) {
            if (idx != _selectedTabIndex) HapticFeedback.selectionClick();
            setState(() {
              _selectedTabIndex = idx;
              if (idx == 2) {
                _unreadChatCount = 0;
              }
            });
          },
          destinations: [
            NavigationDestination(
              icon: badge(
                  Icon(isTutor ? Icons.groups_outlined : Icons.school_outlined),
                  count: _incomingRequests.length,
                  color: const Color(0xFFF59E0B)),
              selectedIcon: badge(
                  Icon(isTutor ? Icons.groups_rounded : Icons.school_rounded),
                  count: _incomingRequests.length,
                  color: const Color(0xFFF59E0B)),
              label: isTutor ? 'Ученики' : 'Преподаватели',
              tooltip: isTutor ? 'Ученики' : 'Преподаватели',
            ),
            NavigationDestination(
              icon: badge(const Icon(Icons.videocam_outlined),
                  dot: _currentRoom != null, color: const Color(0xFF10B981)),
              selectedIcon: badge(const Icon(Icons.videocam_rounded),
                  dot: _currentRoom != null, color: const Color(0xFF10B981)),
              label: _currentRoom != null ? 'Идёт урок' : 'Урок',
              tooltip: 'Урок',
            ),
            NavigationDestination(
              icon: badge(const Icon(Icons.chat_bubble_outline_rounded),
                  count: _unreadChatCount),
              selectedIcon: badge(const Icon(Icons.chat_bubble_rounded),
                  count: _unreadChatCount),
              label: 'Сообщения',
              tooltip: 'Сообщения',
            ),
            NavigationDestination(
              icon: badge(const Icon(Icons.account_circle_outlined),
                  dot: _updateAvailable),
              selectedIcon: badge(const Icon(Icons.account_circle_rounded),
                  dot: _updateAvailable),
              label: 'Профиль',
              tooltip: 'Профиль',
            ),
          ],
        ),
      ),
    );
  }

  // ===========================================================================
  // Баннер входящего звонка
  // ===========================================================================
  bool get _canRenameLesson =>
      _currentRoom != null &&
      (_currentUser?['role'] == 'tutor' ||
          _currentRoom!['host_id']?.toString() ==
              _currentUser?['id']?.toString());

  /// Тему урока можно задать уже во время звонка.
  Future<void> _showRenameTopicDialog() async {
    final room = _currentRoom;
    if (room == null) return;
    final ctrl = TextEditingController(text: (room['title'] ?? '').toString());
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Тема урока'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 80,
          textCapitalization: TextCapitalization.sentences,
          decoration:
              const InputDecoration(hintText: 'Например: Квадратные уравнения'),
          onSubmitted: (v) => Navigator.pop(ctx, v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Отмена'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: const Text('Сохранить'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    final clean = title?.trim() ?? '';
    if (clean.isEmpty || _currentRoom == null || clean == room['title']) return;
    _sendWs({
      'type': 'rename_room',
      'payload': {'room_id': _currentRoom!['id'], 'title': clean},
    });
  }

  /// Компактная пометка «Переслано · Имя»; подробности — по долгому нажатию.
  Widget _forwardedLabel(ForwardedFrom f, bool onAccent) {
    final color = onAccent ? const Color(0xFFC7D2FE) : const Color(0xFF4F46E5);
    final details =
        'Из урока «${f.source}»${f.username != null ? ', @${f.username}' : ''}${f.time != null ? ', ${f.time}' : ''}';
    return Tooltip(
      message: details,
      triggerMode: TooltipTriggerMode.longPress,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.shortcut_rounded, size: 14, color: color),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                'Переслано · ${f.sender}',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: color,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Плашка «урок идёт на другом устройстве» с переносом звонка на телефон.
  Widget _buildOtherDeviceCallBanner() {
    final room = _otherDeviceCall!;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
      decoration: BoxDecoration(
        color: const Color(0xFFECFDF5),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFA7F3D0)),
      ),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: const BoxDecoration(
              color: Color(0xFF10B981),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _otherDeviceIsResume
                      ? 'Урок продолжается'
                      : 'Урок идёт на другом устройстве',
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13.5,
                    color: Color(0xFF064E3B),
                  ),
                ),
                Text(
                  (room['title'] ?? '').toString(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style:
                      const TextStyle(fontSize: 12, color: Color(0xFF047857)),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          FilledButton.icon(
            onPressed: _wsConnected ? _takeOverCall : null,
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF059669),
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              visualDensity: VisualDensity.compact,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
            icon: Icon(
                _otherDeviceIsResume
                    ? Icons.videocam_rounded
                    : Icons.phone_android_rounded,
                size: 18),
            label: Text(_otherDeviceIsResume ? 'Вернуться' : 'Сюда'),
          ),
        ],
      ),
    );
  }

  /// Забрать идущий урок с другого устройства на телефон.
  void _takeOverCall() {
    final room = _otherDeviceCall;
    if (room == null) return;
    setState(() {
      _otherDeviceCall = null;
      _selectedTabIndex = 1;
    });
    _sendWs({
      'type': 'join_room',
      'payload': {
        'room_id': room['id'],
        'audio_enabled': _micEnabled,
        'video_enabled': _camEnabled,
      },
    });
  }

  void _acceptIncomingCall() {
    final room = _incomingCall!['room'] as Map<String, dynamic>;
    final withVideo = _incomingCall!['with_video'] == true;
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
  }

  void _declineIncomingCall() {
    final room = _incomingCall!['room'] as Map<String, dynamic>;
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
  }

  Widget _buildIncomingCallBanner() {
    final caller = _incomingCall!['caller'] as Map<String, dynamic>;
    final room = _incomingCall!['room'] as Map<String, dynamic>;

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
                  onPressed: _acceptIncomingCall,
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
                  onPressed: _declineIncomingCall,
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
                  if (isTutorAccount) const SizedBox(width: 8),
                  if (isTutorAccount)
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
                        style: TextStyle(
                            fontSize: 12, fontWeight: FontWeight.w600),
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
                        backgroundColor: const Color(0xFF4F46E5),
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
                  'Приглашения (${_incomingRequests.length})',
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
                                  backgroundColor: const Color(0xFF4F46E5),
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
                '${_currentUser?['role'] == 'tutor' ? 'Мои ученики' : 'Мои преподаватели'} (${_contacts.length})',
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
                hintText: 'Поиск по имени или @нику',
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
              Text(
                _currentUser?['role'] == 'tutor'
                    ? 'Выберите ученика во вкладке «Ученики» или создайте групповой урок.'
                    : 'Выберите преподавателя во вкладке «Преподаватели», чтобы написать ему.',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: () => setState(() => _selectedTabIndex = 0),
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF4F46E5),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                icon: const Icon(Icons.people_outline, size: 18),
                label: Text(_currentUser?['role'] == 'tutor'
                    ? 'Перейти к ученикам'
                    : 'Перейти к преподавателям'),
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
                      ? Stack(
                          fit: StackFit.expand,
                          children: [
                            // Размытая копия кадра заполняет поля вокруг вертикального/горизонтального видео
                            if (_fitContain && !isPrimaryScreenShare)
                              ImageFiltered(
                                imageFilter:
                                    ImageFilter.blur(sigmaX: 28, sigmaY: 28),
                                child: Opacity(
                                  opacity: 0.55,
                                  child: Image.memory(
                                    primaryRemoteFrame,
                                    gaplessPlayback: true,
                                    fit: BoxFit.cover,
                                  ),
                                ),
                              ),
                            InteractiveViewer(
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
                            ),
                          ],
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
                          InkWell(
                            onTap: _canRenameLesson
                                ? _showRenameTopicDialog
                                : null,
                            borderRadius: BorderRadius.circular(6),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Flexible(
                                  child: Text(
                                    (_currentRoom!['title'] ?? 'Урок')
                                        .toString(),
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontWeight: FontWeight.w700,
                                      fontSize: 14,
                                    ),
                                  ),
                                ),
                                if (_canRenameLesson) ...[
                                  const SizedBox(width: 4),
                                  const Icon(Icons.edit_rounded,
                                      size: 14, color: Colors.white70),
                                ],
                              ],
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
                    12, showParticipantStrip ? 160 : 88, 12, 148),
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
                                child: Text('Вы',
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
              bottom: 38 + MediaQuery.viewPaddingOf(context).bottom * 0.5,
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
    final parentBottomInset = MediaQuery.viewPaddingOf(context).bottom;
    showModalBottomSheet(
      context: context,
      useSafeArea: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        final modalBottomSafe =
            MediaQuery.viewPaddingOf(ctx).bottom > parentBottomInset
                ? MediaQuery.viewPaddingOf(ctx).bottom
                : parentBottomInset;
        return SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.fromLTRB(20, 20, 20, modalBottomSafe + 44),
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
                                _statusMessage =
                                    'Приглашение отправлено @$nick';
                              });
                            },
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF4F46E5),
                            ),
                            child: const Text('Позвать'),
                          ),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _forwardArchiveMessagesToTarget({
    required String archiveTitle,
    required List<Map<String, dynamic>> messages,
    required String targetRoomId,
    required String targetMode,
    Map<String, dynamic>? targetContact,
  }) async {
    if (messages.isEmpty || _forwardingFromArchive || !_wsConnected) return;
    final sessionToken = _token;
    if (sessionToken == null) return;

    setState(() {
      _forwardingFromArchive = true;
      _statusMessage = 'Пересылка сообщений (${messages.length})...';
    });

    try {
      final roomKey = await _ensureActiveRoomKey(targetRoomId);
      int sentCount = 0;

      for (final msgMap in messages) {
        if (!mounted || _token != sessionToken) break;
        final sender = (msgMap['sender'] ?? 'Участник').toString();
        final username = (msgMap['username'] ?? '').toString();
        final time = (msgMap['time'] ?? '').toString();
        final origText = (msgMap['text'] ?? '').toString();

        final forwarded = ForwardedFrom(
          source: archiveTitle,
          sender: sender,
          username: username.isEmpty ? null : username,
          time: time.isEmpty ? null : time,
        );

        ChatAttachmentMeta? finalAttMeta;
        if (msgMap['attachment'] is Map) {
          final origMeta = ChatAttachmentMeta.fromJson(
              Map<String, dynamic>.from(msgMap['attachment'] as Map));
          finalAttMeta = origMeta;
          try {
            final clearBytes =
                await AndroidAttachmentService.downloadAndDecryptAttachment(
              controlBaseUrl: _serverUrl,
              token: sessionToken,
              meta: origMeta,
            );
            final reuploaded =
                await AndroidAttachmentService.uploadEncryptedAttachment(
              controlBaseUrl: _serverUrl,
              token: sessionToken,
              roomId: targetRoomId,
              fileName: origMeta.name,
              mimeType: origMeta.mimeType,
              kind: origMeta.kind,
              plaintextBytes: clearBytes,
              durationMs: origMeta.durationMs,
              width: origMeta.width,
              height: origMeta.height,
            );
            finalAttMeta = reuploaded;
          } catch (_) {
            // Если повторная загрузка не удалась (квота/истек срок), оставляем исходную карточку
            finalAttMeta = origMeta;
          }
        }

        final serialized = AndroidE2eeService.serializeChatPayload(
            origText, finalAttMeta, forwarded);
        final encrypted =
            await AndroidE2eeService.encryptChatWithBundle(serialized, roomKey);
        final ok = _sendWs({
          'type': 'send_encrypted_chat',
          'payload': {
            'room_id': targetRoomId,
            'ciphertext_b64': encrypted['ciphertext_b64'],
            'iv_b64': encrypted['iv_b64'],
            'room_key_id': encrypted['room_key_id'],
          },
        });
        if (ok) sentCount++;
      }

      if (!mounted) return;
      setState(() {
        _forwardingFromArchive = false;
        _selectedArchiveMsgIds.clear();
        _selectedArchiveId = null;
        _chatMode = targetMode;
        if (targetContact != null) {
          _selectedChatContact = targetContact;
        }
        _statusMessage = 'Переслано сообщений в чат: $sentCount';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _forwardingFromArchive = false;
        _statusMessage = 'Не удалось переслать сообщения из архива';
      });
    }
  }

  void _showForwardArchiveMessagesSheet(
    Map<String, dynamic> archive,
    List<Map<String, dynamic>> selectedMessages,
  ) {
    if (selectedMessages.isEmpty || _currentUser == null) return;
    if (!_wsConnected) {
      setState(() {
        _statusMessage =
            'Нет связи с сервером. Дождитесь подключения для пересылки.';
      });
      return;
    }

    final archiveTitle = (archive['title'] ?? 'Урок').toString();
    final parentBottomInset = MediaQuery.viewPaddingOf(context).bottom;

    showModalBottomSheet(
      context: context,
      useSafeArea: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        final modalBottomSafe =
            MediaQuery.viewPaddingOf(ctx).bottom > parentBottomInset
                ? MediaQuery.viewPaddingOf(ctx).bottom
                : parentBottomInset;
        return SafeArea(
          top: false,
          child: Padding(
            padding: EdgeInsets.fromLTRB(20, 20, 20, modalBottomSafe + 44),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                      child: Text(
                        'Переслать сообщения (${selectedMessages.length})',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.pop(ctx),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                const Text(
                  'Выберите чат для пересылки:',
                  style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
                ),
                const SizedBox(height: 10),
                if (_currentRoom == null && _contacts.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: Text(
                      'Нет активного урока или взаимных контактов для пересылки.',
                      style: TextStyle(color: Color(0xFF64748B), fontSize: 13),
                    ),
                  )
                else
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 280),
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        if (_currentRoom != null)
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: const CircleAvatar(
                              backgroundColor: Color(0xFF4F46E5),
                              child: Icon(Icons.videocam,
                                  color: Colors.white, size: 18),
                            ),
                            title: Text(
                              'Текущий урок: ${_currentRoom!['title']}',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600, fontSize: 14),
                            ),
                            subtitle: const Text('Чат активного урока',
                                style: TextStyle(fontSize: 12)),
                            trailing: FilledButton.icon(
                              onPressed: () {
                                final rId = _currentRoom!['id'].toString();
                                Navigator.pop(ctx);
                                _forwardArchiveMessagesToTarget(
                                  archiveTitle: archiveTitle,
                                  messages: selectedMessages,
                                  targetRoomId: rId,
                                  targetMode: 'lesson',
                                );
                              },
                              style: FilledButton.styleFrom(
                                backgroundColor: const Color(0xFF4F46E5),
                                visualDensity: VisualDensity.compact,
                              ),
                              icon: const Icon(Icons.forward_rounded, size: 16),
                              label: const Text('Сюда'),
                            ),
                          ),
                        ..._contacts.map((rawContact) {
                          final c = rawContact as Map<String, dynamic>;
                          final nick = (c['username'] ?? '').toString();
                          final dmId = _computeDmRoomId(
                            _currentUser!['id'].toString(),
                            c['id'].toString(),
                          );
                          return ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: CircleAvatar(
                              backgroundColor: const Color(0xFFE2E8F0),
                              child: Text(
                                (c['display_name'] ?? nick)
                                    .toString()
                                    .substring(0, 1)
                                    .toUpperCase(),
                                style: const TextStyle(
                                  color: Color(0xFF0F172A),
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            title: Text(
                              '${c['display_name']} (@$nick)',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600, fontSize: 14),
                            ),
                            subtitle: Text(
                              c['online'] == true
                                  ? 'Личный диалог · В сети'
                                  : 'Личный диалог',
                              style: const TextStyle(fontSize: 12),
                            ),
                            trailing: FilledButton.icon(
                              onPressed: () {
                                Navigator.pop(ctx);
                                _forwardArchiveMessagesToTarget(
                                  archiveTitle: archiveTitle,
                                  messages: selectedMessages,
                                  targetRoomId: dmId,
                                  targetMode: 'direct',
                                  targetContact: c,
                                );
                              },
                              style: FilledButton.styleFrom(
                                backgroundColor: const Color(0xFF4F46E5),
                                visualDensity: VisualDensity.compact,
                              ),
                              icon: const Icon(Icons.forward_rounded, size: 16),
                              label: const Text('Сюда'),
                            ),
                          );
                        }),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _insertEmojiIntoChat(String emoji) {
    final text = _chatInputCtrl.text;
    final sel = _chatInputCtrl.selection;
    if (sel.isValid && sel.start >= 0 && sel.end <= text.length) {
      final next = text.replaceRange(sel.start, sel.end, emoji);
      _chatInputCtrl.value = TextEditingValue(
        text: next,
        selection: TextSelection.collapsed(offset: sel.start + emoji.length),
      );
    } else {
      final next = '$text$emoji';
      _chatInputCtrl.value = TextEditingValue(
        text: next,
        selection: TextSelection.collapsed(offset: next.length),
      );
    }
    setState(() {});
  }

  Widget _buildEmojiPickerPanel() {
    final cat = _kEmojiCategories[_emojiCategoryIdx];
    final items = (cat['items'] as List<dynamic>).cast<String>();
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: const BoxDecoration(
        color: Color(0xFFF8FAFC),
        border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: List.generate(_kEmojiCategories.length, (idx) {
                      final selected = _emojiCategoryIdx == idx;
                      return Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: ChoiceChip(
                          selected: selected,
                          visualDensity: VisualDensity.compact,
                          label: Text(
                            _kEmojiCategories[idx]['label'].toString(),
                            style: const TextStyle(fontSize: 11),
                          ),
                          onSelected: (_) {
                            setState(() => _emojiCategoryIdx = idx);
                          },
                        ),
                      );
                    }),
                  ),
                ),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: 'Закрыть эмодзи',
                onPressed: () => setState(() => _showEmojiPicker = false),
                icon: const Icon(Icons.close, size: 18),
              ),
            ],
          ),
          const SizedBox(height: 6),
          SizedBox(
            height: 152,
            child: GridView.builder(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 8,
                mainAxisSpacing: 4,
                crossAxisSpacing: 4,
              ),
              itemCount: items.length,
              itemBuilder: (_, i) {
                final emoji = items[i];
                return InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => _insertEmojiIntoChat(emoji),
                  child: Center(
                    child: Text(
                      emoji,
                      style: const TextStyle(fontSize: 22),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildNoteRecorderPanel() {
    final isRecording = _noteRecordMode == 'recording_voice' ||
        _noteRecordMode == 'recording_video';
    final isVideo = _noteRecordMode == 'recording_video' ||
        _noteRecordMode == 'preview_video';
    final shownMs = isRecording ? _noteElapsedMs : _previewDurationMs;

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: const BoxDecoration(
        color: Color(0xFFF8FAFC),
        border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (isVideo)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: SizedBox(
                width: 156,
                height: 156,
                child: Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: isRecording
                          ? const Color(0xFFE11D48)
                          : const Color(0xFF0F172A),
                      width: 3,
                    ),
                  ),
                  child: ClipOval(
                    child: isRecording
                        ? RTCVideoView(
                            _noteRenderer,
                            mirror: true,
                            objectFit: RTCVideoViewObjectFit
                                .RTCVideoViewObjectFitCover,
                          )
                        : _recordedNoteFrames.isNotEmpty
                            ? Image.memory(
                                _recordedNoteFrames[_previewPlayFrameIdx.clamp(
                                        0, _recordedNoteFrames.length - 1)]
                                    .jpegBytes,
                                fit: BoxFit.cover,
                                gaplessPlayback: true,
                              )
                            : const ColoredBox(color: Colors.black87),
                  ),
                ),
              ),
            ),
          Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isRecording
                      ? const Color(0xFFE11D48)
                      : const Color(0xFF10B981),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  isRecording
                      ? '${isVideo ? 'Запись видеокружка' : 'Запись голосового'}: ${AndroidAttachmentService.formatDurationMmSs(shownMs)}'
                      : '${isVideo ? 'Предпросмотр кружка' : 'Предпросмотр голосового'}: ${AndroidAttachmentService.formatDurationMmSs(shownMs)}',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF0F172A),
                  ),
                ),
              ),
              if (!isRecording)
                IconButton(
                  tooltip: _previewPlaying ? 'Остановить' : 'Прослушать',
                  onPressed: _togglePreviewPlayback,
                  icon: Icon(
                    _previewPlaying
                        ? Icons.stop_circle_outlined
                        : Icons.play_circle_outline,
                    color: const Color(0xFF0F172A),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: _cancelNoteRecording,
                style: TextButton.styleFrom(
                  foregroundColor: const Color(0xFFE11D48),
                ),
                icon: const Icon(Icons.delete_outline, size: 18),
                label: const Text('Отмена'),
              ),
              const SizedBox(width: 8),
              if (isRecording)
                OutlinedButton.icon(
                  onPressed: _stopNoteRecordingToPreview,
                  icon: const Icon(Icons.stop_rounded, size: 18),
                  label: const Text('Стоп'),
                ),
              if (isRecording) const SizedBox(width: 8),
              FilledButton.icon(
                onPressed: _sendRecordedNote,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF4F46E5),
                ),
                icon: const Icon(Icons.send_rounded, size: 16),
                label: const Text('Отправить'),
              ),
            ],
          ),
        ],
      ),
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
    final visibleTransfers = targetRoomId == null
        ? <OutgoingAttachmentTransfer>[]
        : _outgoingTransfers.where((t) => t.roomId == targetRoomId).toList();

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
                    if (s.first != 'archive') {
                      _selectedArchiveId = null;
                      _selectedArchiveMsgIds.clear();
                    }
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
                      onPressed: () => _showReportChatSheet(
                        _currentRoom!['id'].toString(),
                        'Урок: ${_currentRoom!['title']}',
                      ),
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        foregroundColor: const Color(0xFFE11D48),
                      ),
                      icon: const Icon(Icons.flag_outlined, size: 15),
                      label:
                          const Text('Жалоба', style: TextStyle(fontSize: 12)),
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
                  Row(
                    children: [
                      Expanded(
                        child: SizedBox(
                          height: 36,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount: _contacts.length,
                            separatorBuilder: (_, __) =>
                                const SizedBox(width: 6),
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
                      ),
                      if (_selectedChatContact != null && targetRoomId != null)
                        TextButton.icon(
                          onPressed: () => _showReportChatSheet(
                            targetRoomId,
                            'Личный чат: ${_selectedChatContact!['display_name']} (@${_selectedChatContact!['username']})',
                          ),
                          style: TextButton.styleFrom(
                            visualDensity: VisualDensity.compact,
                            foregroundColor: const Color(0xFFE11D48),
                          ),
                          icon: const Icon(Icons.flag_outlined, size: 15),
                          label: const Text('Жалоба',
                              style: TextStyle(fontSize: 12)),
                        ),
                    ],
                  ),
              ],
            ],
          ),
        ),

        if (_chatMode == 'archive' && _selectedArchiveId == null)
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
                : Builder(
                    builder: (context) {
                      final openedArch = _selectedArchiveId == null
                          ? null
                          : _archivedChats
                              .where((a) =>
                                  a['id']?.toString() == _selectedArchiveId)
                              .firstOrNull;

                      if (openedArch != null) {
                        final rawMsgs =
                            (openedArch['messages'] as List<dynamic>?) ?? [];
                        final indexedMsgs = <Map<String, dynamic>>[];
                        final allMsgKeys = <String>[];
                        for (int i = 0; i < rawMsgs.length; i++) {
                          final map =
                              Map<String, dynamic>.from(rawMsgs[i] as Map);
                          final key = (map['id'] ?? 'idx-$i').toString();
                          map['_selKey'] = key;
                          indexedMsgs.add(map);
                          allMsgKeys.add(key);
                        }
                        final selectedList = indexedMsgs
                            .where((m) =>
                                _selectedArchiveMsgIds.contains(m['_selKey']))
                            .toList();
                        final allSelected = allMsgKeys.isNotEmpty &&
                            _selectedArchiveMsgIds.length == allMsgKeys.length;

                        return Column(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 8),
                              decoration: const BoxDecoration(
                                color: Colors.white,
                                border: Border(
                                    bottom:
                                        BorderSide(color: Color(0xFFE2E8F0))),
                              ),
                              child: Row(
                                children: [
                                  TextButton.icon(
                                    onPressed: () {
                                      setState(() {
                                        _selectedArchiveId = null;
                                        _selectedArchiveMsgIds.clear();
                                      });
                                    },
                                    style: TextButton.styleFrom(
                                      visualDensity: VisualDensity.compact,
                                    ),
                                    icon:
                                        const Icon(Icons.arrow_back, size: 18),
                                    label: const Text('Назад'),
                                  ),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          (openedArch['title'] ?? 'Урок')
                                              .toString(),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            fontWeight: FontWeight.w700,
                                            fontSize: 14,
                                            color: Color(0xFF0F172A),
                                          ),
                                        ),
                                        Text(
                                          'Сообщений: ${indexedMsgs.length} · Нажмите для выбора и пересылки',
                                          style: const TextStyle(
                                            fontSize: 11,
                                            color: Color(0xFF64748B),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  if (indexedMsgs.isNotEmpty)
                                    TextButton(
                                      onPressed: () {
                                        setState(() {
                                          if (allSelected) {
                                            _selectedArchiveMsgIds.clear();
                                          } else {
                                            _selectedArchiveMsgIds
                                              ..clear()
                                              ..addAll(allMsgKeys);
                                          }
                                        });
                                      },
                                      style: TextButton.styleFrom(
                                        visualDensity: VisualDensity.compact,
                                      ),
                                      child: Text(
                                        allSelected ? 'Снять' : 'Все',
                                        style: const TextStyle(fontSize: 12),
                                      ),
                                    ),
                                  IconButton(
                                    onPressed: () {
                                      final buf = StringBuffer();
                                      buf.writeln(
                                          '=== ${openedArch['title']} ===');
                                      for (final map in indexedMsgs) {
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
                                    icon: const Icon(Icons.copy, size: 18),
                                  ),
                                ],
                              ),
                            ),
                            Expanded(
                              child: indexedMsgs.isEmpty
                                  ? const Center(
                                      child: Text(
                                        'В этом уроке не было сообщений в чате.',
                                        style: TextStyle(
                                          color: Color(0xFF94A3B8),
                                          fontSize: 13,
                                        ),
                                      ),
                                    )
                                  : ListView.builder(
                                      padding: const EdgeInsets.all(16),
                                      itemCount: indexedMsgs.length,
                                      itemBuilder: (_, mIdx) {
                                        final map = indexedMsgs[mIdx];
                                        final selKey = map['_selKey'] as String;
                                        final isSelected =
                                            _selectedArchiveMsgIds
                                                .contains(selKey);
                                        final senderUsername =
                                            (map['username'] ?? '').toString();
                                        final senderId =
                                            (map['sender_id'] ?? '').toString();
                                        final senderName =
                                            (map['sender'] ?? 'Участник')
                                                .toString();
                                        final text =
                                            (map['text'] ?? '').toString();
                                        final myUsername =
                                            (_currentUser?['username'] ?? '')
                                                .toString();
                                        final isMe = (senderId.isNotEmpty &&
                                                senderId == myId) ||
                                            (senderUsername.isNotEmpty &&
                                                senderUsername.toLowerCase() ==
                                                    myUsername.toLowerCase());
                                        String timeLabel =
                                            (map['time'] ?? '').toString();
                                        if (timeLabel.isEmpty &&
                                            map['sentAt'] != null) {
                                          try {
                                            final dt = DateTime.parse(
                                                    map['sentAt'].toString())
                                                .toLocal();
                                            timeLabel =
                                                '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
                                          } catch (_) {}
                                        }
                                        ChatAttachmentMeta? attMeta;
                                        if (map['attachment'] is Map) {
                                          try {
                                            attMeta =
                                                ChatAttachmentMeta.fromJson(
                                              Map<String, dynamic>.from(
                                                  map['attachment'] as Map),
                                            );
                                          } catch (_) {}
                                        }
                                        final hideDefaultAttachmentCaption =
                                            attMeta != null &&
                                                (text.startsWith(
                                                        'Вложение: ') ||
                                                    text.startsWith(
                                                        'Голосовое сообщение') ||
                                                    text.startsWith(
                                                        'Видеокружок'));

                                        return GestureDetector(
                                          behavior: HitTestBehavior.opaque,
                                          onTap: () {
                                            setState(() {
                                              if (isSelected) {
                                                _selectedArchiveMsgIds
                                                    .remove(selKey);
                                              } else {
                                                _selectedArchiveMsgIds
                                                    .add(selKey);
                                              }
                                            });
                                          },
                                          child: Container(
                                            margin: const EdgeInsets.only(
                                                bottom: 10),
                                            padding: const EdgeInsets.symmetric(
                                                horizontal: 6, vertical: 4),
                                            decoration: BoxDecoration(
                                              color: isSelected
                                                  ? const Color(0xFFE0F2FE)
                                                      .withValues(alpha: 0.65)
                                                  : Colors.transparent,
                                              borderRadius:
                                                  BorderRadius.circular(18),
                                            ),
                                            child: Row(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.center,
                                              mainAxisAlignment: isMe
                                                  ? MainAxisAlignment.end
                                                  : MainAxisAlignment.start,
                                              children: [
                                                Checkbox(
                                                  value: isSelected,
                                                  visualDensity:
                                                      VisualDensity.compact,
                                                  activeColor:
                                                      const Color(0xFF0F172A),
                                                  shape: RoundedRectangleBorder(
                                                    borderRadius:
                                                        BorderRadius.circular(
                                                            6),
                                                  ),
                                                  onChanged: (v) {
                                                    setState(() {
                                                      if (v == true) {
                                                        _selectedArchiveMsgIds
                                                            .add(selKey);
                                                      } else {
                                                        _selectedArchiveMsgIds
                                                            .remove(selKey);
                                                      }
                                                    });
                                                  },
                                                ),
                                                Flexible(
                                                  child: ConstrainedBox(
                                                    constraints:
                                                        const BoxConstraints(
                                                      maxWidth: 280,
                                                    ),
                                                    child: Column(
                                                      crossAxisAlignment: isMe
                                                          ? CrossAxisAlignment
                                                              .end
                                                          : CrossAxisAlignment
                                                              .start,
                                                      children: [
                                                        Padding(
                                                          padding:
                                                              const EdgeInsets
                                                                  .only(
                                                            bottom: 3,
                                                            left: 4,
                                                            right: 4,
                                                          ),
                                                          child: Row(
                                                            mainAxisSize:
                                                                MainAxisSize
                                                                    .min,
                                                            children: [
                                                              Flexible(
                                                                child: Text(
                                                                  isMe
                                                                      ? 'Вы'
                                                                      : '$senderName (@$senderUsername)',
                                                                  overflow:
                                                                      TextOverflow
                                                                          .ellipsis,
                                                                  style:
                                                                      const TextStyle(
                                                                    fontSize:
                                                                        11,
                                                                    fontWeight:
                                                                        FontWeight
                                                                            .w600,
                                                                    color: Color(
                                                                        0xFF64748B),
                                                                  ),
                                                                ),
                                                              ),
                                                              if (timeLabel
                                                                  .isNotEmpty) ...[
                                                                const SizedBox(
                                                                    width: 6),
                                                                Text(
                                                                  timeLabel,
                                                                  style:
                                                                      const TextStyle(
                                                                    fontSize:
                                                                        10,
                                                                    color: Color(
                                                                        0xFF94A3B8),
                                                                  ),
                                                                ),
                                                              ],
                                                            ],
                                                          ),
                                                        ),
                                                        if ((!hideDefaultAttachmentCaption &&
                                                                text.isNotEmpty) ||
                                                            attMeta == null)
                                                          Container(
                                                            padding:
                                                                const EdgeInsets
                                                                    .symmetric(
                                                              horizontal: 14,
                                                              vertical: 10,
                                                            ),
                                                            decoration:
                                                                BoxDecoration(
                                                              color: isMe
                                                                  ? const Color(
                                                                      0xFF0F172A)
                                                                  : Colors
                                                                      .white,
                                                              borderRadius:
                                                                  BorderRadius
                                                                      .circular(
                                                                          16),
                                                              border: isMe
                                                                  ? null
                                                                  : Border.all(
                                                                      color: isSelected
                                                                          ? const Color(
                                                                              0xFF0284C7)
                                                                          : const Color(
                                                                              0xFFE2E8F0),
                                                                    ),
                                                            ),
                                                            child: Text(
                                                              text,
                                                              style: TextStyle(
                                                                fontSize: 14,
                                                                color: isMe
                                                                    ? Colors
                                                                        .white
                                                                    : const Color(
                                                                        0xFF0F172A),
                                                              ),
                                                            ),
                                                          ),
                                                        if (attMeta != null &&
                                                            _token != null)
                                                          ChatAttachmentCard(
                                                            key: ValueKey(
                                                                'arch-${attMeta.id}'),
                                                            attachment: attMeta,
                                                            serverUrl:
                                                                _serverUrl,
                                                            token: _token!,
                                                            isMe: isMe,
                                                            mediaChannel:
                                                                _mediaChannel,
                                                          ),
                                                      ],
                                                    ),
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                        );
                                      },
                                    ),
                            ),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 14, vertical: 10),
                              decoration: const BoxDecoration(
                                color: Color(0xFFF1F5F9),
                                border: Border(
                                    top: BorderSide(color: Color(0xFFE2E8F0))),
                              ),
                              child: selectedList.isEmpty
                                  ? const Row(
                                      mainAxisAlignment:
                                          MainAxisAlignment.center,
                                      children: [
                                        Icon(Icons.lock_outline,
                                            size: 16, color: Color(0xFF64748B)),
                                        SizedBox(width: 8),
                                        Flexible(
                                          child: Text(
                                            'Архив урока — только для чтения. Выберите сообщения для пересылки в чат.',
                                            style: TextStyle(
                                              fontSize: 12,
                                              color: Color(0xFF64748B),
                                              fontWeight: FontWeight.w500,
                                            ),
                                          ),
                                        ),
                                      ],
                                    )
                                  : Row(
                                      children: [
                                        Expanded(
                                          child: Text(
                                            'Выбрано: ${selectedList.length}',
                                            style: const TextStyle(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w700,
                                              color: Color(0xFF0F172A),
                                            ),
                                          ),
                                        ),
                                        TextButton(
                                          onPressed: () {
                                            setState(() {
                                              _selectedArchiveMsgIds.clear();
                                            });
                                          },
                                          child: const Text('Сбросить'),
                                        ),
                                        const SizedBox(width: 6),
                                        FilledButton.icon(
                                          onPressed: _forwardingFromArchive
                                              ? null
                                              : () =>
                                                  _showForwardArchiveMessagesSheet(
                                                    openedArch,
                                                    selectedList,
                                                  ),
                                          style: FilledButton.styleFrom(
                                            backgroundColor:
                                                const Color(0xFF0F172A),
                                            visualDensity:
                                                VisualDensity.compact,
                                          ),
                                          icon: const Icon(
                                              Icons.forward_rounded,
                                              size: 17),
                                          label: Text(
                                              'Переслать (${selectedList.length})'),
                                        ),
                                      ],
                                    ),
                            ),
                          ],
                        );
                      }

                      return ListView.builder(
                        padding: const EdgeInsets.all(14),
                        itemCount: _archivedChats.length,
                        itemBuilder: (_, idx) {
                          final arch = _archivedChats[idx];
                          final archId = (arch['id'] ?? '$idx').toString();
                          final msgs =
                              (arch['messages'] as List<dynamic>?) ?? [];
                          final lastMsg = msgs.isNotEmpty
                              ? (msgs.last as Map<String, dynamic>)
                              : null;
                          return InkWell(
                            borderRadius: BorderRadius.circular(14),
                            onTap: () {
                              setState(() {
                                _selectedArchiveId = archId;
                                _selectedArchiveMsgIds.clear();
                              });
                            },
                            child: Container(
                              margin: const EdgeInsets.only(bottom: 12),
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(14),
                                border:
                                    Border.all(color: const Color(0xFFE2E8F0)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      const Icon(Icons.forum_outlined,
                                          size: 18, color: Color(0xFF0F172A)),
                                      const SizedBox(width: 8),
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
                                      Text(
                                        '${msgs.length} сообщ.',
                                        style: const TextStyle(
                                          fontSize: 12,
                                          color: Color(0xFF64748B),
                                        ),
                                      ),
                                      const SizedBox(width: 4),
                                      const Icon(Icons.chevron_right,
                                          size: 18, color: Color(0xFF64748B)),
                                    ],
                                  ),
                                  if (lastMsg != null) ...[
                                    const SizedBox(height: 6),
                                    Text(
                                      '${lastMsg['sender']}: ${lastMsg['text']}',
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 12,
                                        color: Color(0xFF475569),
                                      ),
                                    ),
                                  ],
                                  const SizedBox(height: 8),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      TextButton.icon(
                                        onPressed: () {
                                          setState(() {
                                            _selectedArchiveId = archId;
                                            _selectedArchiveMsgIds.clear();
                                          });
                                        },
                                        style: TextButton.styleFrom(
                                          visualDensity: VisualDensity.compact,
                                        ),
                                        icon: const Icon(
                                            Icons.chat_bubble_outline,
                                            size: 15),
                                        label: const Text(
                                          'Открыть историю чата',
                                          style: TextStyle(fontSize: 12),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
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
                : (visibleMessages.isEmpty && visibleTransfers.isEmpty)
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.symmetric(horizontal: 32),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.chat_bubble_outline_rounded,
                                  size: 36, color: Color(0xFFCBD5E1)),
                              SizedBox(height: 10),
                              Text(
                                'Сообщений пока нет',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                    color: Color(0xFF334155),
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600),
                              ),
                              SizedBox(height: 4),
                              Text(
                                'Напишите первым или отправьте файл',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                    color: Color(0xFF94A3B8), fontSize: 13),
                              ),
                            ],
                          ),
                        ),
                      )
                    : RepaintBoundary(
                        child: ListView.builder(
                          controller: _chatScrollCtrl,
                          padding: const EdgeInsets.all(16),
                          itemCount:
                              visibleMessages.length + visibleTransfers.length,
                          itemBuilder: (_, idx) {
                            if (idx >= visibleMessages.length) {
                              final transfer = visibleTransfers[
                                  idx - visibleMessages.length];
                              return OutgoingTransferCardWidget(
                                key: ValueKey(transfer.localId),
                                transfer: transfer,
                                onCancel: () {
                                  setState(() {
                                    transfer.cancelled = true;
                                    _outgoingTransfers.removeWhere(
                                        (t) => t.localId == transfer.localId);
                                  });
                                },
                                onRetry: () => _runAttachmentTransfer(transfer),
                              );
                            }

                            final m = visibleMessages[idx];
                            final isMe = m.senderId == myId;
                            String timeLabel = '';
                            try {
                              final dt = DateTime.parse(m.sentAt).toLocal();
                              timeLabel =
                                  '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
                            } catch (_) {}

                            final hideDefaultAttachmentCaption = m.attachment !=
                                    null &&
                                (m.text.startsWith('Вложение: ') ||
                                    m.text.startsWith('Голосовое сообщение') ||
                                    m.text.startsWith('Видеокружок'));
                            final hasTextBubble =
                                (!hideDefaultAttachmentCaption &&
                                        m.text.trim().isNotEmpty) ||
                                    m.attachment == null;

                            return Align(
                              alignment: isMe
                                  ? Alignment.centerRight
                                  : Alignment.centerLeft,
                              child: GestureDetector(
                                onLongPress: isMe
                                    ? () => _showMessageActionsSheet(m)
                                    : null,
                                child: Container(
                                  margin: const EdgeInsets.only(bottom: 12),
                                  constraints: const BoxConstraints(
                                    maxWidth: 300,
                                  ),
                                  child: Column(
                                    crossAxisAlignment: isMe
                                        ? CrossAxisAlignment.end
                                        : CrossAxisAlignment.start,
                                    children: [
                                      Padding(
                                        padding: const EdgeInsets.only(
                                          bottom: 3,
                                          left: 4,
                                          right: 4,
                                        ),
                                        child: Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Flexible(
                                              child: Text(
                                                isMe
                                                    ? 'Вы'
                                                    : '${m.senderDisplayName} (@${m.senderUsername})',
                                                overflow: TextOverflow.ellipsis,
                                                style: const TextStyle(
                                                  fontSize: 11,
                                                  fontWeight: FontWeight.w600,
                                                  color: Color(0xFF64748B),
                                                ),
                                              ),
                                            ),
                                            if (timeLabel.isNotEmpty) ...[
                                              const SizedBox(width: 6),
                                              Text(
                                                timeLabel,
                                                style: const TextStyle(
                                                  fontSize: 10,
                                                  color: Color(0xFF94A3B8),
                                                ),
                                              ),
                                            ],
                                            if (m.editedAt != null &&
                                                m.editedAt!.isNotEmpty) ...[
                                              const SizedBox(width: 4),
                                              const Text(
                                                '(изм.)',
                                                style: TextStyle(
                                                  fontSize: 10,
                                                  fontStyle: FontStyle.italic,
                                                  color: Color(0xFF94A3B8),
                                                ),
                                              ),
                                            ],
                                            if (isMe) ...[
                                              const SizedBox(width: 4),
                                              InkWell(
                                                borderRadius:
                                                    BorderRadius.circular(8),
                                                onTap: () =>
                                                    _showMessageActionsSheet(m),
                                                child: const Padding(
                                                  padding: EdgeInsets.symmetric(
                                                    horizontal: 4,
                                                    vertical: 1,
                                                  ),
                                                  child: Icon(
                                                    Icons.more_horiz_rounded,
                                                    size: 16,
                                                    color: Color(0xFF64748B),
                                                  ),
                                                ),
                                              ),
                                            ],
                                          ],
                                        ),
                                      ),
                                      if (hasTextBubble)
                                        Container(
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 14,
                                            vertical: 10,
                                          ),
                                          decoration: BoxDecoration(
                                            color: isMe
                                                ? const Color(0xFF4F46E5)
                                                : Colors.white,
                                            borderRadius:
                                                BorderRadius.circular(16),
                                            border: isMe
                                                ? null
                                                : Border.all(
                                                    color: const Color(
                                                        0xFFE2E8F0)),
                                          ),
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              if (m.forwarded != null)
                                                _forwardedLabel(
                                                    m.forwarded!, isMe),
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
                                      if (m.forwarded != null && !hasTextBubble)
                                        _forwardedLabel(m.forwarded!, false),
                                      if (m.attachment != null &&
                                          _token != null)
                                        ChatAttachmentCard(
                                          key: ValueKey(m.attachment!.id),
                                          attachment: m.attachment!,
                                          serverUrl: _serverUrl,
                                          token: _token!,
                                          isMe: isMe,
                                          mediaChannel: _mediaChannel,
                                        ),
                                    ],
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
                      ),
          ),

          if (_noteRecordMode != 'idle') _buildNoteRecorderPanel(),
          if (_showEmojiPicker &&
              targetRoomId != null &&
              _noteRecordMode == 'idle')
            _buildEmojiPickerPanel(),
          if (_editingMessage != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: const BoxDecoration(
                color: Color(0xFFEEF2FF),
                border: Border(top: BorderSide(color: Color(0xFFC7D2FE))),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.edit_outlined,
                    size: 16,
                    color: Color(0xFF4F46E5),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text(
                          'Редактирование сообщения',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF4338CA),
                          ),
                        ),
                        Text(
                          _editingMessage!.text,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xFF475569),
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    tooltip: 'Отменить редактирование',
                    onPressed: () {
                      setState(() {
                        _editingMessage = null;
                        _chatInputCtrl.clear();
                      });
                    },
                    icon: const Icon(
                      Icons.close_rounded,
                      size: 18,
                      color: Color(0xFF64748B),
                    ),
                  ),
                ],
              ),
            ),

          // Кнопка вложений слева, поле ввода и отправка справа
          Container(
            padding: const EdgeInsets.fromLTRB(10, 8, 8, 10),
            decoration: const BoxDecoration(
              color: Colors.white,
              border: Border(top: BorderSide(color: Color(0xFFE2E8F0))),
            ),
            child: Row(
              children: [
                _buildAttachButton(
                    enabled: targetRoomId != null && _wsConnected),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _chatInputCtrl,
                    enabled: targetRoomId != null && _wsConnected,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _sendChatMessage(),
                    decoration: InputDecoration(
                      hintText: targetRoomId == null
                          ? 'Выберите контакт или начните урок'
                          : _chatMode == 'direct' &&
                                  _selectedChatContact != null
                              ? 'Сообщение для @${_selectedChatContact!['username']}...'
                              : 'Сообщение или подпись...',
                      isDense: true,
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 11,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: const BorderSide(color: Color(0xFFE2E8F0)),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: _chatInputCtrl,
                  builder: (context, textVal, _) {
                    final canSend = targetRoomId != null &&
                        _wsConnected &&
                        !_sendingChat &&
                        (_noteRecordMode != 'idle' ||
                            textVal.text.trim().isNotEmpty);
                    return IconButton.filled(
                      tooltip: 'Отправить сообщение',
                      onPressed: !canSend
                          ? null
                          : () {
                              if (_noteRecordMode != 'idle') {
                                _sendRecordedNote();
                              } else {
                                _sendChatMessage();
                              }
                            },
                      style: IconButton.styleFrom(
                        backgroundColor: const Color(0xFF4F46E5),
                        foregroundColor: Colors.white,
                      ),
                      icon: const Icon(Icons.send_rounded, size: 19),
                    );
                  },
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  bool _attachMenuOpen = false;

  /// Круглая кнопка «+» слева от поля ввода: поворачивается в «×» и открывает шторку вложений.
  Widget _buildAttachButton({required bool enabled}) {
    final active = _attachMenuOpen || _showEmojiPicker;
    return Semantics(
      button: true,
      label: 'Открыть меню вложений',
      child: Tooltip(
        message: 'Файл, голосовое, видеокружок, эмодзи',
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: !enabled
                ? const Color(0xFFF1F5F9)
                : active
                    ? const Color(0xFF4F46E5)
                    : const Color(0xFFEEF2FF),
            boxShadow: active && enabled
                ? const [
                    BoxShadow(
                      color: Color(0x554F46E5),
                      blurRadius: 14,
                      offset: Offset(0, 6),
                    ),
                  ]
                : null,
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: enabled ? _openAttachSheet : null,
              child: Center(
                child: AnimatedRotation(
                  turns: _attachMenuOpen ? 0.125 : 0,
                  duration: const Duration(milliseconds: 220),
                  curve: Curves.easeOutBack,
                  child: Icon(
                    Icons.add_rounded,
                    size: 26,
                    color: !enabled
                        ? const Color(0xFF94A3B8)
                        : active
                            ? Colors.white
                            : const Color(0xFF4F46E5),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openAttachSheet() async {
    setState(() => _attachMenuOpen = true);
    final idle = _noteRecordMode == 'idle';
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.white,
      showDragHandle: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) {
        Widget tile(
            String value, IconData icon, String title, Color bg, Color fg,
            {bool enabled = true}) {
          return Expanded(
            child: Opacity(
              opacity: enabled ? 1 : 0.4,
              child: InkWell(
                borderRadius: BorderRadius.circular(16),
                onTap: enabled ? () => Navigator.pop(ctx, value) : null,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 56,
                        height: 56,
                        decoration:
                            BoxDecoration(color: bg, shape: BoxShape.circle),
                        child: Icon(icon, color: fg, size: 26),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        title,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        }

        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(left: 4, bottom: 12),
                  child: Text(
                    'Прикрепить',
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                ),
                Row(
                  children: [
                    tile('file', Icons.description_rounded, 'Файл',
                        const Color(0xFFEEF2FF), const Color(0xFF4F46E5),
                        enabled: idle),
                    tile('voice', Icons.mic_rounded, 'Голосовое',
                        const Color(0xFFECFDF5), const Color(0xFF059669),
                        enabled: idle),
                    tile('video', Icons.videocam_rounded, 'Кружок',
                        const Color(0xFFFFF1F2), const Color(0xFFE11D48),
                        enabled: idle),
                    tile(
                        'emoji',
                        Icons.emoji_emotions_rounded,
                        _showEmojiPicker ? 'Скрыть эмодзи' : 'Эмодзи',
                        const Color(0xFFFFFBEB),
                        const Color(0xFFD97706)),
                  ],
                ),
                const SizedBox(height: 10),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 4),
                  child: Text(
                    'PDF, Word и фото до 128 МБ. Файлы шифруются на телефоне перед отправкой.',
                    style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
    if (!mounted) return;
    setState(() => _attachMenuOpen = false);
    switch (action) {
      case 'emoji':
        setState(() => _showEmojiPicker = !_showEmojiPicker);
        break;
      case 'file':
        if (_noteRecordMode == 'idle') _pickAndSendAttachmentFile();
        break;
      case 'voice':
        if (_noteRecordMode == 'idle') {
          _startVoiceOrVideoNoteRecording(isVideo: false);
        }
        break;
      case 'video':
        if (_noteRecordMode == 'idle') {
          _startVoiceOrVideoNoteRecording(isVideo: true);
        }
        break;
    }
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
            active: _selectedTabIndex == 3,
            refreshTrigger: _storageRefreshTrigger),
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
                backgroundColor: const Color(0xFF4F46E5),
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

        // Админка и мониторинг кластера
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Row(
                children: [
                  Icon(Icons.monitor_heart_outlined,
                      size: 19, color: Color(0xFF0F172A)),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Мониторинг всей системы (Админка)',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              const Text(
                'Статус Control Server, PostgreSQL, SFU медиа-нод, файловой ноды, активных уроков и квот всех пользователей.',
                style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: _showAdminMonitoringSheet,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF4F46E5),
                ),
                icon: const Icon(Icons.dns_outlined, size: 18),
                label: const Text('Открыть админку мониторинга'),
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
                      backgroundColor: const Color(0xFF4F46E5),
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

  void _showReportChatSheet(String roomId, String roomTitle) {
    if (_token == null) return;
    final parentBottomInset = MediaQuery.viewPaddingOf(context).bottom;
    final reasonCtrl = TextEditingController(
      text: 'Оскорбления / нарушение правил занятия',
    );
    bool submitting = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            final modalBottomSafe =
                MediaQuery.viewPaddingOf(ctx).bottom > parentBottomInset
                    ? MediaQuery.viewPaddingOf(ctx).bottom
                    : parentBottomInset;
            final keyboardInset = MediaQuery.viewInsetsOf(ctx).bottom;
            return SafeArea(
              top: false,
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  20,
                  20,
                  20,
                  keyboardInset + modalBottomSafe + 44,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.flag, color: Color(0xFFE11D48)),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text(
                            'Жалоба с раскрытием ключа E2EE',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF0F172A),
                            ),
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.pop(ctx),
                          icon: const Icon(Icons.close),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      roomTitle,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF475569),
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'При отправке жалобы вы добровольно передаёте в Админку ключи текущей комнаты и снимок переписки для проверки. После отправки ключ комнаты будет автоматически обновлён (ротирован).',
                      style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: reasonCtrl,
                      maxLines: 3,
                      decoration: const InputDecoration(
                        labelText: 'Причина жалобы',
                        hintText: 'Опишите нарушение...',
                      ),
                    ),
                    const SizedBox(height: 14),
                    FilledButton.icon(
                      onPressed: submitting
                          ? null
                          : () async {
                              final reason = reasonCtrl.text.trim();
                              if (reason.isEmpty || _token == null) return;
                              setModalState(() => submitting = true);
                              try {
                                await _ensureActiveRoomKey(roomId,
                                    forceRotate: false);
                                final ring = _roomKeyrings[roomId];
                                final disclosedKeys = ring == null
                                    ? <Map<String, dynamic>>[]
                                    : ring.keysById.values
                                        .map((k) => {
                                              'key_id': k.roomKeyId,
                                              'raw_key_b64': k.rawKeyB64,
                                              'created_at': DateTime.now()
                                                  .toUtc()
                                                  .toIso8601String(),
                                            })
                                        .toList();
                                final res = await http
                                    .post(
                                      Uri.parse('$_serverUrl/api/reports'),
                                      headers: {
                                        'Authorization': 'Bearer $_token',
                                        'Content-Type': 'application/json',
                                      },
                                      body: jsonEncode({
                                        'room_id': roomId,
                                        'room_title': roomTitle,
                                        'reason': reason,
                                        'disclosed_keys': disclosedKeys,
                                      }),
                                    )
                                    .timeout(const Duration(seconds: 8));
                                if (res.statusCode != 200) {
                                  throw Exception('HTTP ${res.statusCode}');
                                }
                                await _ensureActiveRoomKey(roomId,
                                    forceRotate: true);
                                if (ctx.mounted) Navigator.pop(ctx);
                                if (mounted) {
                                  setState(() {
                                    _statusMessage =
                                        'Жалоба отправлена в Админку. Ключ переписки раскрыт и автоматически ротирован.';
                                  });
                                }
                              } catch (e) {
                                setModalState(() => submitting = false);
                                if (mounted) {
                                  setState(() {
                                    _statusMessage =
                                        'Не удалось отправить жалобу ($e)';
                                  });
                                }
                              }
                            },
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFFE11D48),
                      ),
                      icon: const Icon(Icons.flag_outlined, size: 18),
                      label: Text(submitting
                          ? 'Отправка…'
                          : 'Раскрыть ключ и отправить жалобу'),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  void _showAdminMonitoringSheet() {
    final parentBottomInset = MediaQuery.viewPaddingOf(context).bottom;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: const Color(0xFF4F46E5),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        Map<String, dynamic>? overview;
        String? err;
        bool loading = true;
        bool requestedInitial = false;

        Future<void> load(StateSetter setModalState) async {
          setModalState(() {
            loading = true;
            err = null;
          });
          try {
            final res = await http
                .get(Uri.parse('$_serverUrl/api/admin/overview'))
                .timeout(const Duration(seconds: 6));
            if (res.statusCode != 200) {
              throw Exception('HTTP ${res.statusCode}');
            }
            final json = jsonDecode(res.body) as Map<String, dynamic>;
            setModalState(() {
              overview = json;
              loading = false;
            });
          } catch (e) {
            setModalState(() {
              err = 'Не удалось загрузить телеметрию кластера ($e)';
              loading = false;
            });
          }
        }

        return StatefulBuilder(
          builder: (ctx, setModalState) {
            if (!requestedInitial) {
              requestedInitial = true;
              Future.microtask(() => load(setModalState));
            }
            final modalBottomSafe =
                MediaQuery.viewPaddingOf(ctx).bottom > parentBottomInset
                    ? MediaQuery.viewPaddingOf(ctx).bottom
                    : parentBottomInset;
            final summary =
                (overview?['summary'] as Map<String, dynamic>?) ?? const {};
            final nodes = (overview?['media_nodes'] as List<dynamic>?) ?? [];
            final users = (overview?['users'] as List<dynamic>?) ?? [];
            final rooms = (overview?['active_rooms'] as List<dynamic>?) ?? [];
            final fileNodes = (overview?['file_nodes'] as List<dynamic>?) ?? [];
            final reports = (overview?['reports'] as List<dynamic>?) ?? [];
            final antifraud =
                (overview?['antifraud'] as Map<String, dynamic>?) ?? const {};
            final afCounters =
                (antifraud['counters'] as Map<String, dynamic>?) ?? const {};
            final afIncidents =
                (antifraud['incidents'] as List<dynamic>?) ?? [];
            final fnOnline = fileNodes.isNotEmpty &&
                (fileNodes.first as Map)['online'] == true;

            return SafeArea(
              top: false,
              child: DraggableScrollableSheet(
                expand: false,
                initialChildSize: 0.88,
                minChildSize: 0.5,
                maxChildSize: 0.96,
                builder: (_, scrollCtrl) {
                  return Padding(
                    padding:
                        EdgeInsets.fromLTRB(16, 16, 16, modalBottomSafe + 28),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.monitor_heart,
                                color: Color(0xFF34D399)),
                            const SizedBox(width: 8),
                            const Expanded(
                              child: Text(
                                'Liaper Admin — Мониторинг системы',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            IconButton(
                              onPressed: () => load(setModalState),
                              icon: const Icon(Icons.refresh,
                                  color: Colors.white70),
                            ),
                            IconButton(
                              onPressed: () => Navigator.pop(ctx),
                              icon: const Icon(Icons.close,
                                  color: Colors.white70),
                            ),
                          ],
                        ),
                        const Divider(color: Colors.white12),
                        Expanded(
                          child: loading && overview == null
                              ? const Center(
                                  child: CircularProgressIndicator(
                                      color: Colors.white))
                              : err != null
                                  ? Center(
                                      child: Text(
                                        err!,
                                        style: const TextStyle(
                                            color: Color(0xFFFDA4AF)),
                                      ),
                                    )
                                  : ListView(
                                      controller: scrollCtrl,
                                      children: [
                                        Wrap(
                                          spacing: 8,
                                          runSpacing: 8,
                                          children: [
                                            _adminStatChip(
                                              'Control Server',
                                              'ONLINE (:4000)',
                                              true,
                                            ),
                                            _adminStatChip(
                                              'PostgreSQL 16',
                                              overview?['database_connected'] ==
                                                      true
                                                  ? 'CONNECTED'
                                                  : 'JSON FALLBACK',
                                              overview?['database_connected'] ==
                                                  true,
                                            ),
                                            _adminStatChip(
                                              'File Node (:4201)',
                                              fnOnline ? 'ONLINE' : 'OFFLINE',
                                              fnOnline,
                                            ),
                                            _adminStatChip(
                                              'SFU Ноды',
                                              '${nodes.length} в пуле',
                                              nodes.isNotEmpty,
                                            ),
                                          ],
                                        ),
                                        const SizedBox(height: 12),
                                        Container(
                                          padding: const EdgeInsets.all(12),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFF1E293B),
                                            borderRadius:
                                                BorderRadius.circular(12),
                                            border: Border.all(
                                              color: const Color(0xFF10B981)
                                                  .withValues(alpha: 0.4),
                                            ),
                                          ),
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Row(
                                                children: [
                                                  const Icon(
                                                    Icons.shield_outlined,
                                                    size: 16,
                                                    color: Color(0xFF34D399),
                                                  ),
                                                  const SizedBox(width: 6),
                                                  const Expanded(
                                                    child: Text(
                                                      'Liaper Shield — Антифрод и защита от DDoS',
                                                      style: TextStyle(
                                                        color:
                                                            Color(0xFF34D399),
                                                        fontSize: 12,
                                                        fontWeight:
                                                            FontWeight.w700,
                                                      ),
                                                    ),
                                                  ),
                                                  Text(
                                                    'Карантинов: ${antifraud['active_quarantines'] ?? 0}',
                                                    style: const TextStyle(
                                                      color: Colors.white70,
                                                      fontSize: 11,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                              const SizedBox(height: 6),
                                              Text(
                                                'Отражено атак: ${afCounters['total_blocked_requests'] ?? 0} · Брутфорс: ${afCounters['auth_bruteforce_blocked'] ?? 0} · WS/Memory Bomb: ${(afCounters['ws_flood_blocked'] ?? 0) + (afCounters['oversized_payload_blocked'] ?? 0)} · Call/Upload спам: ${(afCounters['call_spam_blocked'] ?? 0) + (afCounters['upload_abuse_blocked'] ?? 0)}',
                                                style: const TextStyle(
                                                  color: Colors.white,
                                                  fontSize: 11,
                                                ),
                                              ),
                                              if (afIncidents.isNotEmpty) ...[
                                                const SizedBox(height: 6),
                                                Text(
                                                  'Последний инцидент: ${(afIncidents.first as Map)['description']}',
                                                  style: const TextStyle(
                                                    color: Color(0xFFFDA4AF),
                                                    fontSize: 11,
                                                  ),
                                                ),
                                              ],
                                            ],
                                          ),
                                        ),
                                        const SizedBox(height: 12),
                                        Container(
                                          padding: const EdgeInsets.all(12),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFF1E293B),
                                            borderRadius:
                                                BorderRadius.circular(12),
                                          ),
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                'Пользователи: ${summary['online_users'] ?? 0} онлайн из ${summary['total_users'] ?? 0} (Репетиторов: ${summary['tutors_count'] ?? 0}, Учеников: ${summary['students_count'] ?? 0})',
                                                style: const TextStyle(
                                                    color: Colors.white,
                                                    fontSize: 12,
                                                    fontWeight:
                                                        FontWeight.w600),
                                              ),
                                              const SizedBox(height: 4),
                                              Text(
                                                'Активных уроков: ${rooms.length} · Зашифрованных сообщений: ${summary['total_encrypted_messages'] ?? 0} · E2EE конвертов: ${summary['total_key_envelopes'] ?? 0}',
                                                style: const TextStyle(
                                                    color: Colors.white70,
                                                    fontSize: 12),
                                              ),
                                              const SizedBox(height: 4),
                                              Text(
                                                'Файлов в хранилище: ${summary['total_attachments_ready'] ?? 0} · Архивов уроков в БД: ${summary['total_lesson_archives'] ?? 0}',
                                                style: const TextStyle(
                                                    color: Colors.white70,
                                                    fontSize: 12),
                                              ),
                                            ],
                                          ),
                                        ),
                                        const SizedBox(height: 14),
                                        Text(
                                          'Жалобы с раскрытием ключа (${reports.length})',
                                          style: const TextStyle(
                                            color: Color(0xFFFDA4AF),
                                            fontWeight: FontWeight.w700,
                                            fontSize: 13,
                                          ),
                                        ),
                                        const SizedBox(height: 6),
                                        if (reports.isEmpty)
                                          Container(
                                            margin: const EdgeInsets.only(
                                                bottom: 10),
                                            padding: const EdgeInsets.all(10),
                                            decoration: BoxDecoration(
                                              color: const Color(0xFF1E293B),
                                              borderRadius:
                                                  BorderRadius.circular(10),
                                            ),
                                            child: const Text(
                                              'Жалоб пока нет — все чаты защищены E2EE.',
                                              style: TextStyle(
                                                  color: Colors.white60,
                                                  fontSize: 12),
                                            ),
                                          )
                                        else
                                          ...reports.map((rawRep) {
                                            final r =
                                                rawRep as Map<String, dynamic>;
                                            final keys = (r['disclosed_keys']
                                                    as List<dynamic>?) ??
                                                [];
                                            final snap = (r['messages_snapshot']
                                                    as List<dynamic>?) ??
                                                [];
                                            return Container(
                                              margin: const EdgeInsets.only(
                                                  bottom: 8),
                                              padding: const EdgeInsets.all(10),
                                              decoration: BoxDecoration(
                                                color: const Color(0xFF1E293B),
                                                borderRadius:
                                                    BorderRadius.circular(10),
                                                border: Border.all(
                                                  color: r['status'] == 'open'
                                                      ? const Color(0xFFF43F5E)
                                                      : Colors.white12,
                                                ),
                                              ),
                                              child: Column(
                                                crossAxisAlignment:
                                                    CrossAxisAlignment.start,
                                                children: [
                                                  Text(
                                                    '${r['room_title']} · от ${r['reporter_display_name']} (@${r['reporter_username']}) · [${r['status'] == 'open' ? 'Открыта' : 'Решена'}]',
                                                    style: const TextStyle(
                                                      color: Colors.white,
                                                      fontSize: 12,
                                                      fontWeight:
                                                          FontWeight.w700,
                                                    ),
                                                  ),
                                                  const SizedBox(height: 4),
                                                  Text(
                                                    'Причина: ${r['reason']}',
                                                    style: const TextStyle(
                                                      color: Color(0xFFFDA4AF),
                                                      fontSize: 12,
                                                    ),
                                                  ),
                                                  const SizedBox(height: 4),
                                                  Text(
                                                    'Раскрыто ключей E2EE: ${keys.length} · Сообщений в снимке: ${snap.length}',
                                                    style: const TextStyle(
                                                      color: Colors.white70,
                                                      fontSize: 11,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            );
                                          }),
                                        const SizedBox(height: 10),
                                        const Text(
                                          'SFU Медиа-ноды',
                                          style: TextStyle(
                                            color: Colors.white,
                                            fontWeight: FontWeight.w700,
                                            fontSize: 13,
                                          ),
                                        ),
                                        const SizedBox(height: 6),
                                        ...nodes.map((rawNode) {
                                          final n =
                                              rawNode as Map<String, dynamic>;
                                          return Container(
                                            margin: const EdgeInsets.only(
                                                bottom: 8),
                                            padding: const EdgeInsets.all(10),
                                            decoration: BoxDecoration(
                                              color: const Color(0xFF1E293B),
                                              borderRadius:
                                                  BorderRadius.circular(10),
                                            ),
                                            child: Text(
                                              '${n['name']} (${n['region']}) · CPU: ${n['cpu_usage_percent']}% · RAM: ${n['memory_usage_percent']}% · Пиры: ${n['active_peers']}/${n['max_peers']} · Load: ${(n['load_score'] as num?)?.toStringAsFixed(1)}%',
                                              style: const TextStyle(
                                                  color: Colors.white,
                                                  fontSize: 12),
                                            ),
                                          );
                                        }),
                                        const SizedBox(height: 10),
                                        Text(
                                          'Пользователи (${users.length})',
                                          style: const TextStyle(
                                            color: Colors.white,
                                            fontWeight: FontWeight.w700,
                                            fontSize: 13,
                                          ),
                                        ),
                                        const SizedBox(height: 6),
                                        ...users.map((rawUser) {
                                          final u =
                                              rawUser as Map<String, dynamic>;
                                          final on = u['online'] == true;
                                          final role = u['role'] == 'tutor'
                                              ? 'Репетитор'
                                              : 'Ученик';
                                          return Container(
                                            margin: const EdgeInsets.only(
                                                bottom: 8),
                                            padding: const EdgeInsets.all(10),
                                            decoration: BoxDecoration(
                                              color: const Color(0xFF1E293B),
                                              borderRadius:
                                                  BorderRadius.circular(10),
                                            ),
                                            child: Row(
                                              children: [
                                                Icon(
                                                  Icons.circle,
                                                  size: 10,
                                                  color: on
                                                      ? const Color(0xFF34D399)
                                                      : Colors.white38,
                                                ),
                                                const SizedBox(width: 8),
                                                Expanded(
                                                  child: Text(
                                                    '${u['display_name']} (@${u['username']}) · $role · Контактов: ${u['contacts_count']} · Файлов: ${u['attachments_count']} · Архивов: ${u['archives_count']}',
                                                    style: const TextStyle(
                                                        color: Colors.white,
                                                        fontSize: 12),
                                                  ),
                                                ),
                                              ],
                                            ),
                                          );
                                        }),
                                      ],
                                    ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            );
          },
        );
      },
    );
  }

  Widget _adminStatChip(String title, String value, bool ok) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: ok ? const Color(0xFF10B981) : const Color(0xFFF43F5E),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(title,
              style: const TextStyle(color: Colors.white60, fontSize: 10)),
          const SizedBox(height: 2),
          Text(
            value,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
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
                    const Row(
                      children: [
                        LiaperLogoMark(size: 44),
                        SizedBox(width: 12),
                        Expanded(
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
                        helperText: _isRegister ? 'Не менее 8 символов' : null,
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
                        backgroundColor: const Color(0xFF4F46E5),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 15),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: Text(
                        _authCheckingRobot
                            ? 'Проверяем, что вы не робот…'
                            : _authLoading
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
