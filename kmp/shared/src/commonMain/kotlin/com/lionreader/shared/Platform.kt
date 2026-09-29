package com.lionreader.shared

internal expect fun platformName(): String

fun greeting(): String = "Lion Reader on ${platformName()}"
