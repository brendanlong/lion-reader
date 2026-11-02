package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.ListSort
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.settings.MarkReadOn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class MarkReadOnArrivalTest {
    @get:Rule val composeRule = createComposeRule()

    private val db =
        LionReaderDatabase(
            AndroidSqliteDriver(
                AppSchema,
                ApplicationProvider.getApplicationContext(),
                null,
            )
        )
    private val reader = Reader(db, { 1_000L }, Dispatchers.Unconfined) {}

    private fun read(id: String) = runBlocking { reader.entry(id).first()!!.read }

    @Test
    fun anEntryMarkedUnreadStaysUnreadWhenTheScreenIsRestored() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 0, 0)
        val restoration = StateRestorationTester(composeRule)
        restoration.setContent {
            MarkReadOnArrival(reader, "a", MarkReadOn.OPENED, finished = false) {}
        }
        composeRule.waitUntil { read("a") }

        runBlocking { reader.setRead(listOf("a"), false) }
        restoration.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()

        assertFalse(read("a"))
    }

    @Test
    fun arrivingAtAReadEntryMovesItToTheTopOfRecentlyRead() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 1, 0)
        composeRule.setContent {
            MarkReadOnArrival(reader, "a", MarkReadOn.OPENED, finished = false) {}
        }
        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        val recentlyRead = runBlocking {
            reader
                .timeline(
                    ListScope.RecentlyRead,
                    unreadOnly = false,
                    sort = ListSort.NEWEST,
                    emptySet(),
                    10,
                )
                .first()
        }
        assertEquals(listOf("a"), recentlyRead.map { it.id })
    }

    @Test
    fun arrivingAgainMarksReadAgain() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 0, 0)
        db.entryQueries.insertIgnore("b", "web", 0, 0, 0, 0)
        val shown = mutableStateOf("a")
        composeRule.setContent {
            MarkReadOnArrival(reader, shown.value, MarkReadOn.OPENED, finished = false) {}
        }
        composeRule.waitUntil { read("a") }
        runBlocking { reader.setRead(listOf("a"), false) }

        shown.value = "b"
        composeRule.waitForIdle()
        composeRule.waitUntil { read("b") }
        shown.value = "a"
        composeRule.waitForIdle()
        composeRule.waitUntil { read("a") }
        assertTrue(read("a"))
    }

    @Test
    fun withFinishedItsMarkedReadOnceItsEndIsShownAndOnlyOnce() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 0, 0)
        val finished = mutableStateOf(false)
        composeRule.setContent {
            MarkReadOnArrival(reader, "a", MarkReadOn.FINISHED, finished.value) {}
        }
        composeRule.waitForIdle()
        assertFalse(read("a"))

        finished.value = true
        composeRule.waitForIdle()
        composeRule.waitUntil { read("a") }

        // Marked unread, it stays unread as the end comes back on screen.
        runBlocking { reader.setRead(listOf("a"), false) }
        finished.value = false
        composeRule.waitForIdle()
        finished.value = true
        composeRule.waitForIdle()
        assertFalse(read("a"))
    }

    @Test
    fun withNeverItsNotMarkedRead() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 0, 0)
        composeRule.setContent {
            MarkReadOnArrival(reader, "a", MarkReadOn.NEVER, finished = true) {}
        }
        composeRule.waitForIdle()
        assertFalse(read("a"))
        assertEquals(0L, db.outboxQueries.countStates().executeAsOne())
    }
}
