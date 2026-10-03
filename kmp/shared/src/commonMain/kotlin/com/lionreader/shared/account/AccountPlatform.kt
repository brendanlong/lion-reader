package com.lionreader.shared.account

import app.cash.sqldelight.db.SqlDriver

/** Where the platform keeps accounts' data: a database file each, and what goes with it. */
interface AccountStorage {
    /** Opens [name]'s database (created with `AppSchema`), creating the file if need be. */
    fun openDatabase(name: String): SqlDriver

    /** Deletes [name]'s database and the rest of its account's data (cached audio). */
    fun delete(name: String)

    /**
     * Deletes every account's data but [keep]'s: left by a sign-out or switch the app didn't live
     * to finish.
     */
    fun deleteAllBut(keep: String?)
}

/**
 * The platform's background jobs ([runBackgroundSync] does their work). Each waits for a network
 * and retries with backoff, so changes made offline go out once the device reconnects.
 */
interface BackgroundSync {
    /** Sends the outbox soon; one already running finishes, and another sends what's left. */
    fun flushSoon()

    /** A full sync, article bodies included, soon. */
    fun syncNow()

    /** The periodic full sync, if it isn't scheduled already. */
    fun schedulePeriodic()

    fun cancelAll()
}
