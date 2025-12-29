package com.lionreader.data.api

import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Unit tests for [ApiResult] and its extension functions.
 *
 * Tests cover:
 * - Success/error state properties
 * - Data extraction methods (getOrNull, getOrThrow, getOrElse)
 * - Transformation methods (map, flatMap)
 * - Callback methods (onSuccess, onError)
 * - Fold extension function
 */
class ApiResultTest {
    @Nested
    @DisplayName("State Properties")
    inner class StateProperties {
        @Test
        @DisplayName("Success isSuccess returns true")
        fun successIsSuccessReturnsTrue() {
            val result: ApiResult<String> = ApiResult.Success("data")
            assertTrue(result.isSuccess)
            assertFalse(result.isError)
        }

        @Test
        @DisplayName("Error isError returns true")
        fun errorIsErrorReturnsTrue() {
            val result: ApiResult<String> = ApiResult.Error("CODE", "message")
            assertFalse(result.isSuccess)
            assertTrue(result.isError)
        }

        @Test
        @DisplayName("NetworkError isError returns true")
        fun networkErrorIsErrorReturnsTrue() {
            val result: ApiResult<String> = ApiResult.NetworkError()
            assertFalse(result.isSuccess)
            assertTrue(result.isError)
        }

        @Test
        @DisplayName("Unauthorized isError returns true")
        fun unauthorizedIsErrorReturnsTrue() {
            val result: ApiResult<String> = ApiResult.Unauthorized
            assertFalse(result.isSuccess)
            assertTrue(result.isError)
        }

        @Test
        @DisplayName("RateLimited isError returns true")
        fun rateLimitedIsErrorReturnsTrue() {
            val result: ApiResult<String> = ApiResult.RateLimited(60)
            assertFalse(result.isSuccess)
            assertTrue(result.isError)
        }
    }

    @Nested
    @DisplayName("getOrNull")
    inner class GetOrNull {
        @Test
        @DisplayName("Success returns data")
        fun successReturnsData() {
            val result: ApiResult<String> = ApiResult.Success("hello")
            assertEquals("hello", result.getOrNull())
        }

        @Test
        @DisplayName("Error returns null")
        fun errorReturnsNull() {
            val result: ApiResult<String> = ApiResult.Error("CODE", "message")
            assertNull(result.getOrNull())
        }

        @Test
        @DisplayName("NetworkError returns null")
        fun networkErrorReturnsNull() {
            val result: ApiResult<String> = ApiResult.NetworkError()
            assertNull(result.getOrNull())
        }

        @Test
        @DisplayName("Unauthorized returns null")
        fun unauthorizedReturnsNull() {
            val result: ApiResult<String> = ApiResult.Unauthorized
            assertNull(result.getOrNull())
        }

        @Test
        @DisplayName("RateLimited returns null")
        fun rateLimitedReturnsNull() {
            val result: ApiResult<String> = ApiResult.RateLimited()
            assertNull(result.getOrNull())
        }
    }

    @Nested
    @DisplayName("getOrThrow")
    inner class GetOrThrow {
        @Test
        @DisplayName("Success returns data")
        fun successReturnsData() {
            val result: ApiResult<String> = ApiResult.Success("hello")
            assertEquals("hello", result.getOrThrow())
        }

        @Test
        @DisplayName("Error throws ApiException")
        fun errorThrowsApiException() {
            val result: ApiResult<String> = ApiResult.Error("TEST_ERROR", "Test message")

            val exception =
                assertFailsWith<ApiException> {
                    result.getOrThrow()
                }
            assertEquals("TEST_ERROR", exception.code)
            assertEquals("Test message", exception.message)
        }

        @Test
        @DisplayName("NetworkError throws NetworkException")
        fun networkErrorThrowsNetworkException() {
            val cause = RuntimeException("Connection failed")
            val result: ApiResult<String> = ApiResult.NetworkError(cause)

            val exception =
                assertFailsWith<NetworkException> {
                    result.getOrThrow()
                }
            assertEquals(cause, exception.cause)
        }

        @Test
        @DisplayName("Unauthorized throws UnauthorizedException")
        fun unauthorizedThrowsUnauthorizedException() {
            val result: ApiResult<String> = ApiResult.Unauthorized

            assertFailsWith<UnauthorizedException> {
                result.getOrThrow()
            }
        }

        @Test
        @DisplayName("RateLimited throws RateLimitedException")
        fun rateLimitedThrowsRateLimitedException() {
            val result: ApiResult<String> = ApiResult.RateLimited(30)

            val exception =
                assertFailsWith<RateLimitedException> {
                    result.getOrThrow()
                }
            assertEquals(30, exception.retryAfterSeconds)
        }
    }

