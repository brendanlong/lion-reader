package com.lionreader.shared.api

import com.lionreader.shared.auth.AppAuth
import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.parameter
import io.ktor.client.request.prepareRequest
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.readLine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/** Longest a chunk of cloud speech may take to arrive; a slow provider's long chunk is ~20s. */
private const val SPEECH_TIMEOUT_MILLIS = 180_000L

/** Longest the speech stream may go quiet, before the first audio or between parts. */
private const val SPEECH_STALL_MILLIS = 60_000L

/** The server's limit on ids per `/entries/batch` request. */
private const val MAX_BATCH_IDS = 100

/**
 * A non-2xx response, or no response at all when [signedOut]. [serverMessage] is the server's own
 * explanation, when it sent one, fit to show the user; [appErrorCode] its machine-readable reason,
 * for the errors that have one (e.g. `NEEDS_GOOGLE_SIGNIN`).
 */
class ApiException(
    val status: Int,
    message: String,
    val serverMessage: String? = null,
    val appErrorCode: String? = null,
) : Exception(message) {
    /**
     * The server rejected the request itself; retrying it unchanged won't help. A coded 4xx is such
     * an answer (e.g. `NEEDS_GOOGLE_SIGNIN`), except 429, which is "try again later".
     */
    val isPermanent: Boolean
        get() =
            status == 400 ||
                status == 404 ||
                status == 422 ||
                (appErrorCode != null && status in 400..499 && status != 429)

    /** There's no signed-in account to send the request as; it was never sent. */
    val signedOut: Boolean
        get() = status == 0
}

enum class ListFilter {
    ALL,
    STARRED,
    SAVED,
}

/** The `/api/v1` endpoints the app uses, authenticated with [AppAuth]. */
class LionReaderApi(private val http: HttpClient, private val auth: AppAuth) {
    private val base = "${auth.serverUrl}/api/v1"

    suspend fun listEntries(
        filter: ListFilter,
        cursor: String?,
        subscriptionId: String? = null,
        limit: Int = 100,
    ): EntryListPage =
        get(EntryListPage.serializer(), "/entries") {
            when (filter) {
                ListFilter.ALL -> {}
                ListFilter.STARRED -> parameter("starredOnly", true)
                ListFilter.SAVED -> parameter("type", "saved")
            }
            subscriptionId?.let { parameter("subscriptionId", it) }
            parameter("limit", limit)
            cursor?.let { parameter("cursor", it) }
        }

    /** The server's Recently Read: entries whose read state changed, latest first. */
    suspend fun listRecentlyRead(cursor: String?, limit: Int = 100): EntryListPage =
        get(EntryListPage.serializer(), "/entries") {
            parameter("sortBy", "readChanged")
            parameter("limit", limit)
            cursor?.let { parameter("cursor", it) }
        }

    /** In as many requests as the server's limit on ids per request needs. */
    suspend fun getEntries(ids: List<String>): List<FullEntry> =
        ids.chunked(MAX_BATCH_IDS).flatMap {
            post(
                    GetManyResponse.serializer(),
                    "/entries/batch",
                    GetManyRequest(it),
                    GetManyRequest.serializer(),
                )
                .entries
        }

    suspend fun markRead(request: MarkReadRequest): BulkStateResponse =
        post(
            BulkStateResponse.serializer(),
            "/entries/mark-read",
            request,
            MarkReadRequest.serializer(),
        )

    suspend fun setStarred(request: SetStarredRequest): BulkStateResponse =
        post(
            BulkStateResponse.serializer(),
            "/entries/starred",
            request,
            SetStarredRequest.serializer(),
        )

    suspend fun listSubscriptions(cursor: String?): SubscriptionPage =
        get(SubscriptionPage.serializer(), "/subscriptions") {
            parameter("limit", 100)
            cursor?.let { parameter("cursor", it) }
        }

    suspend fun listTags(): TagList = get(TagList.serializer(), "/tags") {}

    /** The account this token belongs to. */
    suspend fun me(): AccountUser = get(Me.serializer(), "/auth/me") {}.user

    /** The cloud voices this user can use (none without a speech provider key on either side). */
    suspend fun voiceModels(): VoiceModels =
        get(VoiceModels.serializer(), "/narration/voice-models") {}

