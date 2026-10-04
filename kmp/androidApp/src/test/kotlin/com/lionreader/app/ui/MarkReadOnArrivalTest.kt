package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
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
        restoration.setContent { MarkReadOnArrival(reader, "a") {} }
        composeRule.waitUntil { read("a") }

        runBlocking { reader.setRead(listOf("a"), false) }
        restoration.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()

        assertFalse(read("a"))
    }

    @Test
    fun arrivingAtAReadEntryMovesItToTheTopOfRecentlyRead() {
        db.entryQueries.insertIgnore("a", "web", 0, 0, 1, 0)
        composeRule.setContent { MarkReadOnArrival(reader, "a") {} }
        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        val recentlyRead = runBlocking {
            reader
                .timeline(
                    ListScope.RecentlyRead,
                    unreadOnly = false,
                    oldestFirst = false,
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
        composeRule.setContent { MarkReadOnArrival(reader, shown.value) {} }
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
}
