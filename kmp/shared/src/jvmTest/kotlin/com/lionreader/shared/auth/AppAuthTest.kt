package com.lionreader.shared.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest

class AppAuthTest {
    private var refreshes = 0
    private var tokenStatus = HttpStatusCode.OK

    private val store =
        object : TokenStore {
            var tokens: StoredTokens? = StoredTokens("old-access", "old-refresh", 0)

            override fun load() = tokens

            override fun save(tokens: StoredTokens?) {
                this.tokens = tokens
            }
        }

    private val auth =
        AppAuth(
            "https://lion.test",
            HttpClient(
                MockEngine {
                    refreshes++
                    delay(10)
                    if (tokenStatus != HttpStatusCode.OK) {
                        respond("""{"error":"x"}""", tokenStatus)
                    } else {
                        respond(
                            """{"access_token":"access-$refreshes","refresh_token":"refresh-$refreshes","expires_in":3600}""",
                            HttpStatusCode.OK,
                            headersOf(HttpHeaders.ContentType, "application/json"),
                        )
                    }
                }
            ),
            store,
        ) {
            1_000_000L
        }

    @Test
    fun concurrentCallersShareOneRefresh() = runTest {
        val tokens = List(5) { async { auth.accessToken() } }.awaitAll()

        assertEquals(1, refreshes)
        assertTrue(tokens.all { it == "access-1" })
        assertEquals("refresh-1", store.tokens?.refreshToken)
    }

    @Test
    fun aRejectedTokenIsRefreshedOnceEvenWhenManyCallersSawIt() = runTest {
        auth.accessToken()
        List(3) { async { auth.accessToken(forceRefresh = true, rejected = "access-1") } }
            .awaitAll()

        assertEquals(2, refreshes)
    }

    @Test
    fun aRejectedRefreshTokenSignsOut() = runTest {
        tokenStatus = HttpStatusCode.BadRequest

        assertNull(auth.accessToken())
        assertFalse(auth.signedIn.value)
    }

    @Test
    fun aServerErrorKeepsTheSession() = runTest {
        tokenStatus = HttpStatusCode.ServiceUnavailable

        assertFailsWith<AuthException> { auth.accessToken() }
        assertTrue(auth.signedIn.value)
        assertEquals("old-refresh", store.tokens?.refreshToken)
    }
}
