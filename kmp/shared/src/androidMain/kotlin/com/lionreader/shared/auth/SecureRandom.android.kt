package com.lionreader.shared.auth

import java.security.SecureRandom

private val random = SecureRandom()

internal actual fun secureRandomBytes(size: Int): ByteArray =
    ByteArray(size).also(random::nextBytes)
