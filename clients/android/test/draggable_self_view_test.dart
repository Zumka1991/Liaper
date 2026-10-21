import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/widgets/draggable_self_view.dart';

void main() {
  Future<void> showPreview(WidgetTester tester, Size size,
      {bool visible = true}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: DraggableSelfView(
      visible: visible,
      child: const ColoredBox(
          key: ValueKey('preview-content'), color: Colors.black),
    ))));
    await tester.pump();
  }

  setUp(() {});
  testWidgets('Preview can be dragged and stays clear of call controls',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await showPreview(tester, const Size(390, 844));
    final tile = find.byKey(const ValueKey('self-video-drag-target'));
    final original = tester.getRect(tile);
    await tester.drag(tile, const Offset(-160, -200));
    await tester.pump();
    expect(tester.getRect(tile).left, lessThan(original.left));
    expect(tester.getRect(tile).top, lessThan(original.top));
    await tester.drag(tile, const Offset(-1000, -1000));
    await tester.pump();
    expect(tester.getRect(tile).left, greaterThanOrEqualTo(12));
    expect(tester.getRect(tile).top, greaterThanOrEqualTo(88));
    await tester.drag(tile, const Offset(2000, 2000));
    await tester.pump();
    expect(tester.getRect(tile).right, lessThanOrEqualTo(378));
    expect(tester.getRect(tile).bottom, lessThanOrEqualTo(728));
  });

  testWidgets('Rotation and camera toggles keep a usable preview position',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await showPreview(tester, const Size(390, 844));
    final tile = find.byKey(const ValueKey('self-video-drag-target'));
    await tester.drag(tile, const Offset(-1000, -1000));
    await tester.pump();
    await showPreview(tester, const Size(844, 390));
    expect(tester.getRect(tile).left, 12);
    expect(tester.getRect(tile).top, 88);
    expect(tester.getRect(tile).bottom, lessThanOrEqualTo(274));
    await showPreview(tester, const Size(844, 390), visible: false);
    expect(tile, findsNothing);
    await showPreview(tester, const Size(844, 390));
    expect(tester.getRect(tile).topLeft, const Offset(12, 88));
    expect(tester.takeException(), isNull);
  });
}
