package com.lionreader.shared.account

import app.cash.sqldelight.Query
import app.cash.sqldelight.Transacter
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlCursor
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlPreparedStatement
import kotlin.concurrent.Volatile
import kotlinx.coroutines.CancellationException

/**
 * A session's database, which can close under work still running on it: a list's flows stay
 * subscribed a few seconds after the screen goes, and a background sync may be committing. Once
 * closed, any use of it (or a failure caused by the closing) throws [CancellationException], which
 * the coroutine doing it takes as being cancelled rather than crashing the app.
 */
internal class SessionDriver(private val driver: SqlDriver) : SqlDriver {
    @Volatile private var closed = false

    private inline fun <T> open(block: () -> T): T {
        if (closed) throw SessionClosed()
        return try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (closed) throw SessionClosed(e) else throw e
        }
    }

    override fun <R> executeQuery(
        identifier: Int?,
        sql: String,
        mapper: (SqlCursor) -> QueryResult<R>,
        parameters: Int,
        binders: (SqlPreparedStatement.() -> Unit)?,
    ): QueryResult<R> = open { driver.executeQuery(identifier, sql, mapper, parameters, binders) }

    override fun execute(
        identifier: Int?,
        sql: String,
        parameters: Int,
        binders: (SqlPreparedStatement.() -> Unit)?,
    ): QueryResult<Long> = open { driver.execute(identifier, sql, parameters, binders) }

    override fun newTransaction(): QueryResult<Transacter.Transaction> = open {
        driver.newTransaction()
    }

    override fun currentTransaction(): Transacter.Transaction? = driver.currentTransaction()

    override fun addListener(vararg queryKeys: String, listener: Query.Listener) =
        driver.addListener(*queryKeys, listener = listener)

    override fun removeListener(vararg queryKeys: String, listener: Query.Listener) =
        driver.removeListener(*queryKeys, listener = listener)

    override fun notifyListeners(vararg queryKeys: String) = driver.notifyListeners(*queryKeys)

    override fun close() {
        closed = true
        driver.close()
    }
}

internal class SessionClosed(override val cause: Throwable? = null) :
    CancellationException("The account's session has ended")
