package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Entity representing a tag for organizing subscriptions.
 *
 * Tags allow users to group and filter feeds by category.
 * Each tag can have an optional color for visual distinction.
 */
@Entity(tableName = "tags")
data class TagEntity(
    @PrimaryKey
    val id: String,
    val name: String,
    /** Hex color string, e.g., "#ff6b6b" */
    val color: String?,
    /** Number of subscriptions with this tag */
    val feedCount: Int,
)
