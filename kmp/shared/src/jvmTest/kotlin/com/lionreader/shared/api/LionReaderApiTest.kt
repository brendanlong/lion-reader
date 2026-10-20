package com.lionreader.shared.api

import com.lionreader.shared.sync.FakeServer
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class LionReaderApiTest {
    private val server = FakeServer()
    private val api = server.api()

    @Test
    fun savesALink() = runTest {
        assertEquals("s-1", api.saveArticle("https://example.com/a").id)
        assertEquals(listOf("https://example.com/a"), server.savedUrls)
    }

    @Test
    fun uploadsAFileAsBase64() = runTest {
        val pdf = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, -1)

        assertEquals("Uploaded", api.uploadFile("Paper.pdf", pdf).title)

        assertEquals(listOf(UploadFileRequest("JVBERi0A/w==", "Paper.pdf")), server.uploads)
    }

    @Test
    fun aCoded401IsTheServersAnswerNotAnExpiredToken() = runTest {
        server.saveError =
            HttpStatusCode.Unauthorized to
                """{"message":"Link your Google account in the web app.","code":"UNAUTHORIZED",
                   "data":{"httpStatus":401,"appErrorCode":"NEEDS_GOOGLE_SIGNIN"}}"""

        val error = assertFailsWith<ApiException> { api.saveArticle("https://docs.google.com/d") }

        assertEquals("Link your Google account in the web app.", error.serverMessage)
        assertEquals("NEEDS_GOOGLE_SIGNIN", error.appErrorCode)
        assertEquals(
            ApiFailure.Invalid("Link your Google account in the web app."),
            error.failure(),
        )
        // No token refresh, and the save wasn't sent twice.
        assertEquals(listOf("/api/v1/saved"), server.requests.map { it.url.encodedPath })
    }

    @Test
    fun aCoded401OnAStreamIsTheServersAnswerToo() = runTest {
        server.speechError =
            HttpStatusCode.Unauthorized to
                """{"message":"No.","data":{"httpStatus":401,"appErrorCode":"SOMETHING_ELSE"}}"""

        val error =
            assertFailsWith<ApiException> { api.streamSpeech("model", "voice", "Hi.", 0f) {} }

        assertEquals("SOMETHING_ELSE", error.appErrorCode)
        assertEquals(listOf("/api/v1/narration/speech"), server.requests.map { it.url.encodedPath })
    }

    @Test
    fun aPlain401StillRefreshesTheToken() = runTest {
        server.saveError = HttpStatusCode.Unauthorized to """{"message":"Unauthorized"}"""

        // (The fake has no token endpoint, so the refresh itself fails.)
        assertFailsWith<Exception> { api.saveArticle("https://example.com/a") }

        assertTrue(server.requests.any { it.url.encodedPath.endsWith("/oauth/token") })
    }
}