    @Nested
    @DisplayName("getOrElse")
    inner class GetOrElse {
        @Test
        @DisplayName("Success returns data")
        fun successReturnsData() {
            val result: ApiResult<String> = ApiResult.Success("hello")
            assertEquals("hello", result.getOrElse { "default" })
        }

        @Test
        @DisplayName("Error invokes fallback")
        fun errorInvokesFallback() {
            val result: ApiResult<String> = ApiResult.Error("CODE", "message")

            var capturedError: ApiResult<Nothing>? = null
            val fallback =
                result.getOrElse { error ->
                    capturedError = error
                    "fallback"
                }

            assertEquals("fallback", fallback)
            assertTrue(capturedError is ApiResult.Error)
        }

        @Test
        @DisplayName("NetworkError invokes fallback")
        fun networkErrorInvokesFallback() {
            val result: ApiResult<String> = ApiResult.NetworkError()
            assertEquals("network-fallback", result.getOrElse { "network-fallback" })
        }
    }

    @Nested
    @DisplayName("map")
    inner class Map {
        @Test
        @DisplayName("Success transforms data")
        fun successTransformsData() {
            val result: ApiResult<Int> = ApiResult.Success(5)
            val mapped = result.map { it * 2 }

            assertTrue(mapped is ApiResult.Success)
            assertEquals(10, (mapped as ApiResult.Success).data)
        }

        @Test
        @DisplayName("Error propagates unchanged")
        fun errorPropagatesUnchanged() {
            val result: ApiResult<Int> = ApiResult.Error("CODE", "message")
            val mapped = result.map { it * 2 }

            assertTrue(mapped is ApiResult.Error)
            assertEquals("CODE", (mapped as ApiResult.Error).code)
        }

        @Test
        @DisplayName("NetworkError propagates unchanged")
        fun networkErrorPropagatesUnchanged() {
            val result: ApiResult<Int> = ApiResult.NetworkError()
            val mapped = result.map { it * 2 }

            assertTrue(mapped is ApiResult.NetworkError)
        }

        @Test
        @DisplayName("Unauthorized propagates unchanged")
        fun unauthorizedPropagatesUnchanged() {
            val result: ApiResult<Int> = ApiResult.Unauthorized
            val mapped = result.map { it * 2 }

            assertTrue(mapped is ApiResult.Unauthorized)
        }

        @Test
        @DisplayName("RateLimited propagates unchanged")
        fun rateLimitedPropagatesUnchanged() {
            val result: ApiResult<Int> = ApiResult.RateLimited(60)
            val mapped = result.map { it * 2 }

            assertTrue(mapped is ApiResult.RateLimited)
            assertEquals(60, (mapped as ApiResult.RateLimited).retryAfterSeconds)
        }
    }

    @Nested
    @DisplayName("flatMap")
    inner class FlatMap {
        @Test
        @DisplayName("Success chains to new Success")
        fun successChainsToNewSuccess() {
            val result: ApiResult<Int> = ApiResult.Success(5)
            val flatMapped = result.flatMap { ApiResult.Success(it.toString()) }

            assertTrue(flatMapped is ApiResult.Success)
            assertEquals("5", (flatMapped as ApiResult.Success).data)
        }

        @Test
        @DisplayName("Success chains to Error")
        fun successChainsToError() {
            val result: ApiResult<Int> = ApiResult.Success(5)
            val flatMapped: ApiResult<String> =
                result.flatMap {
                    ApiResult.Error("TRANSFORMED_ERROR", "Transformed")
                }

            assertTrue(flatMapped is ApiResult.Error)
            assertEquals("TRANSFORMED_ERROR", (flatMapped as ApiResult.Error).code)
        }

        @Test
        @DisplayName("Error propagates without calling transform")
        fun errorPropagatesWithoutCallingTransform() {
            val result: ApiResult<Int> = ApiResult.Error("ORIGINAL", "Original error")
            var transformCalled = false

            val flatMapped: ApiResult<String> =
                result.flatMap {
                    transformCalled = true
                    ApiResult.Success("should not reach")
                }

            assertFalse(transformCalled)
            assertTrue(flatMapped is ApiResult.Error)
            assertEquals("ORIGINAL", (flatMapped as ApiResult.Error).code)
        }
    }

    @Nested
    @DisplayName("onSuccess and onError")
    inner class Callbacks {
        @Test
        @DisplayName("onSuccess is called for Success")
        fun onSuccessCalledForSuccess() {
            val result: ApiResult<String> = ApiResult.Success("data")
            var capturedData: String? = null

            result.onSuccess { capturedData = it }

            assertEquals("data", capturedData)
        }

        @Test
        @DisplayName("onSuccess is not called for Error")
        fun onSuccessNotCalledForError() {
            val result: ApiResult<String> = ApiResult.Error("CODE", "message")
            var wasCalled = false

            result.onSuccess { wasCalled = true }

            assertFalse(wasCalled)
        }

        @Test
        @DisplayName("onError is called for Error")
        fun onErrorCalledForError() {
            val result: ApiResult<String> = ApiResult.Error("CODE", "message")
            var capturedError: ApiResult<Nothing>? = null

            result.onError { capturedError = it }

            assertTrue(capturedError is ApiResult.Error)
        }

        @Test
        @DisplayName("onError is not called for Success")
        fun onErrorNotCalledForSuccess() {
            val result: ApiResult<String> = ApiResult.Success("data")
            var wasCalled = false

            result.onError { wasCalled = true }

            assertFalse(wasCalled)
        }

        @Test
        @DisplayName("Callbacks can be chained")
        fun callbacksCanBeChained() {
            val result: ApiResult<String> = ApiResult.Success("data")
            var successCalled = false
            var errorCalled = false

            result
                .onSuccess { successCalled = true }
                .onError { errorCalled = true }

            assertTrue(successCalled)
            assertFalse(errorCalled)
        }
    }

