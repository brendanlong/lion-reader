package com.lionreader.app.ui

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.ArticleState
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class ArticlePrefetchTest {
    private val db =
        LionReaderDatabase(
            AndroidSqliteDriver(AppSchema, ApplicationProvider.getApplicationContext(), null)
        )
    private val reader = Reader(db, { 1_000L }, Dispatchers.Unconfined) {}
    private val prefetch = ArticlePrefetch(reader, CoroutineScope(Dispatchers.Unconfined))

    @Test
    fun aPressReadsTheArticleForItsPageOnce() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 0, 0)

        prefetch.press("a")

        assertNull(prefetch.take("b"))
        assertEquals("a", (prefetch.take("a") as ArticleState.Shown).entry?.id)
        assertNull(prefetch.take("a"))
    }

    @Test
    fun eachPressReplacesTheLast() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 0, 0)
        db.entryQueries.insertIgnore("b", "web", 0, 0, 0, 0)

        prefetch.press("a")
        prefetch.press("b")

        assertNull(prefetch.take("a"))
        assertEquals("b", (prefetch.take("b") as ArticleState.Shown).entry?.id)
    }
}
