package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * User data returned from the API.
 */
@Serializable
data class User(
    val id: String,
    val email: String,
    val name: String? = null,
    @SerialName("created_at")
    val createdAt: String? = null,
)

/**
 * Response from login endpoint.
 */
@Serializable
data class LoginResponse(
    val user: User,
    @SerialName("sessionToken")
    val sessionToken: String,
    @SerialName("isNewUser")
    val isNewUser: Boolean? = null,
)

/**
 * Wrapper for user response from /me endpoint.
 */
@Serializable
data class UserResponse(
    val user: User,
)

/**
 * Request body for email/password login.
 */
@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
)

/**
 * OAuth provider information.
 */
@Serializable
data class AuthProvider(
    val id: String,
    val name: String,
)

/**
 * Response from /auth/providers endpoint.
 */
@Serializable
data class ProvidersResponse(
    val providers: List<AuthProvider>,
)

/**
 * Response containing an OAuth URL for redirect.
 */
@Serializable
data class AuthUrlResponse(
    val url: String,
    val state: String,
)

/**
 * Apple user information passed during OAuth callback.
 */
@Serializable
data class AppleUser(
    val email: String? = null,
    val name: AppleUserName? = null,
)

/**
 * Apple user name components.
 */
@Serializable
data class AppleUserName(
    @SerialName("firstName")
    val firstName: String? = null,
    @SerialName("lastName")
    val lastName: String? = null,
)