    /**
     * Speaks [text] (at most [MAX_CLOUD_SPEECH_CHARS]) with a cloud voice, handing [onAudio] the
     * audio (AAC in fragmented MP4) as the server streams it. Throws [ApiException] for an error
     * answer; a failure once audio has started throws from reading it.
     */
    suspend fun streamSpeech(
        model: String,
        voice: String,
        text: String,
        pauseSeconds: Float,
        onAudio: suspend (ByteArray) -> Unit,
    ) = withToken { token, canRetry ->
        http
            .prepareRequest {
                method = HttpMethod.Post
                url("$base/narration/speech")
                contentType(ContentType.Application.Json)
                setBody(
                    ApiJson.encodeToString(
                        SpeechRequest.serializer(),
                        SpeechRequest(model, voice, text, pauseSeconds),
                    )
                )
                bearerAuth(token)
                timeout {
                    requestTimeoutMillis = SPEECH_TIMEOUT_MILLIS
                    socketTimeoutMillis = SPEECH_STALL_MILLIS
                }
            }
            .execute { response ->
                checkAnswer(response, canRetry)
                // A captive portal's page, say.
                if (response.contentType()?.match(ContentType.Audio.MP4) != true) {
                    throw ApiException(response.status.value, "Not audio")
                }
                val body = response.bodyAsChannel()
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val read = body.readAvailable(buffer, 0, buffer.size)
                    if (read < 0) break
                    if (read > 0) onAudio(buffer.copyOf(read))
                }
            }
    }

    /** Saves a link as a saved article (the server fetches it). */
    suspend fun saveArticle(url: String): SavedArticle =
        post(
                SaveArticleResponse.serializer(),
                "/saved",
                SaveArticleRequest(url),
                SaveArticleRequest.serializer(),
            )
            .article

    suspend fun summarizationAvailable(): Boolean =
        get(SummarizationAvailability.serializer(), "/summarization/available") {}.available

    /** The entry's summary as sanitized HTML, generated with the user's summary settings. */
    suspend fun summarize(entryId: String): String =
        post(
                GeneratedSummary.serializer(),
                "/summarization/generate",
                GenerateSummaryRequest(entryId),
                GenerateSummaryRequest.serializer(),
            )
            .summary

    /**
     * Changes since [cursors]. [since] holds the cursors the catch-up they're a page of started
     * from, which the server classifies entry changes against (`entriesSince`).
     */
    suspend fun syncChanges(cursors: SyncCursors?, since: SyncCursors? = null): SyncChanges =
        get(SyncChanges.serializer(), "/sync/changes") {
            cursors?.let {
                it.entries?.let { v -> parameter("entries", v) }
                it.entriesAfterId?.let { v -> parameter("entriesAfterId", v) }
                it.subscriptions?.let { v -> parameter("subscriptions", v) }
                it.tags?.let { v -> parameter("tags", v) }
                it.deletions?.let { v -> parameter("deletions", v) }
            }
            since?.let {
                it.entries?.let { v -> parameter("entriesSince", v) }
                it.entriesAfterId?.let { v -> parameter("entriesSinceAfterId", v) }
            }
        }

    /**
     * Listens to the server's live updates (`/api/v1/events`, server-sent events) until the server
     * closes the stream: [onOpen] once connected, then [onEvent] with each event's type. Throws on
     * network/server failure; reconnecting is the caller's.
     */
    suspend fun events(onOpen: suspend () -> Unit, onEvent: suspend (String) -> Unit) =
        withToken { token, canRetry ->
            http
                .prepareRequest {
                    url("$base/events")
                    bearerAuth(token)
                    timeout {
                        requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                        // The server sends a heartbeat every 30s.
                        socketTimeoutMillis = 75_000
                    }
                }
                .execute { response ->
                    checkAnswer(response, canRetry)
                    // A captive portal's page, say.
                    if (response.contentType()?.match(ContentType.Text.EventStream) != true) {
                        throw ApiException(response.status.value, "Not an event stream")
                    }
                    onOpen()
                    val body = response.bodyAsChannel()
                    while (true) {
                        val line = body.readLine() ?: break
                        if (line.startsWith("event:")) onEvent(line.removePrefix("event:").trim())
                    }
                }
        }

    private suspend fun <T> get(
        serializer: KSerializer<T>,
        path: String,
        block: HttpRequestBuilder.() -> Unit,
    ): T =
        call(serializer) {
            method = HttpMethod.Get
            url("$base$path")
            block()
        }

    private suspend fun <T, B> post(
        serializer: KSerializer<T>,
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
    ): T =
        call(serializer) {
            method = HttpMethod.Post
            url("$base$path")
            contentType(ContentType.Application.Json)
            setBody(ApiJson.encodeToString(bodySerializer, body))
        }

    private suspend fun <T> call(
        serializer: KSerializer<T>,
        block: HttpRequestBuilder.() -> Unit,
    ): T = withToken { token, canRetry ->
        val response = http.request {
            block()
            bearerAuth(token)
        }
        checkAnswer(response, canRetry)
        ApiJson.decodeFromString(serializer, response.bodyAsText())
    }

    /**
     * Runs [request] with a Bearer token, and once more with a refreshed one if [check] finds the
     * server rejected the token.
     */
    private suspend fun <T> withToken(request: suspend (token: String, canRetry: Boolean) -> T): T {
        val token = auth.accessToken() ?: throw signedOut()
        try {
            return request(token, true)
        } catch (_: TokenRejected) {}
        val fresh = auth.accessToken(forceRefresh = true, rejected = token) ?: throw signedOut()
        return request(fresh, false)
    }

    private fun signedOut() = ApiException(0, "Signed out")

    /** A 401 about the token itself, while a retry with a fresh one is left. */
    private class TokenRejected : Exception()

    /**
     * Throws for an error response: [TokenRejected] for a 401 about the token if [canRetry], else
     * [ApiException]. A 401 with an app error code is about something else (e.g. the user's Google
     * account for a private Doc), not the token.
     */
    private suspend fun checkAnswer(response: HttpResponse, canRetry: Boolean) {
        if (response.status.isSuccess()) return
        // Read once: a streamed response's body can't be read again.
        val text = response.bodyAsText()
        val error = errorBody(text)
        if (
            canRetry && response.status == HttpStatusCode.Unauthorized && error.appErrorCode == null
        ) {
            throw TokenRejected()
        }
        throw ApiException(
            response.status.value,
            "HTTP ${response.status.value}: ${text.take(200)}",
            error.message,
            error.appErrorCode,
        )
    }

    private class ErrorBody(val message: String?, val appErrorCode: String?)

    /** What an error response says about itself (its tRPC error shape), if it's JSON. */
    private fun errorBody(text: String): ErrorBody {
        val json =
            runCatching { ApiJson.parseToJsonElement(text).jsonObject }.getOrNull()
                ?: return ErrorBody(null, null)
        fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
        return ErrorBody(
            json.string("message"),
            (json["data"] as? JsonObject)?.string("appErrorCode"),
        )
    }
}
