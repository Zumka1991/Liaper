import 'dart:convert';
import 'dart:isolate';

import 'package:crypto/crypto.dart';

/// Proof-of-work для регистрации: подбирает число, при котором
/// SHA-256(`задача:число`) начинается с [difficulty] нулевых бит.
class PowSolver {
  static int leadingZeroBits(List<int> hash) {
    var bits = 0;
    for (final byte in hash) {
      if (byte == 0) {
        bits += 8;
        continue;
      }
      var b = byte;
      while (b & 0x80 == 0) {
        bits++;
        b <<= 1;
      }
      break;
    }
    return bits;
  }

  static String solveSync(String challenge, int difficulty) {
    final prefix = '$challenge:';
    for (var n = 0;; n++) {
      final digest = sha256.convert(utf8.encode('$prefix$n')).bytes;
      if (leadingZeroBits(digest) >= difficulty) return '$n';
    }
  }

  /// Решает в отдельном изоляте, чтобы интерфейс не подвисал.
  static Future<String> solve(String challenge, int difficulty) =>
      Isolate.run(() => solveSync(challenge, difficulty));
}
