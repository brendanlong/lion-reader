package com.lionreader.app

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Serializable so the back stack survives rotation and process death
// (rememberNavBackStack keeps it in saved state).

@Serializable internal data object HomeKey : NavKey

/** An article opened from a list, and that list's order at the time (for paging). */
@Serializable
internal data class EntryKey(
    val id: String,
    val listIds: List<String>,
    /** SPIKE: tells each opening apart, even of the same article. */
    val opening: Long = 0,
) : NavKey {
    companion object {
        /**
         * Opened from [list]: only the ids within [PAGE_REACH] of it, which bounds the key's size
         * in saved state (a long-scrolled list can hold thousands).
         */
        fun openedFrom(id: String, list: List<String>): EntryKey {
            val at = list.indexOf(id)
            val opening = System.nanoTime()
            if (at < 0) return EntryKey(id, listOf(id), opening)
            val from = maxOf(0, at - PAGE_REACH)
            return EntryKey(
                id,
                list.subList(from, minOf(list.size, at + PAGE_REACH + 1)).toList(),
                opening,
            )
        }
    }
}

@Serializable internal data object SettingsKey : NavKey

internal const val PAGE_REACH = 100
