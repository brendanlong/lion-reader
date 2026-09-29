package com.lionreader.shared.api

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

val ApiJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    classDiscriminator = "type"
}

/** Null for event types this app doesn't know (the server is newer than the app). */
fun parseSyncEvent(event: JsonObject): SyncEvent? =
    try {
        ApiJson.decodeFromJsonElement(SyncEvent.serializer(), event)
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
