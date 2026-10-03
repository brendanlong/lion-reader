package com.lionreader.shared.account

/** A server address as typed: the URL to use, or what's wrong with it. */
sealed interface ServerUrlInput {
    data class Valid(val url: String) : ServerUrlInput

    data class Invalid(val message: String) : ServerUrlInput
}

/**
 * Checks a typed server address: https (or http where [allowHttp], i.e. debug builds, for dev
 * servers on http://localhost), a host, and at most a port; https:// is assumed when there's no
 * scheme. The URL is part of the account's identity (its database name), so it comes back in one
 * form: `scheme://host[:port]`, lowercase, without a default port, and a non-ASCII host in its
 * ASCII (punycode) form. That's punycode of the host as typed, without IDNA's mapping: unlike a
 * browser, `straße`, full-width letters and decomposed accents aren't folded first, so such a host
 * signs in only as the server's certificate names it.
 */
fun parseServerUrl(input: String, allowHttp: Boolean): ServerUrlInput {
    val text = input.trim()
    if (text.isEmpty()) return ServerUrlInput.Invalid("Enter your server's address.")
    val url = if ("://" in text) text else "https://$text"
    val scheme = url.substringBefore("://").lowercase()
    val rest = url.substringAfter("://")
    val authorityEnd = rest.indexOfAny(charArrayOf('/', '?', '#')).takeIf { it >= 0 } ?: rest.length
    val authority = rest.substring(0, authorityEnd)
    val after = rest.substring(authorityEnd)
    // An IPv6 literal ([::1]) has colons of its own.
    val hostEnd =
        if (authority.startsWith('[')) authority.indexOf(']') + 1
        else authority.indexOf(':').takeIf { it >= 0 } ?: authority.length
    val host = authority.substring(0, hostEnd).lowercase().let(::asciiHost)
    val afterHost = authority.substring(hostEnd)
    val port = afterHost.removePrefix(":")
    return when {
        scheme == "http" && !allowHttp ->
            ServerUrlInput.Invalid("Use an https:// address: signing in over http isn't safe.")
        scheme != "https" && scheme != "http" -> ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        host == null ||
            !(HOST.matches(host) || IPV6.matches(host)) ||
            (afterHost.isNotEmpty() && !afterHost.startsWith(':')) ->
            ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        port.isNotEmpty() && (port.any { it !in '0'..'9' } || port.toIntOrNull() !in 1..65535) ->
            ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        // A path, query, fragment or user name: not just the server.
        after.trimEnd('/').isNotEmpty() || '@' in authority ->
            ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        else -> {
            val defaultPort = if (scheme == "https") 443 else 80
            val shownPort = port.toIntOrNull()?.takeIf { it != defaultPort }?.let { ":$it" } ?: ""
            ServerUrlInput.Valid("$scheme://$host$shownPort")
        }
    }
}

/**
 * A DNS name or an IPv4 address: labels of up to 63 letters, digits and inner hyphens, and the
 * root's trailing dot if it was typed.
 */
private val HOST =
    Regex("""[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?""")

private val IPV6 = Regex("""\[[0-9a-f:.]+]""")

/** [host] (lowercase) with each non-ASCII label in punycode; null if one can't be encoded. */
private fun asciiHost(host: String): String? =
    host
        .split('.')
        // Not a DNS name's dots, ASCII ones: those of the Japanese and Chinese full-width forms
        // count too, as in Java's IDN.
        .flatMap { it.split('。', '．', '｡') }
        .map { label ->
            if (label.all { it.code < 128 }) label else "xn--" + (punycode(label) ?: return null)
        }
        .joinToString(".")

private const val NOT_AN_ADDRESS = "Enter just the server's address, like https://lionreader.com."
