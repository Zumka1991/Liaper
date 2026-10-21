import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/main.dart';

void main() {
  testWidgets('LiaperAndroidApp smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const LiaperAndroidApp());
    expect(find.text('Liaper Mobile'), findsOneWidget);
  });
}
