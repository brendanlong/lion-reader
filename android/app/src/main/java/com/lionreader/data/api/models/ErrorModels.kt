package com.lionreader.data.api.models

import kotlinx.serialization.Serializable

/**
 * Error details from the API.
 */
@Serializable
data class ErrorDetails(
    val code: String,
    val message: String,
    val details: Map<String, String>? = null,
)

/**
 * Error response wrapper from the API.
 */
@Serializable
data class ErrorResponse(
    val error: ErrorDetails,
)
