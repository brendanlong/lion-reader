package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals

class ApiFailureTest {
    private fun failure(status: Int, code: String? = null) =
        ApiException(status, "HTTP $status", "Why", code).failure()

    @Test
    fun signedOutIsARequestNeverSent() {
        assertEquals(ApiFailure.SignedOut, failure(0))
    }

    @Test
    fun aRequestThatCanNeverSucceedIsInvalid() {
        for (status in listOf(400, 404, 422)) {
            assertEquals(ApiFailure.Invalid("Why"), failure(status), "$status")
        }
        // A coded 4xx is the server's reason, e.g. a private Google Doc.
        assertEquals(ApiFailure.Invalid("Why"), failure(401, "NEEDS_GOOGLE_SIGNIN"))
        assertEquals(ApiFailure.Invalid("Why"), failure(403, "NEEDS_DOCS_PERMISSION"))
    }

    @Test
    fun anotherClientErrorIsARefusal() {
        // A 401 only gets this far after a token refresh: it's the server's answer.
        for (status in listOf(401, 403, 409, 413)) {
            assertEquals(ApiFailure.Refused("Why"), failure(status), "$status")
        }
    }

    @Test
    fun aTimeoutIsTriedAgainAsNoAnswer() {
        assertEquals(ApiFailure.Unreachable, failure(408))
        assertEquals(ApiFailure.Unreachable, IllegalStateException("network").apiFailure())
    }

    @Test
    fun rateLimitsAndABusyServerAreTriedAgainLater() {
        assertEquals(ApiFailure.Busy("Why"), failure(429))
        assertEquals(ApiFailure.Busy("Why"), failure(429, "SERVER_BUSY"))
        // A 5xx's message isn't for the user.
        assertEquals(ApiFailure.Busy(null), failure(503))
    }

    @Test
    fun otherServerErrorsAreServerTrouble() {
        for (status in listOf(500, 502, 504)) {
            assertEquals(ApiFailure.ServerTrouble, failure(status), "$status")
        }
        assertEquals(ApiFailure.ServerTrouble, failure(500, "INTERNAL_ERROR"))
        // A 200 that isn't what was asked for (e.g. not audio).
        assertEquals(ApiFailure.ServerTrouble, failure(200))
        assertEquals(null, ApiFailure.ServerTrouble.message)
    }
}
