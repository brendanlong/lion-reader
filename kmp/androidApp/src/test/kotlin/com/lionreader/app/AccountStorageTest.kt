package com.lionreader.app

import android.app.Application
import android.database.sqlite.SQLiteBlobTooBigException
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(application = Application::class)
class AccountStorageTest {
    private val context: Application = ApplicationProvider.getApplicationContext()

    /** Bigger than Android's default cursor window (2 MB). */
    private val body = "<p>" + "x".repeat(3 * 1024 * 1024) + "</p>"

    private fun SqlDriver.withLargeArticle(): Reader {
        execute(
            null,
            "INSERT INTO entry(id, feed_id, type, fetched_at, sort_at, read, starred, body_version) " +
                "VALUES ('a', 'f', 'web', 0, 0, 0, 0, 1)",
            0,
        )
        execute(
            null,
            "INSERT INTO entry_body(entry_id, content, size, downloaded_at, search_text) " +
                "VALUES ('a', ?, 0, 0, '')",
            1,
        ) {
            bindString(0, body)
        }
        return Reader(LionReaderDatabase(this), { 0L }, Dispatchers.IO) {}
    }

    @Test
    fun anArticleBiggerThanTheDefaultCursorWindowOpens() {
        val reader = AndroidAccountStorage(context).openDatabase("big.db").withLargeArticle()

        assertEquals(body, runBlocking { reader.entry("a").first()?.content })
    }

    /** What the window size is for: without it, the same article can't be read. */
    @Test
    fun withTheDefaultWindowItCant() {
        val reader = AndroidSqliteDriver(AppSchema, context, "default.db").withLargeArticle()

        assertThrows(SQLiteBlobTooBigException::class.java) {
            runBlocking { reader.entry("a").first() }
        }
    }
}
