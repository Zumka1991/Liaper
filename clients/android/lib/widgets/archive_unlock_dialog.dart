import 'package:flutter/material.dart';

class ArchiveUnlockDialog extends StatefulWidget {
  const ArchiveUnlockDialog({super.key});
  @override
  State<ArchiveUnlockDialog> createState() => _ArchiveUnlockDialogState();
}

class _ArchiveUnlockDialogState extends State<ArchiveUnlockDialog> {
  final _password = TextEditingController();
  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  void _submit() {
    if (_password.text.isNotEmpty) Navigator.pop(context, _password.text);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Разблокировать архив'),
        content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text(
              'Введите пароль аккаунта для расшифровки и синхронизации истории уроков. Ключ действует до закрытия приложения или выхода.'),
          const SizedBox(height: 16),
          TextField(
              controller: _password,
              obscureText: true,
              autofocus: true,
              autofillHints: const [AutofillHints.password],
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(labelText: 'Пароль аккаунта')),
        ])),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Отмена')),
          FilledButton(onPressed: _submit, child: const Text('Разблокировать'))
        ],
      );
}
