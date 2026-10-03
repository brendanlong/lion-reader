package com.lionreader.shared.api

/**
 * What a failed request means: the one classification of [ApiException]s, so that every caller
 * agrees on what gives up and what tries again. Each maps it to its own outcome.
 */
sealed interface ApiFailure {
    /** The server's explanation, when it's one for the user (a 5xx's isn't). */
    val message: String?
        get() = null

    /** No signed-in account to send the request as; it was never sent. */
    data object SignedOut : ApiFailure

    /**
     * The server's answer, which retrying unchanged won't change. A 401 is one too: [ApiException]
     * only has one after a token refresh, or with an app error code, so it isn't about the token.
     */
    sealed interface Rejected : ApiFailure

    /**
     * The request itself can never succeed (400, 404, 422, or a 4xx with an app error code such as
     * `NEEDS_GOOGLE_SIGNIN`), so what asked for it can be dropped.
     */
    data class Invalid(override val message: String?) : Rejected

    /** Any other 4xx (401, 403, 409…): turned down as things stand, not shown to be wrong. */
    data class Refused(override val message: String?) : Rejected

    /** Try again later: rate limited (429, which says whose limit), or busy (503). */
    data class Busy(override val message: String?) : ApiFailure

    /** A 5xx but 503, or an answer that isn't what was asked for. */
    data object ServerTrouble : ApiFailure

    /** No answer: the network, or a 408 (the server gave up waiting for the request). */
    data object Unreachable : ApiFailure
}

fun ApiException.failure(): ApiFailure =
    when {
        status == 0 -> ApiFailure.SignedOut
        status == 408 -> ApiFailure.Unreachable
        status == 429 -> ApiFailure.Busy(serverMessage)
        status == 400 || status == 404 || status == 422 -> ApiFailure.Invalid(serverMessage)
        status in 400..499 && appErrorCode != null -> ApiFailure.Invalid(serverMessage)
        status in 400..499 -> ApiFailure.Refused(serverMessage)
        status == 503 -> ApiFailure.Busy(null)
        else -> ApiFailure.ServerTrouble
    }

/**
 * [failure] for an [ApiException]. Anything else (the network, the token endpoint, a response that
 * doesn't parse) brought no answer the app can use: [ApiFailure.Unreachable].
 */
fun Exception.apiFailure(): ApiFailure =
    (this as? ApiException)?.failure() ?: ApiFailure.Unreachable
