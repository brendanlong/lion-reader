package com.lionreader.shared.auth

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Security.SecRandomCopyBytes
import platform.Security.errSecSuccess
import platform.Security.kSecRandomDefault

@OptIn(ExperimentalForeignApi::class)
internal actual fun secureRandomBytes(size: Int): ByteArray {
    val bytes = ByteArray(size)
    if (size == 0) return bytes
    val status = bytes.usePinned {
        SecRandomCopyBytes(kSecRandomDefault, size.toULong(), it.addressOf(0))
    }
    check(status == errSecSuccess) { "SecRandomCopyBytes failed: $status" }
    return bytes
}
