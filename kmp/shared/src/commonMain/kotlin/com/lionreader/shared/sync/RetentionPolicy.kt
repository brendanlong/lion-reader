package com.lionreader.shared.sync

/**
 * How much the offline store keeps. Starred and saved entries, collections' articles, and ones with
 * unsent changes are always kept, and an entry whose read state changed within the window counts as
 * in it however old it is (Recently Read).
 */
data class RetentionPolicy(
    /** Entries older than this (by publish time) are dropped. */
    val windowDays: Int = 30,
    /** At most this many read entries are kept, newest first. */
    val maxReadEntries: Int = 2000,
    /** Article bodies beyond this total are dropped, oldest read first. */
    val contentBudgetBytes: Long = 100L * 1024 * 1024,
    /** Caps each list the first download pulls (all, starred, saved). */
    val bootstrapMaxEntries: Int = 1000,
) {
    val windowMillis: Long
        get() = windowDays * 24L * 60 * 60 * 1000
}
