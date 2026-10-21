import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

class StorageUsageCard extends StatefulWidget {
  const StorageUsageCard(
      {super.key,
      required this.baseUrl,
      required this.token,
      required this.active});
  final String baseUrl;
  final String token;
  final bool active;
  @override
  State<StorageUsageCard> createState() => _StorageUsageCardState();
}

class _StorageUsageCardState extends State<StorageUsageCard> {
  Map<String, dynamic>? _usage;
  bool _loading = false;
  String? _error;
  int _request = 0;
  @override
  void initState() {
    super.initState();
    if (widget.active) _refresh();
  }

  @override
  void didUpdateWidget(covariant StorageUsageCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.token != widget.token ||
        oldWidget.baseUrl != widget.baseUrl) {
      _request++;
      _usage = null;
      _error = null;
    }
    if (widget.active &&
        (!oldWidget.active ||
            oldWidget.token != widget.token ||
            oldWidget.baseUrl != widget.baseUrl)) {
      _refresh();
    }
  }

  Future<void> _refresh() async {
    final request = ++_request;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await http
          .get(Uri.parse('${widget.baseUrl}/api/storage/usage'), headers: {
        'Authorization': 'Bearer ${widget.token}'
      }).timeout(const Duration(seconds: 15));
      if (response.statusCode != 200) throw const FormatException();
      final usage = jsonDecode(response.body) as Map<String, dynamic>;
      if (mounted && request == _request) {
        setState(() {
          _usage = usage;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted && request == _request) {
        setState(() {
          _loading = false;
          _error = 'Не удалось обновить занятое место. Проверьте соединение.';
        });
      }
    }
  }

  String _size(num bytes) {
    if (bytes == 0) return '0 Б';
    final unit = bytes >= 1073741824
        ? 3
        : bytes >= 1048576
            ? 2
            : bytes >= 1024
                ? 1
                : 0;
    return '${(bytes / [
          1,
          1024,
          1048576,
          1073741824
        ][unit]).toStringAsFixed(unit == 0 ? 0 : 2).replaceAll('.', ',')} ${[
      'Б',
      'КиБ',
      'МиБ',
      'ГиБ'
    ][unit]}';
  }

  @override
  Widget build(BuildContext context) {
    final used = (_usage?['used_bytes'] as num?) ?? 0;
    final reserved = (_usage?['reserved_bytes'] as num?) ?? 0;
    final quota = (_usage?['quota_bytes'] as num?) ?? 5368709120;
    return Card(
        margin: EdgeInsets.zero,
        elevation: 0,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: Color(0xFFE2E8F0))),
        child: Padding(
            padding: const EdgeInsets.all(16),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const Expanded(
                    child: Text('Хранилище',
                        style: TextStyle(
                            fontWeight: FontWeight.w700, fontSize: 16))),
                IconButton(
                    tooltip: 'Обновить занятое место',
                    onPressed: _loading ? null : _refresh,
                    icon: const Icon(Icons.refresh))
              ]),
              Semantics(
                  liveRegion: true,
                  child: Text(_usage != null
                      ? '${_size(used)} из ${_size(quota)}'
                      : _loading
                          ? 'Получаем данные…'
                          : _error ?? 'Лимит — 5 ГиБ на аккаунт')),
              if (_usage != null) ...[
                const SizedBox(height: 12),
                LinearProgressIndicator(
                    value: ((used + reserved) / quota).clamp(0, 1).toDouble(),
                    semanticsLabel: 'Занятое место с учётом загрузок'),
                if (reserved > 0)
                  Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text('Загружается: ${_size(reserved)}')),
              ],
              if (_usage != null && _error != null)
                Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_error!)),
              const SizedBox(height: 12),
              const Text(
                  'Файлы, голосовые сообщения и кружки хранятся один месяц с момента загрузки, затем удаляются автоматически. Лимит — 5 ГиБ на аккаунт.',
                  style: TextStyle(fontSize: 12, color: Color(0xFF64748B))),
            ])));
  }
}
