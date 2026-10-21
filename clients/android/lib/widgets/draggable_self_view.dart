import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

/// Keeps the preview inside the usable call area, including after rotation.
class DraggableSelfView extends StatefulWidget {
  const DraggableSelfView({
    super.key,
    required this.child,
    this.visible = true,
    this.reservedInsets = const EdgeInsets.fromLTRB(12, 88, 12, 116),
  });

  final Widget child;
  final bool visible;
  final EdgeInsets reservedInsets;

  @override
  State<DraggableSelfView> createState() => _DraggableSelfViewState();
}

class _DraggableSelfViewState extends State<DraggableSelfView> {
  Offset _fraction = const Offset(1, 1);

  @override
  Widget build(BuildContext context) {
    if (!widget.visible) return const SizedBox.shrink();
    return LayoutBuilder(builder: (context, constraints) {
      final availableWidth = math.max(
          0.0, constraints.maxWidth - widget.reservedInsets.horizontal);
      final availableHeight =
          math.max(0.0, constraints.maxHeight - widget.reservedInsets.vertical);
      final scale =
          math.min(1.0, math.min(availableWidth / 108, availableHeight / 152));
      if (scale <= 0) return const SizedBox.shrink();
      final width = 108 * scale;
      final height = 152 * scale;
      final travelX = availableWidth - width;
      final travelY = availableHeight - height;
      final left = widget.reservedInsets.left + travelX * _fraction.dx;
      final top = widget.reservedInsets.top + travelY * _fraction.dy;
      return Stack(children: [
        Positioned(
          left: left,
          top: top,
          width: width,
          height: height,
          child: Semantics(
            label: 'Ваше видео. Перетащите, чтобы переместить',
            customSemanticsActions: {
              const CustomSemanticsAction(label: 'Переместить влево'): () =>
                  setState(() => _fraction = Offset(0, _fraction.dy)),
              const CustomSemanticsAction(label: 'Переместить вправо'): () =>
                  setState(() => _fraction = Offset(1, _fraction.dy)),
              const CustomSemanticsAction(label: 'Переместить вверх'): () =>
                  setState(() => _fraction = Offset(_fraction.dx, 0)),
              const CustomSemanticsAction(label: 'Переместить вниз'): () =>
                  setState(() => _fraction = Offset(_fraction.dx, 1)),
            },
            child: GestureDetector(
              key: const ValueKey('self-video-drag-target'),
              behavior: HitTestBehavior.opaque,
              onPanUpdate: (details) => setState(() {
                _fraction = Offset(
                  travelX <= 0
                      ? _fraction.dx
                      : (_fraction.dx + details.delta.dx / travelX).clamp(0, 1),
                  travelY <= 0
                      ? _fraction.dy
                      : (_fraction.dy + details.delta.dy / travelY).clamp(0, 1),
                );
              }),
              child: widget.child,
            ),
          ),
        ),
      ]);
    });
  }
}
