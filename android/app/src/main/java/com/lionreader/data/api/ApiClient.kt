package com.lionreader.data.api

import android.util.Log
import com.lionreader.data.api.models.ErrorResponse
import com.lionreader.di.AppConfig
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logger
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import java.io.IOException
import java.net.UnknownHostException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * API client built on Ktor providing HTTP communication with the Lion Reader backend.
 *
 * Features:
 * - Automatic JSON serialization/deserialization
 * - Authentication header injection
 * - Configurable timeouts
 * - Debug logging (in debug builds only)
 * - Comprehensive error handling
 */
@Singleton
class ApiClient @Inject constructor(
    private val appConfig: AppConfig,
    private val authInterceptor: AuthInterceptor,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        coerceInputValues = true
    }

    val httpClient: HttpClient = HttpClient(CIO) {
        // JSON serialization
        install(ContentNegotiation) {
            json(json)
        }

        // Timeouts
        install(HttpTimeout) {
            connectTimeoutMillis = CONNECT_TIMEOUT_MS
            requestTimeoutMillis = REQUEST_TIMEOUT_MS
            socketTimeoutMillis = SOCKET_TIMEOUT_MS
        }

        // Authentication
        install(AuthPlugin) {
            authInterceptor = this@ApiClient.authInterceptor
        }

        // Logging (only in debug builds)
        if (appConfig.isDebug) {
            install(Logging) {
                logger = object : Logger {
                    override fun log(message: String) {
                        Log.d(TAG, message)
                    }
                }
                level = LogLevel.BODY
            }
        }

        // Default request configuration
        defaultRequest {
            url(appConfig.fullApiUrl)
            contentType(ContentType.Application.Json)
        }
    }

    /**
     * Performs a GET request and returns the result wrapped in ApiResult.
     */
    suspend inline fun <reified T> get(
        path: String,
        builder: HttpRequestBuilder.() -> Unit = {},
    ): ApiResult<T> = safeApiCall {
        httpClient.get(path, builder)
    }

    /**
     * Performs a POST request and returns the result wrapped in ApiResult.
     */
    suspend inline fun <reified T> post(
        path: String,
        body: Any? = null,
        builder: HttpRequestBuilder.() -> Unit = {},
    ): ApiResult<T> = safeApiCall {
        httpClient.post(path) {
            body?.let { setBody(it) }
            builder()
        }
    }

    /**
     * Performs a PUT request and returns the result wrapped in ApiResult.
     */
    suspend inline fun <reified T> put(
        path: String,
        body: Any? = null,
        builder: HttpRequestBuilder.() -> Unit = {},
    ): ApiResult<T> = safeApiCall {
        httpClient.put(path) {
            body?.let { setBody(it) }
            builder()
        }
    }

    /**
     * Performs a DELETE request and returns the result wrapped in ApiResult.
     */
    suspend inline fun <reified T> delete(
        path: String,
        builder: HttpRequestBuilder.() -> Unit = {},
    ): ApiResult<T> = safeApiCall {
        httpClient.delete(path, builder)
    }

    /**
     * Performs a POST request that doesn't expect a response body (returns Unit).
     */
    suspend fun postNoContent(
        path: String,
        body: Any? = null,
        builder: HttpRequestBuilder.() -> Unit = {},
    ): ApiResult<Unit> = safeApiCallNoContent {
        httpClient.post(path) {
            body?.let { setBody(it) }
            builder()
        }
    }

    /**
     * Performs a DELETE request that doesn't expect a response body (returns Unit).
     */
    suspend fun deleteNoContent(
        path: String,
        builder: HttpRequestBuilder.() -> Unit = {},
    ): ApiResult<Unit> = safeApiCallNoContent {
        httpClient.delete(path, builder)
    }

    /**
     * Wraps an API call with error handling and response parsing.
     */
    suspend inline fun <reified T> safeApiCall(
        call: () -> HttpResponse,
    ): ApiResult<T> {
        return try {
            val response = call()
            handleResponse(response)
        } catch (e: Exception) {
            handleException(e)
        }
    }

    /**
     * Wraps an API call that doesn't return a body with error handling.
     */
    suspend fun safeApiCallNoContent(
        call: suspend () -> HttpResponse,
    ): ApiResult<Unit> {
        return try {
            val response = call()
            handleResponseNoContent(response)
        } catch (e: Exception) {
            handleException(e)
        }
    }

    /**
     * Handles the HTTP response and converts it to an ApiResult.
     */
    suspend inline fun <reified T> handleResponse(response: HttpResponse): ApiResult<T> {
        return when {
            response.status.isSuccess() -> {
                try {
                    ApiResult.Success(response.body<T>())
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to parse response body", e)
                    ApiResult.Error(
                        code = "PARSE_ERROR",
                        message = "Failed to parse response: ${e.message}",
                    )
                }
            }
            response.status == HttpStatusCode.Unauthorized -> {
                ApiResult.Unauthorized
            }
            response.status == HttpStatusCode.TooManyRequests -> {
                val retryAfter = response.headers["Retry-After"]?.toIntOrNull()
                ApiResult.RateLimited(retryAfter)
            }
            else -> {
                parseErrorResponse(response)
            }
        }
    }

    /**
     * Handles an HTTP response that doesn't have a body.
     */
    suspend fun handleResponseNoContent(response: HttpResponse): ApiResult<Unit> {
        return when {
            response.status.isSuccess() -> {
                ApiResult.Success(Unit)
            }
            response.status == HttpStatusCode.Unauthorized -> {
                ApiResult.Unauthorized
            }
            response.status == HttpStatusCode.TooManyRequests -> {
                val retryAfter = response.headers["Retry-After"]?.toIntOrNull()
                ApiResult.RateLimited(retryAfter)
            }
            else -> {
                parseErrorResponse(response)
            }
        }
    }

    /**
     * Parses an error response body into an ApiResult.Error.
     */
    suspend fun parseErrorResponse(response: HttpResponse): ApiResult.Error {
        return try {
            val errorBody = response.bodyAsText()
            val errorResponse = json.decodeFromString<ErrorResponse>(errorBody)
            ApiResult.Error(
                code = errorResponse.error.code,
                message = errorResponse.error.message,
                details = errorResponse.error.details,
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse error response", e)
            ApiResult.Error(
                code = "HTTP_${response.status.value}",
                message = response.status.description,
            )
        }
    }

    /**
     * Converts exceptions to appropriate ApiResult types.
     */
    fun <T> handleException(e: Exception): ApiResult<T> {
        Log.e(TAG, "API call failed", e)
        return when (e) {
            is UnknownHostException,
            is IOException,
            -> ApiResult.NetworkError(e)
            else -> ApiResult.NetworkError(e)
        }
    }

    companion object {
        private const val TAG = "ApiClient"
        private const val CONNECT_TIMEOUT_MS = 10_000L
        private const val REQUEST_TIMEOUT_MS = 30_000L
        private const val SOCKET_TIMEOUT_MS = 30_000L
    }
}

/**
 * Extension function to add query parameters to a request.
 */
fun HttpRequestBuilder.queryParam(name: String, value: Any?) {
    value?.let { parameter(name, it.toString()) }
}
