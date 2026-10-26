package com.lionreader.shared.data

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlCursor
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlPreparedStatement
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.db.LionReaderDatabase
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

class ArticleStateTest {
    /**
     * Throws [failure] from every query while it's set, as Android does for an oversized row, and
     * counts the queries reading a body.
     */
    private class FailingDriver(private val driver: SqlDriver) : SqlDriver by driver {
        var failure: Exception? = null
        var bodyReads = 0

        override fun <R> executeQuery(
            identifier: Int?,
            sql: String,
            mapper: (SqlCursor) -> QueryResult<R>,
            parameters: Int,
            binders: (SqlPreparedStatement.() -> Unit)?,
        ): QueryResult<R> {
            failure?.let { throw it }
            if (sql.contains("SELECT content")) bodyReads++
            return driver.executeQuery(identifier, sql, mapper, parameters, binders)
        }
    }

    private val driver =
        FailingDriver(JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also { AppSchema.create(it) })
    private val db = LionReaderDatabase(driver)
    private val reader = Reader(db, { 0L }, Dispatchers.Unconfined) {}

    @AfterTest fun close() = driver.close()

    @Test
    fun anArticleThatCantBeReadSaysSoRatherThanThrowing() {
        driver.failure = IllegalStateException("Row too big to fit into CursorWindow")

        assertEquals(ArticleState.Unreadable, runBlocking { reader.article("a").first() })
    }

    @Test
    fun anArticleNotOnTheDeviceIsShownAsGone() {
        assertEquals(ArticleState.Shown(null), runBlocking { reader.article("a").first() })
    }

    /** The session closing under the page cancels it, as everywhere else (SessionDriver). */
    @Test
    fun aCancellationStillCancels() {
        driver.failure = CancellationException("The account's session has ended")

        assertFailsWith<CancellationException> { runBlocking { reader.article("a").first() } }
    }

    @Test
    fun aBodyArrivingWhileOpenShowsAndIsntReadAgainOnLaterChanges() = runBlocking {
        db.entryQueries.insertIgnore("a", "web", 0L, 0L, 0L, 0L)
        val shown = mutableListOf<String?>()
        val page =
            launch(Dispatchers.Unconfined) { reader.entry("a").collect { shown += it?.content } }

        db.bodyQueries.put("a", "<p>Body</p>", 11L, 0L, "Body", 1L)
        assertEquals("<p>Body</p>", shown.last())
        val reads = driver.bodyReads
        reader.setRead(listOf("a"), true)
        reader.setStarred("a", true)
        db.bodyQueries.put("a", "<p>Edited</p>", 13L, 0L, "Edited", 2L)

        assertEquals(reads, driver.bodyReads)
        assertEquals("<p>Body</p>", shown.last())
        page.cancel()
    }
}
