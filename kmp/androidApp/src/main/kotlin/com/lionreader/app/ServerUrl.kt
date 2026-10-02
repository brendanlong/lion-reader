package com.lionreader.app

import java.net.URI
import java.net.URISyntaxException

/** A server address as typed: the URL to use, or what's wrong with it. */
sealed interface ServerUrlInput {
    data class Valid(val url: String) : ServerUrlInput

    data class Invalid(val message: String) : ServerUrlInput
}

/**
 * Checks a typed server address: https (or http where [allowHttp], i.e. debug builds, for dev
 * servers on http://localhost), a host, and at most a port; https:// is assumed when there's no
 * scheme. The URL is part of the account's identity (its database name), so it comes back in one
 * form: `scheme://host[:port]`, lowercase, without a default port.
 */
fun parseServerUrl(input: String, allowHttp: Boolean): ServerUrlInput {
    val text = input.trim()
    if (text.isEmpty()) return ServerUrlInput.Invalid("Enter your server's address.")
    val uri =
        try {
            URI(if ("://" in text) text else "https://$text")
        } catch (_: URISyntaxException) {
            return ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    return when {
        scheme == "http" && !allowHttp ->
            ServerUrlInput.Invalid("Use an https:// address: signing in over http isn't safe.")
        scheme != "https" && scheme != "http" -> ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        host.isNullOrEmpty() -> ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        uri.rawUserInfo != null ||
            uri.rawPath.orEmpty().trimEnd('/').isNotEmpty() ||
            uri.rawQuery != null ||
            uri.rawFragment != null -> ServerUrlInput.Invalid(NOT_AN_ADDRESS)
        else -> {
            val defaultPort = if (scheme == "https") 443 else 80
            val port = uri.port.takeIf { it != -1 && it != defaultPort }?.let { ":$it" } ?: ""
            ServerUrlInput.Valid("$scheme://$host$port")
        }
    }
}

private const val NOT_AN_ADDRESS = "Enter just the server's address, like https://lionreader.com."
