import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Кусок текста сообщения: обычный текст или ссылка ([href] не null).
class TextPart {
  const TextPart(this.text, [this.href]);
  final String text;
  final String? href;
}

// Только http(s) и www.; превью не грузим — переписка шифруется,
// а загрузка страницы выдала бы сайту, что ссылку кто-то открыл.
final _linkRe = RegExp(r'''\b(?:https?://|www\.)[^\s<>"'«»]+''', caseSensitive: false);
final _trailingRe = RegExp(r'[.,!?;:…]+$');

String _trimTrailing(String url) {
  var out = url.replaceFirst(_trailingRe, '');
  // Закрывающая скобка без открывающей — это скобка вокруг ссылки: «(см. https://a.ru)»
  while (out.endsWith(')') && '('.allMatches(out).length < ')'.allMatches(out).length) {
    out = out.substring(0, out.length - 1).replaceFirst(_trailingRe, '');
  }
  return out;
}

List<TextPart> splitLinks(String text) {
  final parts = <TextPart>[];
  var last = 0;
  for (final match in _linkRe.allMatches(text)) {
    final raw = _trimTrailing(match.group(0)!);
    if (raw.isEmpty || RegExp(r'^(?:https?://|www\.)$', caseSensitive: false).hasMatch(raw)) {
      continue;
    }
    if (match.start > last) parts.add(TextPart(text.substring(last, match.start)));
    final href = raw.toLowerCase().startsWith('www.') ? 'https://$raw' : raw;
    parts.add(TextPart(raw, href));
    last = match.start + raw.length;
  }
  if (last < text.length) parts.add(TextPart(text.substring(last)));
  return parts;
}

/// Текст сообщения с кликабельными ссылками; ссылка открывается через [onOpen].
class LinkifiedText extends StatefulWidget {
  const LinkifiedText(this.text, {super.key, required this.style, required this.onOpen});

  final String text;
  final TextStyle style;
  final void Function(String url) onOpen;

  @override
  State<LinkifiedText> createState() => _LinkifiedTextState();
}

class _LinkifiedTextState extends State<LinkifiedText> {
  final List<TapGestureRecognizer> _recognizers = [];

  void _disposeRecognizers() {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
  }

  @override
  void dispose() {
    _disposeRecognizers();
    super.dispose();
  }

  TapGestureRecognizer _tap(String href) {
    final r = TapGestureRecognizer()..onTap = () => widget.onOpen(href);
    _recognizers.add(r);
    return r;
  }

  @override
  Widget build(BuildContext context) {
    _disposeRecognizers();
    final parts = splitLinks(widget.text);
    if (parts.every((p) => p.href == null)) return Text(widget.text, style: widget.style);
    return Text.rich(TextSpan(
      style: widget.style,
      children: [
        for (final part in parts)
          if (part.href == null)
            TextSpan(text: part.text)
          else
            TextSpan(
              text: part.text,
              style: const TextStyle(decoration: TextDecoration.underline),
              recognizer: _tap(part.href!),
            ),
      ],
    ));
  }
}
