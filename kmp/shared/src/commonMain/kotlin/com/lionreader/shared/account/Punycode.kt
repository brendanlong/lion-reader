package com.lionreader.shared.account

private const val BASE = 36
private const val T_MIN = 1
private const val T_MAX = 26
private const val SKEW = 38
private const val DAMP = 700
private const val INITIAL_BIAS = 72
private const val INITIAL_N = 128

/**
 * [label] in punycode (RFC 3492), without the `xn--` prefix; null if it's too long to encode. No
 * nameprep beyond what the caller did (lowercasing): enough for a host as people type it.
 */
internal fun punycode(label: String): String? {
    val codePoints = codePoints(label)
    val output = StringBuilder()
    codePoints.filter { it < INITIAL_N }.forEach { output.append(it.toChar()) }
    val basicCount = output.length
    var handled = basicCount
    if (basicCount > 0) output.append('-')
    var n = INITIAL_N
    var delta = 0L
    var bias = INITIAL_BIAS
    while (handled < codePoints.size) {
        val next = codePoints.filter { it >= n }.min()
        delta += (next - n).toLong() * (handled + 1)
        n = next
        for (c in codePoints) {
            if (c < n) delta++
            if (delta > Int.MAX_VALUE) return null
            if (c != n) continue
            var q = delta.toInt()
            var k = BASE
            while (true) {
                val t = (k - bias).coerceIn(T_MIN, T_MAX)
                if (q < t) break
                output.append(digit(t + (q - t) % (BASE - t)))
                q = (q - t) / (BASE - t)
                k += BASE
            }
            output.append(digit(q))
            bias = adapt(delta.toInt(), handled + 1, handled == basicCount)
            delta = 0
            handled++
        }
        delta++
        n++
    }
    return output.toString()
}

private fun adapt(delta: Int, points: Int, first: Boolean): Int {
    var d = if (first) delta / DAMP else delta / 2
    d += d / points
    var k = 0
    while (d > ((BASE - T_MIN) * T_MAX) / 2) {
        d /= BASE - T_MIN
        k += BASE
    }
    return k + (BASE - T_MIN + 1) * d / (d + SKEW)
}

private fun digit(d: Int): Char = if (d < 26) 'a' + d else '0' + (d - 26)

private fun codePoints(text: String): List<Int> {
    val points = mutableListOf<Int>()
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) {
            points += 0x10000 + ((c.code - 0xD800) shl 10) + (text[i + 1].code - 0xDC00)
            i += 2
        } else {
            points += c.code
            i++
        }
    }
    return points
}
