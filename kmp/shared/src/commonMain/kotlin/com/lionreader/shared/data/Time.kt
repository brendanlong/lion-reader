package com.lionreader.shared.data

import kotlin.time.Instant

internal fun parseMillis(iso: String): Long = Instant.parse(iso).toEpochMilliseconds()

internal fun formatMillis(millis: Long): String = Instant.fromEpochMilliseconds(millis).toString()
