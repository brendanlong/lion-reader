package com.lionreader.app.narration

import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.nio.file.Files
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class CloudVoicesTest {
    private val audio = byteArrayOf(1, 2, 3)
    private var responses = ArrayDeque<Pair<HttpStatusCode, String>>()
    private var requests = 0
    private val cache = Files.createTempDirectory("cloud").toFile()
    private val dir = Files.createTempDirectory("narration").toFile()

    private val ok =
        HttpStatusCode.OK to
            """{"audio":"${Base64.getEncoder().encodeToString(audio)}","mimeType":"audio/mpeg"}"""

    private fun TestScope.engine(): CloudVoices {
        val http =
            HttpClient(
                MockEngine {
                    requests++
                    val (status, body) = responses.removeFirstOrNull() ?: ok
                    respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
                }
            )
        val tokens =
            object : TokenStore {
                override fun load() = StoredTokens("access", "refresh", Long.MAX_VALUE)

                override fun save(tokens: StoredTokens?) {}
            }
        return CloudVoices(
            LionReaderApi(http, AppAuth("https://lion.test", http, tokens) { 0L }),
            "openrouter:hexgrad/kokoro-82m",
            "af_heart",
            cache,
            // Like the app's scope: a failed request fails only its caller.
            CoroutineScope(
                backgroundScope.coroutineContext +
                    SupervisorJob(backgroundScope.coroutineContext.job)
            ),
            // Retries wait on the test's clock.
            io = StandardTestDispatcher(testScheduler),
            cacheBytes = 5,
        )
    }

    @Test
    fun speechIsCachedByText() = runTest {
        val engine = engine()
        val first = engine.synthesize("Hello.", dir, "0")
        assertArrayEquals(audio, first.readBytes())
        assertEquals(first, engine.synthesize("Hello.", dir, "1"))
        assertEquals(1, requests)
        // Outside the narrator's directory, which it clears.
        assertEquals(cache, first.parentFile)
    }

    @Test
    fun serverTroubleIsRetried() = runTest {
        responses.addLast(HttpStatusCode.ServiceUnavailable to "{}")
        responses.addLast(HttpStatusCode.TooManyRequests to "{}")
        assertArrayEquals(audio, engine().synthesize("Hello.", dir, "0").readBytes())
        assertEquals(3, requests)
    }

    @Test
    fun aRejectionStopsNarrationWithTheServersReason() = runTest {
        responses.addLast(
            HttpStatusCode.BadRequest to
                """{"message":"Cloud voices require an OpenRouter API key"}"""
        )
        val error = runCatching { engine().synthesize("Hello.", dir, "0") }.exceptionOrNull()
        assertEquals(SpeechUnavailable::class, error!!::class)
        assertEquals("Cloud voices require an OpenRouter API key", error.message)
    }

    @Test
    fun persistentTroubleEventuallyStops() = runTest {
        repeat(10) { responses.addLast(HttpStatusCode.BadGateway to "{}") }
        val error = runCatching { engine().synthesize("Hello.", dir, "0") }.exceptionOrNull()
        assertEquals(SpeechUnavailable::class, error!!::class)
    }

    @Test
    fun theSameTextTwiceAtOnceIsOneRequest() = runTest {
        val engine = engine()
        val (a, b) =
            listOf(
                    async { engine.synthesize("Again.", dir, "0") },
                    async { engine.synthesize("Again.", dir, "1") },
                )
                .awaitAll()
        assertEquals(a, b)
        assertEquals(1, requests)
    }

    @Test
    fun aRequestTheNarratorGaveUpOnStillLandsInTheCache() = runTest {
        val engine = engine()
        val waiting = launch { engine.synthesize("Skipped.", dir, "0") }
        testScheduler.runCurrent()
        waiting.cancel()
        testScheduler.advanceUntilIdle()
        engine.synthesize("Skipped.", dir, "1")
        assertEquals(1, requests)
    }

    @Test
    fun theCacheIsTrimmedOldestFirst() = runTest {
        // Three bytes each, against a five-byte cache.
        val engine = engine()
        val first = engine.synthesize("One.", dir, "0")
        first.setLastModified(1_000)
        val second = engine.synthesize("Two.", dir, "1")
        assertEquals(false, first.exists())
        assertEquals(true, second.exists())
    }
}
