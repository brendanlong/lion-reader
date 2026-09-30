package com.lionreader.shared.auth

/** Cryptographically secure random bytes (PKCE verifier, OAuth state). */
internal expect fun secureRandomBytes(size: Int): ByteArray
