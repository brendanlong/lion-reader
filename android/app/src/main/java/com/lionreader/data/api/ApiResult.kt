package com.lionreader.data.api

/**
 * Sealed class representing the result of an API call.
 *
 * This provides a type-safe way to handle different API response scenarios:
 * - Success: The call succeeded with data of type T
 * - Error: The API returned an error response with code and message
 * - NetworkError: A network-level failure occurred (no connectivity, timeout, etc.)
 * - Unauthorized: The user's session is invalid or expired (401)
 * - RateLimited: The API rate limit was exceeded (429)
 */
sealed class ApiResult<out T> {
    /**
     * Successful API response with data.
     */
    data class Success<T>(val data: T) : ApiResult<T>()

    /**
     * API returned an error response.
     */
    data class Error(
        val code: String,
        val message: String,
        val details: Map<String, String>? = null,
    ) : ApiResult<Nothing>()

    /**
     * Network-level error (connectivity, timeout, etc.).
     */
    data class NetworkError(
        val cause: Throwable? = null,
    ) : ApiResult<Nothing>()

    /**
     * User is not authenticated or session expired.
     */
    data object Unauthorized : ApiResult<Nothing>()

    /**
     * Rate limit exceeded. Contains retry delay if provided by server.
     */
    data class RateLimited(
        val retryAfterSeconds: Int? = null,
    ) : ApiResult<Nothing>()

    /**
     * Returns true if this is a successful result.
     */
    val isSuccess: Boolean
        get() = this is Success

    /**
     * Returns true if this is an error result (any type of error).
     */
    val isError: Boolean
        get() = this !is Success

    /**
     * Returns the data if successful, null otherwise.
     */
    fun getOrNull(): T? = when (this) {
        is Success -> data
        else -> null
    }

    /**
     * Returns the data if successful, throws an exception otherwise.
     */
    fun getOrThrow(): T = when (this) {
        is Success -> data
        is Error -> throw ApiException(code, message)
        is NetworkError -> throw NetworkException(cause)
        is Unauthorized -> throw UnauthorizedException()
        is RateLimited -> throw RateLimitedException(retryAfterSeconds)
    }

    /**
     * Returns the data if successful, or the result of the given function otherwise.
     */
    inline fun getOrElse(onError: (ApiResult<Nothing>) -> @UnsafeVariance T): T = when (this) {
        is Success -> data
        is Error -> onError(this)
        is NetworkError -> onError(this)
        is Unauthorized -> onError(this)
        is RateLimited -> onError(this)
    }

    /**
     * Transforms the successful data using the given function.
     */
    inline fun <R> map(transform: (T) -> R): ApiResult<R> = when (this) {
        is Success -> Success(transform(data))
        is Error -> this
        is NetworkError -> this
        is Unauthorized -> this
        is RateLimited -> this
    }

    /**
     * Transforms the successful data using the given function that returns an ApiResult.
     */
    inline fun <R> flatMap(transform: (T) -> ApiResult<R>): ApiResult<R> = when (this) {
        is Success -> transform(data)
        is Error -> this
        is NetworkError -> this
        is Unauthorized -> this
        is RateLimited -> this
    }

    /**
     * Executes the given action if this is a successful result.
     */
    inline fun onSuccess(action: (T) -> Unit): ApiResult<T> {
        if (this is Success) {
            action(data)
        }
        return this
    }

    /**
     * Executes the given action if this is an error result.
     */
    inline fun onError(action: (ApiResult<Nothing>) -> Unit): ApiResult<T> {
        if (this !is Success) {
            @Suppress("UNCHECKED_CAST")
            action(this as ApiResult<Nothing>)
        }
        return this
    }
}

/**
 * Exception thrown when API returns an error.
 */
class ApiException(
    val code: String,
    override val message: String,
) : Exception(message)

/**
 * Exception thrown when a network error occurs.
 */
class NetworkException(
    override val cause: Throwable?,
) : Exception("Network error", cause)

/**
 * Exception thrown when the user is unauthorized.
 */
class UnauthorizedException : Exception("Unauthorized")

/**
 * Exception thrown when rate limited.
 */
class RateLimitedException(
    val retryAfterSeconds: Int?,
) : Exception("Rate limited")

/**
 * Extension function to fold over an ApiResult.
 */
fun <T, R> ApiResult<T>.fold(
    onSuccess: (T) -> R,
    onError: (ApiResult.Error) -> R,
    onNetworkError: (ApiResult.NetworkError) -> R = { onError(ApiResult.Error("NETWORK_ERROR", "Network error")) },
    onUnauthorized: () -> R = { onError(ApiResult.Error("UNAUTHORIZED", "Unauthorized")) },
    onRateLimited: (ApiResult.RateLimited) -> R = { onError(ApiResult.Error("RATE_LIMITED", "Rate limited")) },
): R = when (this) {
    is ApiResult.Success -> onSuccess(data)
    is ApiResult.Error -> onError(this)
    is ApiResult.NetworkError -> onNetworkError(this)
    is ApiResult.Unauthorized -> onUnauthorized()
    is ApiResult.RateLimited -> onRateLimited(this)
}
