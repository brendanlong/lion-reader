package com.lionreader.shared.api

import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

val ApiJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    classDiscriminator = "type"
}

/** The `type`s [SyncEvent] has a subclass for (a sealed serializer's second element). */
private val knownEventTypes: Set<String> =
    SyncEvent.serializer().descriptor.getElementDescriptor(1).elementNames.toSet()

/**
 * Null for event types this app doesn't know (the server is newer than the app). A known type that
 * doesn't decode throws: skipping it would lose the change, as the cursor moves past it.
 */
fun parseSyncEvent(event: JsonObject): SyncEvent? {
    val type = (event["type"] as? JsonPrimitive)?.contentOrNull
    if (type !in knownEventTypes) return null
    return ApiJson.decodeFromJsonElement(SyncEvent.serializer(), event)
}
