package com.lionreader.shared.sync

/** How much the offline store keeps. Starred and saved entries are always kept. */
data class RetentionPolicy(
    /** Entries older than this (by publish time) are dropped. */
    val windowDays: Int = 30,
    /** Beyond this many entries, the oldest read ones are dropped. */
    val maxEntries: Int = 3000,
    /** Article bodies beyond this total are dropped, oldest read first. */
    val contentBudgetBytes: Long = 100L * 1024 * 1024,
    /** Caps each list the first download pulls (all, starred, saved). */
    val bootstrapMaxEntries: Int = 1000,
) {
    val windowMillis: Long
        get() = windowDays * 24L * 60 * 60 * 1000
}
