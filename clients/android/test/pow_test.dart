import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/services/pow.dart';

void main() {
  test('leadingZeroBits считает нулевые биты', () {
    expect(PowSolver.leadingZeroBits([0, 0, 0x10, 0xff]), 19);
    expect(PowSolver.leadingZeroBits([0x80]), 0);
    expect(PowSolver.leadingZeroBits([0x01]), 7);
  });

  test('решение proof-of-work проходит проверку', () {
    const challenge = 'v1.0123456789abcdef0123456789abcdef.14.1700000000.abab';
    final solution = PowSolver.solveSync(challenge, 14);
    final digest = sha256.convert(utf8.encode('$challenge:$solution')).bytes;
    expect(PowSolver.leadingZeroBits(digest), greaterThanOrEqualTo(14));
  });
}
