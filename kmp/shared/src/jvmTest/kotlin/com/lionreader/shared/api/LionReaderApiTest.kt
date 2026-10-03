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
        server.eventsError =
            HttpStatusCode.Unauthorized to
                """{"message":"No.","data":{"httpStatus":401,"appErrorCode":"SOMETHING_ELSE"}}"""

        val error = assertFailsWith<ApiException> { api.events({}, {}) }

        assertEquals("SOMETHING_ELSE", error.appErrorCode)
        assertEquals(listOf("/api/v1/events"), server.requests.map { it.url.encodedPath })
    }

    @Test
    fun aPlain401StillRefreshesTheToken() = runTest {
        server.saveError = HttpStatusCode.Unauthorized to """{"message":"Unauthorized"}"""

        // (The fake has no token endpoint, so the refresh itself fails.)
        assertFailsWith<Exception> { api.saveArticle("https://example.com/a") }

        assertTrue(server.requests.any { it.url.encodedPath.endsWith("/oauth/token") })
    }
}
