package com.lionreader.app.narration

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.cancel
import io.ktor.utils.io.writeFully
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class CloudVoicesTest {
    private val audio = byteArrayOf(1, 2, 3)

    /** An answer: speech, an error's status and JSON, or a stream the test writes itself. */
    private sealed interface Answer {
        class Speech(val audio: ByteArray) : Answer

        class Error(val status: HttpStatusCode, val json: String = "{}") : Answer

        class Stream(val channel: ByteChannel) : Answer
    }

    private var responses = ArrayDeque<Answer>()
    /** How to answer requests whose body has this text, ahead of [responses]. */
    private var forText: Map<String, suspend () -> Answer> = emptyMap()
    private var requests = 0
    private val bodies = mutableListOf<String>()
    private val cache = Files.createTempDirectory("cloud").toFile()
    private val dir = Files.createTempDirectory("narration").toFile()

    private val ok = Answer.Speech(audio)

    private fun TestScope.engine(
        cacheBytes: Long = 5,
        pauseSeconds: Float = 0.25f,
        shared: CloudSpeechRequests = CloudSpeechRequests(),
    ): CloudVoices {
        val http =
            HttpClient(
                MockEngine { request ->
                    requests++
                    val sent = (request.body as? TextContent)?.text.orEmpty()
                    bodies += sent
                    val answer =
                        forText.entries.firstOrNull { it.key in sent }?.value?.invoke()
                            ?: responses.removeFirstOrNull()
                            ?: ok
                    val mp4 = headersOf(HttpHeaders.ContentType, "audio/mp4")
                    when (answer) {
                        is Answer.Speech -> respond(answer.audio, HttpStatusCode.OK, mp4)
                        is Answer.Stream -> respond(answer.channel, HttpStatusCode.OK, mp4)
                        is Answer.Error ->
                            respond(
                                answer.json,
                                answer.status,
                                headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                    }
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
            pauseSeconds,
            cache,
            // Like the app's scope: a failed request fails only its caller.
            CoroutineScope(
                backgroundScope.coroutineContext +
                    SupervisorJob(backgroundScope.coroutineContext.job)
            ),
            shared,
            // Retries wait on the test's clock.
            io = StandardTestDispatcher(testScheduler),
            cacheBytes = cacheBytes,
        )
    }

    /** Longer than one network read, so it arrives in parts. */
    private val speech = ByteArray(5_000) { it.toByte() }

    /** Everything the player would read from [uri], once it's all arrived. */
    private suspend fun played(uri: Uri): ByteArray =
        withContext(Dispatchers.IO) {
            val source = NarrationDataSource()
            source.open(DataSpec(uri))
            try {
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val read = source.read(buffer, 0, buffer.size)
                    if (read == C.RESULT_END_OF_INPUT) break
                    out.write(buffer, 0, read)
                }
                out.toByteArray()
            } finally {
                source.close()
            }
        }

    private fun cached(): List<File> =
        cache.listFiles { file -> file.extension == "mp4" }!!.toList()

    @Test
    fun playbackStartsBeforeTheSpeechHasAllArrived() = runTest {
        val channel = ByteChannel(autoFlush = true)
        responses += Answer.Stream(channel)
        val engine = engine(cacheBytes = 1_000_000)

        val split = 2_000
        val writing = launch(Dispatchers.IO) { channel.writeFully(speech, 0, split) }
        val uri = engine.synthesize("Two sentences.", dir, "0")
        writing.join()
        // Answered with only the start in, and nothing cached yet.
        assertEquals(StreamedAudio.SCHEME, uri.scheme)
        assertEquals(emptyList<File>(), cached())

        launch(Dispatchers.IO) {
            channel.writeFully(speech, split, speech.size)
            channel.flushAndClose()
        }
        assertArrayEquals(speech, played(uri))
        assertArrayEquals(speech, cached().single().readBytes())
    }

    @Test
    fun speechThatStopsPartwayIsBrokenForThePlayerAndAskedForAfresh() = runTest {
        val channel = ByteChannel(autoFlush = true)
        responses += Answer.Stream(channel)
        val engine = engine(cacheBytes = 1_000_000)

        launch(Dispatchers.IO) { channel.writeFully(speech, 0, 2_000) }
        val broken = engine.synthesize("Two sentences.", dir, "0")
        channel.cancel(IOException("Connection reset"))
        val error = runCatching { played(broken) }.exceptionOrNull()
        assertEquals(SpeechStreamBroken::class, error!!::class)

        // Nothing half-written is kept, and the next try is a new request.
        responses += Answer.Speech(speech)
        assertArrayEquals(
            speech,
            played(engine.synthesize("Two sentences.", dir, "1")),
        )
        assertEquals(2, requests)
        assertEquals(1, cached().size)
    }

    @Test
    fun speechIsCachedByText() = runTest {
        val engine = engine()
        val first = engine.synthesize("Hello.", dir, "0")
        assertArrayEquals(audio, played(first))
        val again = engine.synthesize("Hello.", dir, "1")
        assertArrayEquals(audio, played(again))
        assertEquals(1, requests)
        // Outside the narrator's directory, which it clears.
        assertEquals(cache, File(again.path!!).parentFile)
    }

    @Test
    fun thePauseIsAskedForAndPartOfTheCacheKey() = runTest {
        played(engine(pauseSeconds = 0.5f).synthesize("Hello.", dir, "0"))
        assertTrue(""""pauseSeconds":0.5""" in bodies.single())
        played(engine(pauseSeconds = 0f).synthesize("Hello.", dir, "1"))
        assertEquals(2, requests)
    }

    @Test
    fun serverTroubleIsRetried() = runTest {
        responses.addLast(Answer.Error(HttpStatusCode.ServiceUnavailable))
        responses.addLast(Answer.Error(HttpStatusCode.TooManyRequests))
        assertArrayEquals(audio, played(engine().synthesize("Hello.", dir, "0")))
        assertEquals(3, requests)
    }

    @Test
    fun aRejectionStopsNarrationWithTheServersReason() = runTest {
        responses.addLast(
            Answer.Error(
                HttpStatusCode.BadRequest,
                """{"message":"Cloud voices require an API key from DeepInfra, OpenRouter, or BreezeBlue"}""",
            )
        )
        val error = runCatching { engine().synthesize("Hello.", dir, "0") }.exceptionOrNull()
        assertEquals(SpeechUnavailable::class, error!!::class)
        assertEquals(
            "Cloud voices require an API key from DeepInfra, OpenRouter, or BreezeBlue",
            error.message,
        )
    }

    @Test
    fun aProviderRefusingTheKeyStopsNarrationSayingSo() = runTest {
        responses.addLast(
            Answer.Error(
                HttpStatusCode.UnprocessableEntity,
                """{"message":"BreezeBlue refused the request: Insufficient credits"}""",
            )
        )
        val error = runCatching { engine().synthesize("Hello.", dir, "0") }.exceptionOrNull()
        assertEquals(SpeechUnavailable::class, error!!::class)
        assertEquals("BreezeBlue refused the request: Insufficient credits", error.message)
        assertEquals(1, requests)
    }

    @Test
    fun aTimeoutIsRetried() = runTest {
        responses.addLast(Answer.Error(HttpStatusCode.RequestTimeout))
        assertArrayEquals(audio, played(engine().synthesize("Hello.", dir, "0")))
        assertEquals(2, requests)
    }

    @Test
    fun theLimitOnRequestsAtOnceHoldsAcrossEngines() = runTest {
        // An engine per article: requests the narrator left behind run on beside the new ones.
        val shared = CloudSpeechRequests()
        val held = List(2) { ByteChannel(autoFlush = true) }
        responses.addAll(held.map { Answer.Stream(it) })
        val first = engine(cacheBytes = 1_000_000, shared = shared)
        val second = engine(cacheBytes = 1_000_000, shared = shared)
        // Each answers once its first audio is in; both streams stay open.
        withContext(Dispatchers.IO) { held.forEach { it.writeFully(speech, 0, 100) } }
        first.synthesize("One.", dir, "0")
        second.synthesize("Two.", dir, "1")

        val third = async { second.synthesize("Three.", dir, "2") }
        withContext(Dispatchers.IO) { delay(200) }
        assertEquals(2, requests)

        held[0].flushAndClose()
        assertArrayEquals(audio, played(third.await()))
        assertEquals(3, requests)
        held[1].flushAndClose()
    }

    @Test
    fun persistentTroubleIsAnInterruptionNotTheEnd() = runTest {
        repeat(10) { responses.addLast(Answer.Error(HttpStatusCode.BadGateway)) }
        val error = runCatching { engine().synthesize("Hello.", dir, "0") }.exceptionOrNull()
        assertEquals(SpeechInterrupted::class, error!!::class)
    }

    @Test
    fun textTheServerKeepsFailingWhileAnsweringOthersIsSkipped() = runTest {
        // In this order (the mock answers on its own threads): Bad. fails, then Good. is answered,
        // then Bad. fails again.
        val badTried = CompletableDeferred<Unit>()
        val goodAnswered = CompletableDeferred<Unit>()
        forText =
            mapOf(
                "Bad." to
                    {
                        if (!badTried.complete(Unit)) goodAnswered.await()
                        Answer.Error(HttpStatusCode.InternalServerError)
                    },
                "Good." to
                    {
                        badTried.await()
                        ok
                    },
            )
        val engine = engine()
        val bad = async { runCatching { engine.synthesize("Bad.", dir, "0") }.exceptionOrNull() }
        engine.synthesize("Good.", dir, "1")
        goodAnswered.complete(Unit)

        val error = bad.await()
        // Not an interruption to wait out: an ordinary failure, so just this chunk is skipped.
        assertEquals(false, error is SpeechException)
        assertEquals(true, error != null)
    }

    @Test
    fun aBusyVoiceIsWaitedOutEvenWhileOtherTextIsAnswered() = runTest {
        // As above, but the server says its provider is busy: not this text's fault.
        val busyTried = CompletableDeferred<Unit>()
        val goodAnswered = CompletableDeferred<Unit>()
        forText =
            mapOf(
                "Busy." to
                    {
                        if (!busyTried.complete(Unit)) goodAnswered.await()
                        Answer.Error(HttpStatusCode.ServiceUnavailable)
                    },
                "Good." to
                    {
                        busyTried.await()
                        ok
                    },
            )
        val engine = engine()
        val busy = async { runCatching { engine.synthesize("Busy.", dir, "0") }.exceptionOrNull() }
        engine.synthesize("Good.", dir, "1")
        goodAnswered.complete(Unit)

        assertEquals(SpeechInterrupted::class, busy.await()!!::class)
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
        played(engine.synthesize("Skipped.", dir, "1"))
        assertEquals(1, requests)
    }

    @Test
    fun theCacheIsTrimmedOldestFirst() = runTest {
        // Three bytes each, against a five-byte cache.
        val engine = engine()
        played(engine.synthesize("One.", dir, "0"))
        val first = cached().single()
        first.setLastModified(1_000)
        played(engine.synthesize("Two.", dir, "1"))
        assertEquals(false, first.exists())
        assertEquals(1, cached().size)
    }
}
