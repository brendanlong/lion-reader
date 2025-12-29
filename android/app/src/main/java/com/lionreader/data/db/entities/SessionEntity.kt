package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Entity representing a user session.
 *
 * Stores authentication tokens and user information for the logged-in user.
 * Only one active session should exist at a time.
 */
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey
    val token: String,
    val userId: String,
    val email: String,
    val createdAt: Long,
    val expiresAt: Long?,
)
