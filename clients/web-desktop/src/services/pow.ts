// Proof-of-work для регистрации: подбираем число, при котором SHA-256(`задача:число`)
// начинается с `difficulty` нулевых бит. Синхронный SHA-256 быстрее WebCrypto для миллионов коротких хешей.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);
const H = new Uint32Array(8);

/** SHA-256 от ASCII-строки; возвращает первые два 32-битных слова хеша (больше для проверки не нужно). */
export function sha256Head(input: string, out: Uint32Array = new Uint32Array(2)): Uint32Array {
  const len = input.length;
  const blocks = ((len + 8) >> 6) + 1;
  const words = new Uint32Array(blocks * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= (input.charCodeAt(i) & 0xff) << (24 - (i & 3) * 8);
  words[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
  words[blocks * 16 - 1] = len * 8;
  H[0] = 0x6a09e667; H[1] = 0xbb67ae85; H[2] = 0x3c6ef372; H[3] = 0xa54ff53a;
  H[4] = 0x510e527f; H[5] = 0x9b05688c; H[6] = 0x1f83d9ab; H[7] = 0x5be0cd19;
  for (let b = 0; b < blocks; b++) {
    for (let t = 0; t < 16; t++) W[t] = words[b * 16 + t];
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15], w2 = W[t - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  out[0] = H[0]; out[1] = H[1];
  return out;
}

function hasLeadingZeroBits(head: Uint32Array, bits: number): boolean {
  if (bits <= 32) return bits === 0 || head[0] >>> (32 - bits) === 0;
  return head[0] === 0 && head[1] >>> (64 - bits) === 0;
}

/** Ищет решение среди чисел [start, start + limit). */
export function solvePowSync(challenge: string, difficulty: number, start = 0, limit = Infinity): string | null {
  const head = new Uint32Array(2);
  const prefix = `${challenge}:`;
  for (let n = start; n < start + limit; n++) {
    if (hasLeadingZeroBits(sha256Head(prefix + n, head), difficulty)) return String(n);
  }
  return null;
}

export type PowTask = { challenge: string; difficulty: number };

/** Решает задачу в Web Worker, а если он недоступен — короткими порциями в основном потоке. */
export async function solvePow(task: PowTask): Promise<string> {
  if (typeof Worker !== 'undefined') {
    try {
      return await new Promise<string>((resolve, reject) => {
        const worker = new Worker(new URL('./powWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<string>) => { worker.terminate(); resolve(e.data); };
        worker.onerror = (e) => { worker.terminate(); reject(e); };
        worker.postMessage(task);
      });
    } catch {
      // CSP или окружение без воркеров — решаем ниже
    }
  }
  const CHUNK = 20_000;
  for (let start = 0; ; start += CHUNK) {
    const found = solvePowSync(task.challenge, task.difficulty, start, CHUNK);
    if (found !== null) return found;
    await new Promise((r) => setTimeout(r, 0));
  }
}
