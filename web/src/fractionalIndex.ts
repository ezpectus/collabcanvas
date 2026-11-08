// TS port of Core/Model/FractionalIndex.cs — SAME algorithm must run
// on the client (it computes z for new objects) and on replicas.
// Invariant: keys never end in DIGITS[0]; ordinal compare = position.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const charAt = (s: string | null, i: number): string =>
  s !== null && i < s.length ? s[i]! : DIGITS[0]!

const tail = (s: string | null, n: number): string =>
  s === null || n >= s.length ? '' : s.slice(n)

const endsInZero = (s: string | null): boolean =>
  s !== null && s.length > 0 && s[s.length - 1] === DIGITS[0]

function between(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`)
  if (endsInZero(a) || endsInZero(b)) throw new Error('key ends in zero digit')

  if (b !== null) {
    let n = 0
    while (charAt(a, n) === charAt(b, n)) n++
    if (n > 0) return b.slice(0, n) + between(tail(a, n), tail(b, n))
  }

  const da = a !== null && a.length > 0 ? DIGITS.indexOf(a[0]!) : 0
  const db = b !== null && b.length > 0 ? DIGITS.indexOf(b[0]!) : DIGITS.length
  return db - da > 1
    ? DIGITS[Math.floor((da + db) / 2)]!
    : DIGITS[da]! + between(tail(a, 1), null)
}

export const FractionalIndex = {
  between,
  first: (): string => between(null, null),
  after: (last: string): string => between(last, null),
  before: (first: string): string => between(null, first),
}
