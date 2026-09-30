package com.lionreader.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.app.AppSettings
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class HomeScreenTest {
    @get:Rule val composeRule = createComposeRule()

    private val db =
        LionReaderDatabase(
            AndroidSqliteDriver(
                LionReaderDatabase.Schema,
                ApplicationProvider.getApplicationContext(),
                null,
            )
        )
    private val reader = Reader(db, { 1_000L }, Dispatchers.Unconfined) {}
    private val settings = MutableStateFlow(AppSettings())

    private fun seed(id: String, title: String, read: Boolean) {
        db.entryQueries.insertIgnore(id, "feed", "web", 0, 0, if (read) 1 else 0, 0)
        db.entryQueries.updateAll(
            null,
            "feed",
            "web",
            null,
            title,
            null,
            null,
            null,
            "Example Feed",
            null,
            0,
            0,
            if (read) 1 else 0,
            0,
            id,
        )
    }

    private lateinit var model: HomeViewModel

    private fun show() {
        model = HomeViewModel(reader, settings, { settings.value = it(settings.value) }) {}
        composeRule.setContent { HomeScreen(model, onOpen = {}, onSettings = {}) }
    }

    @Test
    fun unreadOnlyHidesReadArticlesUntilToggled() {
        seed("a", "Unread article", read = false)
        seed("b", "Read article", read = true)
        show()

        composeRule.onNodeWithText("Unread article").assertIsDisplayed()
        composeRule.onNodeWithText("Read article").assertDoesNotExist()

        composeRule.onNodeWithContentDescription("List options").performClick()
        composeRule.onNodeWithText("Show read articles").performClick()
        composeRule.waitUntil { !settings.value.unreadOnly }
        composeRule.onNodeWithText("Read article").assertIsDisplayed()
    }

    @Test
    fun tagsStartCollapsedAndExpandOnTap() {
        db.subscriptionQueries.upsertSubscription(
            "sub",
            "feed",
            "web",
            "Nested Feed",
            "https://example.com/feed",
            null,
            0,
        )
        db.subscriptionQueries.insertTagIgnore("tag", "News", null)
        db.subscriptionQueries.addSubscriptionTag("sub", "tag")
        db.subscriptionQueries.insertTagIgnore("empty", "Empty Tag", null)
        show()

        composeRule.onNodeWithContentDescription("Lists").performClick()
        composeRule.onNodeWithText("News").assertIsDisplayed()
        composeRule.onNodeWithText("Nested Feed").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Expand Empty Tag").assertDoesNotExist()

        composeRule.onNodeWithContentDescription("Expand News").performClick()
        composeRule.waitUntil { "tag" in settings.value.expandedTags }
        composeRule.onNodeWithText("Nested Feed").assertIsDisplayed()
        // Expanding doesn't also open the tag's list.
        assertEquals(ListScope.All, model.scope.value)

        composeRule.onNodeWithContentDescription("Collapse News").performClick()
        composeRule.waitUntil { settings.value.expandedTags.isEmpty() }
        composeRule.onNodeWithText("Nested Feed").assertDoesNotExist()
    }

    @Test
    fun starringRecordsAnUnsentChange() {
        seed("a", "An article", read = false)
        show()

        composeRule.onNodeWithContentDescription("Star").performClick()

        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        composeRule.onNodeWithContentDescription("Unstar").assertIsDisplayed()
    }

    @Test
    fun markAllReadAsksFirstAndMarksOnlyOnConfirmation() {
        seed("a", "One", read = false)
        seed("b", "Two", read = false)
        show()

        composeRule.onNodeWithContentDescription("List options").performClick()
        composeRule.onNodeWithText("Mark all as read…").performClick()
        composeRule.onNodeWithText("Mark 2 articles in All as read?").assertIsDisplayed()
        composeRule.onNodeWithText("Cancel").performClick()
        assertEquals(0L, db.outboxQueries.countStates().executeAsOne())

        composeRule.onNodeWithContentDescription("List options").performClick()
        composeRule.onNodeWithText("Mark all as read…").performClick()
        composeRule.onNodeWithText("Mark read").performClick()
        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 2L }
    }

    @Test
    fun theReadToggleOnARowRecordsAnUnsentChange() {
        seed("a", "An article", read = false)
        show()

        composeRule.onNodeWithContentDescription("Mark read").performClick()

        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        // Still listed: entries touched in this list stay until it's reloaded.
        composeRule.onNodeWithText("An article").assertIsDisplayed()
    }

    @Test
    fun feedsWithoutATagGroupUnderUncategorized() {
        db.subscriptionQueries.upsertSubscription(
            "tagged",
            "feed-1",
            "web",
            "Tagged Feed",
            "https://example.com/1",
            null,
            0,
        )
        db.subscriptionQueries.upsertSubscription(
            "loose",
            "feed-2",
            "web",
            "Loose Feed",
            "https://example.com/2",
            null,
            0,
        )
        db.subscriptionQueries.insertTagIgnore("tag", "News", null)
        db.subscriptionQueries.addSubscriptionTag("tagged", "tag")
        show()

        composeRule.onNodeWithContentDescription("Lists").performClick()
        composeRule.onNodeWithText("Loose Feed").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Expand Uncategorized").performClick()
        composeRule.waitUntil { "uncategorized" in settings.value.expandedTags }
        composeRule.onNodeWithText("Loose Feed").assertIsDisplayed()
        composeRule.onNodeWithText("Tagged Feed").assertDoesNotExist()

        composeRule.onNodeWithText("Uncategorized").performClick()
        assertEquals(ListScope.Uncategorized, model.scope.value)
    }
}