    @Nested
    @DisplayName("fold extension function")
    inner class FoldExtension {
        @Test
        @DisplayName("fold handles Success")
        fun foldHandlesSuccess() {
            val result: ApiResult<Int> = ApiResult.Success(42)

            val folded =
                result.fold(
                    onSuccess = { "success: $it" },
                    onError = { "error" },
                )

            assertEquals("success: 42", folded)
        }

        @Test
        @DisplayName("fold handles Error")
        fun foldHandlesError() {
            val result: ApiResult<Int> = ApiResult.Error("TEST", "Test message")

            val folded =
                result.fold(
                    onSuccess = { "success: $it" },
                    onError = { "error: ${it.code}" },
                )

            assertEquals("error: TEST", folded)
        }

        @Test
        @DisplayName("fold handles NetworkError with custom handler")
        fun foldHandlesNetworkError() {
            val result: ApiResult<Int> = ApiResult.NetworkError()

            val folded =
                result.fold(
                    onSuccess = { "success" },
                    onError = { "error" },
                    onNetworkError = { "network error" },
                )

            assertEquals("network error", folded)
        }

        @Test
        @DisplayName("fold handles Unauthorized with custom handler")
        fun foldHandlesUnauthorized() {
            val result: ApiResult<Int> = ApiResult.Unauthorized

            val folded =
                result.fold(
                    onSuccess = { "success" },
                    onError = { "error" },
                    onUnauthorized = { "unauthorized" },
                )

            assertEquals("unauthorized", folded)
        }

        @Test
        @DisplayName("fold handles RateLimited with custom handler")
        fun foldHandlesRateLimited() {
            val result: ApiResult<Int> = ApiResult.RateLimited(30)

            val folded =
                result.fold(
                    onSuccess = { "success" },
                    onError = { "error" },
                    onRateLimited = { "retry in ${it.retryAfterSeconds}s" },
                )

            assertEquals("retry in 30s", folded)
        }

        @Test
        @DisplayName("fold uses default error handlers when not provided")
        fun foldUsesDefaultHandlers() {
            val networkResult: ApiResult<Int> = ApiResult.NetworkError()
            val unauthorizedResult: ApiResult<Int> = ApiResult.Unauthorized
            val rateLimitedResult: ApiResult<Int> = ApiResult.RateLimited()

            // All should fall back to onError with appropriate error codes
            val networkFolded =
                networkResult.fold(
                    onSuccess = { "success" },
                    onError = { "error: ${it.code}" },
                )
            assertEquals("error: NETWORK_ERROR", networkFolded)

            val unauthorizedFolded =
                unauthorizedResult.fold(
                    onSuccess = { "success" },
                    onError = { "error: ${it.code}" },
                )
            assertEquals("error: UNAUTHORIZED", unauthorizedFolded)

            val rateLimitedFolded =
                rateLimitedResult.fold(
                    onSuccess = { "success" },
                    onError = { "error: ${it.code}" },
                )
            assertEquals("error: RATE_LIMITED", rateLimitedFolded)
        }
    }

    @Nested
    @DisplayName("Error details")
    inner class ErrorDetails {
        @Test
        @DisplayName("Error can include details map")
        fun errorCanIncludeDetails() {
            val details = mapOf("field" to "email", "reason" to "invalid format")
            val result = ApiResult.Error("VALIDATION_ERROR", "Invalid input", details)

            assertEquals(details, result.details)
        }

        @Test
        @DisplayName("Error details default to null")
        fun errorDetailsDefaultToNull() {
            val result = ApiResult.Error("CODE", "message")
            assertNull(result.details)
        }

        @Test
        @DisplayName("RateLimited can include retry delay")
        fun rateLimitedCanIncludeRetryDelay() {
            val result = ApiResult.RateLimited(120)
            assertEquals(120, result.retryAfterSeconds)
        }

        @Test
        @DisplayName("RateLimited retry delay defaults to null")
        fun rateLimitedRetryDelayDefaultsToNull() {
            val result = ApiResult.RateLimited()
            assertNull(result.retryAfterSeconds)
        }
    }
}
