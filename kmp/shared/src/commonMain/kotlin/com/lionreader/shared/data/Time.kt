package com.lionreader.shared.data

import kotlin.time.Clock
import kotlin.time.Instant

internal fun parseMillis(iso: String): Long = Instant.parse(iso).toEpochMilliseconds()

internal fun formatMillis(millis: Long): String = Instant.fromEpochMilliseconds(millis).toString()

internal fun currentTimeMillis(): Long = Clock.System.now().toEpochMilliseconds()
