import 'package:flutter/material.dart';

/// Знак Liaper: облачко чата с буквой «L» и искрой (как в Web и иконке приложения).
class LiaperLogoMark extends StatelessWidget {
  const LiaperLogoMark({super.key, this.size = 36});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Liaper',
      child: SizedBox.square(
        dimension: size,
        child: const CustomPaint(painter: _LiaperLogoPainter()),
      ),
    );
  }
}

class _LiaperLogoPainter extends CustomPainter {
  const _LiaperLogoPainter();

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 64, size.height / 64);

    const r = Radius.circular(10);
    final bubble = Path()
      ..moveTo(14, 8)
      ..lineTo(50, 8)
      ..arcToPoint(const Offset(60, 18), radius: r)
      ..lineTo(60, 42)
      ..arcToPoint(const Offset(50, 52), radius: r)
      ..lineTo(26, 52)
      ..lineTo(14, 60)
      ..lineTo(14, 52)
      ..arcToPoint(const Offset(4, 42), radius: r)
      ..lineTo(4, 18)
      ..arcToPoint(const Offset(14, 8), radius: r)
      ..close();
    canvas.drawPath(
      bubble,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF6366F1), Color(0xFF7C3AED)],
        ).createShader(const Rect.fromLTWH(0, 0, 64, 64)),
    );

    final letter = Path()
      ..moveTo(24, 18)
      ..lineTo(24, 35)
      ..arcToPoint(const Offset(29, 40),
          radius: const Radius.circular(5), clockwise: false)
      ..lineTo(42, 40);
    canvas.drawPath(
      letter,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 7.5
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );

    final spark = Path()
      ..moveTo(45, 15)
      ..cubicTo(45.8, 18.6, 46.9, 19.7, 50.5, 20.5)
      ..cubicTo(46.9, 21.3, 45.8, 22.4, 45, 26)
      ..cubicTo(44.2, 22.4, 43.1, 21.3, 39.5, 20.5)
      ..cubicTo(43.1, 19.7, 44.2, 18.6, 45, 15)
      ..close();
    canvas.drawPath(spark, Paint()..color = const Color(0xFFFDE68A));
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
