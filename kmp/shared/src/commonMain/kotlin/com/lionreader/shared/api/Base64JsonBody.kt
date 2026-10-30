package com.lionreader.shared.api

import io.ktor.http.ContentType
import io.ktor.http.content.OutgoingContent
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.writeFully
import kotlin.io.encoding.Base64
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** Bytes encoded per piece: a multiple of 3, so the pieces' Base64 joins up without padding. */
internal const val PIECE_BYTES = 48 * 1024

/**
 * [request] as JSON with its `content` field set to [bytes] in Base64, written a piece at a time.
 * Building it as strings would hold the file several times over (as Base64 and as JSON, in UTF-16
 * and then UTF-8): over 150 MB for an ebook at the server's limit.
 */
internal fun <B> base64JsonBody(
    bytes: ByteArray,
    request: B,
    serializer: KSerializer<B>,
): OutgoingContent {
    val fields: JsonObject = ApiJson.encodeToJsonElement(serializer, request).jsonObject
    val head = "{\"content\":\"".encodeToByteArray()
    val tail =
        fields
            .filterKeys { it != "content" }
            .entries
            .joinToString("", prefix = "\"", postfix = "}") { (key, value) ->
                ",${JsonPrimitive(key)}:$value"
            }
            .encodeToByteArray()
    val encodedLength = (bytes.size + 2) / 3 * 4L
    return object : OutgoingContent.WriteChannelContent() {
        override val contentType = ContentType.Application.Json
        override val contentLength = head.size + encodedLength + tail.size

        override suspend fun writeTo(channel: ByteWriteChannel) {
            channel.writeFully(head)
            for (start in bytes.indices step PIECE_BYTES) {
                val end = minOf(start + PIECE_BYTES, bytes.size)
                channel.writeFully(Base64.encodeToByteArray(bytes, start, end))
            }
            channel.writeFully(tail)
        }
    }
}
