package com.lionreader.app.ui

import android.os.Looper
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.app.AppSettings
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class HomeScreenTest {
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
    private val settings = MutableStateFlow(AppSettings())

    private fun seed(
        id: String,
        title: String,
        read: Boolean,
        sortAt: Long = 0,
        feed: String = "feed",
        subscription: String? = null,
        starred: Boolean = false,
    ) {
        val starredFlag = if (starred) 1L else 0L
        db.entryQueries.insertIgnore(id, feed, "web", 0, sortAt, if (read) 1 else 0, starredFlag)
        db.entryQueries.updateAll(
            subscription,
            feed,
            "web",
            null,
            title,
            null,
            null,
            null,
            "Example Feed",
            null,
            0,
            sortAt,
            if (read) 1 else 0,
            starredFlag,
            id,
        )
    }

    private lateinit var model: HomeViewModel

    private fun SemanticsNodeInteraction.state(): String? =
        fetchSemanticsNode().config.getOrElseNullable(SemanticsProperties.StateDescription) { null }

    private fun SemanticsNodeInteraction.isShownAs(state: String) =
        fetchSemanticsNode().config.getOrElseNullable(SemanticsProperties.StateDescription) {
            null
        } == state

    private fun show(showSelection: Boolean = false) {
        model =
            HomeViewModel(
                reader,
                settings,
                { settings.value = it(settings.value) },
                sync = {},
            )
        composeRule.setContent {
            HomeScreen(model, onOpen = {}, onSettings = {}, showSelection = showSelection)
        }
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
    fun searchFindsArticlesReadOrNotAndBackLeavesIt() {
        seed("a", "Borrow checker tips", read = true)
        seed("b", "Gardening", read = false)
        show()

        composeRule.onNodeWithContentDescription("Search").performClick()
        composeRule.onNodeWithText("Search articles").performTextInput("borr")
        // Past the typing debounce.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Borrow checker tips").assertIsDisplayed()
        composeRule.onNodeWithText("Gardening").assertDoesNotExist()
        assertEquals(listOf("a"), model.shownIds())

        Espresso.closeSoftKeyboard()
        Espresso.pressBack()
        composeRule.onNodeWithText("Gardening").assertIsDisplayed()
        composeRule.onNodeWithText("Borrow checker tips").assertDoesNotExist()
    }

    @Test
    fun searchingKeepsTheTimelinesPlace() {
        // Seeded oldest first, so "Article 0" tops the newest-first list.
        (59 downTo 0).forEach { seed("e$it", "Article $it", read = false, sortAt = 60L - it) }
        show()
        // The (closed) drawer's list scrolls too.
        val timeline =
            SemanticsMatcher("the timeline") {
                it.config
                    .getOrElseNullable(SemanticsProperties.CollectionInfo) { null }
                    ?.rowCount == 60
            }
        composeRule.onNode(hasScrollToIndexAction() and timeline).performScrollToIndex(40)
        composeRule.onNodeWithText("Article 40").assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Search").performClick()
        composeRule.onNodeWithContentDescription("Close search").performClick()

        composeRule.onNodeWithText("Article 40").assertIsDisplayed()
        composeRule.onNodeWithText("Article 0").assertDoesNotExist()
    }

    @Test
    fun theArticleBesideTheListIsSelectedUntilClosed() {
        seed("a", "First", read = false)
        seed("b", "Second", read = false)
        show(showSelection = true)

        model.opened("b")
        composeRule.onNode(hasText("Second", substring = true) and isSelected()).assertExists()
        composeRule.onNode(hasText("First", substring = true) and isSelected()).assertDoesNotExist()

        model.shownClosed()
        composeRule
            .onNode(hasText("Second", substring = true) and isSelected())
            .assertDoesNotExist()
    }

    @Test
    fun theStarButtonStillWorksByTouch() {
        seed("a", "An article", read = false)
        show()

        // The star is the top of the two buttons at the row's end.
        composeRule.onNodeWithText("An article", substring = true).performTouchInput {
            click(Offset(right - 22.dp.toPx(), top + 22.dp.toPx()))
        }

        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        composeRule
            .onNodeWithText("An article", substring = true)
            .assert(hasStateDescription("Unread, Starred"))
    }

    @Test
    fun aSwitchToAnEmptyListFromAnEmptyListIsSeenToLoad() {
        show()
        composeRule.waitUntil { model.items.value != null }
        var loaded = false
        var waitedForTheOpenList = true
        // Starred and Saved are both empty: the entries don't change, the list does.
        model.select(ListScope.Starred)
        model.viewModelScope.launch {
            model.awaitLoaded(ListScope.Starred)
            model.select(ListScope.Saved)
            model.awaitLoaded(ListScope.Saved)
            // Already there: no wait.
            model.select(ListScope.Saved)
            waitedForTheOpenList = model.awaitLoaded(ListScope.Saved)
            loaded = true
        }
        composeRule.waitUntil(timeoutMillis = 2_000) {
            shadowOf(Looper.getMainLooper()).idle()
            loaded
        }
        assertFalse(waitedForTheOpenList)
    }

    @Test
    fun backClosesTheDrawer() {
        show()
        composeRule.onNodeWithContentDescription("Lists").performClick()
        composeRule.onNodeWithText("Settings").assertIsDisplayed()

        Espresso.pressBack()

        composeRule.onNodeWithText("Settings").assertIsNotDisplayed()
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

        composeRule
            .onNodeWithText("An article", substring = true)
            .performCustomAccessibilityActionWithLabel("Star")

        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        composeRule
            .onNodeWithText("An article", substring = true)
            .assert(hasStateDescription("Unread, Starred"))
            .performCustomAccessibilityActionWithLabel("Unstar")
        composeRule
            .onNodeWithText("An article", substring = true)
            .assert(hasStateDescription("Unread"))
        // The row is the one stop: its buttons aren't separate ones.
        composeRule.onNodeWithContentDescription("Star").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Mark read").assertDoesNotExist()
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

        composeRule
            .onNodeWithText("An article", substring = true)
            .performCustomAccessibilityActionWithLabel("Mark read")

        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        composeRule
            .onNodeWithText("An article", substring = true)
            .assert(hasStateDescription("Read"))
        // Still listed: entries touched in this list stay until it's reloaded.
        composeRule.onNodeWithText("An article").assertIsDisplayed()
    }

    @Test
    fun pullingToRefreshLetsGoOfReadArticles() {
        seed("a", "An article", read = false)
        show()
        composeRule
            .onNodeWithText("An article", substring = true)
            .performCustomAccessibilityActionWithLabel("Mark read")
        composeRule.waitUntil { db.outboxQueries.countStates().executeAsOne() == 1L }
        composeRule.onNodeWithText("An article").assertIsDisplayed()

        model.pullToRefresh()
        composeRule.waitUntil {
            composeRule.onAllNodesWithText("An article").fetchSemanticsNodes().isEmpty()
        }
    }

    @Test
    fun swipingRightTogglesReadAndLeftStars() {
        seed("a", "An article", read = false)
        show()
        val row = composeRule.onNodeWithText("An article", substring = true)

        row.performTouchInput { swipeRight() }
        composeRule.waitUntil { row.isShownAs("Read") }
        row.performTouchInput { swipeLeft() }
        composeRule.waitUntil { row.isShownAs("Read, Starred") }
        // Each swipe toggles from where the row is now.
        row.performTouchInput { swipeRight() }
        composeRule.waitUntil { row.isShownAs("Unread, Starred") }
        row.performTouchInput { swipeLeft() }
        composeRule.waitUntil { row.isShownAs("Unread") }
    }

    @Test
    fun emptyFeedsCanBeLeftOutOfTheDrawer() {
        for ((id, feed, title) in
            listOf(
                Triple("busy", "feed-1", "Busy Feed"),
                Triple("quiet", "feed-2", "Quiet Feed"),
            )) {
            db.subscriptionQueries.upsertSubscription(
                id,
                feed,
                "web",
                title,
                "https://e.com/$id",
                null,
                0,
            )
        }
        seed("a", "An article", read = false, feed = "feed-1", subscription = "busy")
        seed("b", "Old news", read = true, feed = "feed-2", subscription = "quiet")
        show()

        composeRule.onNodeWithContentDescription("Lists").performClick()
        composeRule.onNodeWithText("Quiet Feed").assertIsDisplayed()

        settings.value = settings.value.copy(hideEmptyLists = true)
        composeRule.waitUntil {
            composeRule.onAllNodesWithText("Quiet Feed").fetchSemanticsNodes().isEmpty()
        }
        composeRule.onNodeWithText("Busy Feed").assertIsDisplayed()
    }

    @Test
    fun theOpenListStaysInTheDrawerWhenEmpty() {
        db.subscriptionQueries.upsertSubscription(
            "quiet",
            "feed-2",
            "web",
            "Quiet Feed",
            "https://e.com/quiet",
            null,
            0,
        )
        db.subscriptionQueries.insertTagIgnore("tag", "News", null)
        db.subscriptionQueries.addSubscriptionTag("quiet", "tag")
        seed("b", "Old news", read = true, feed = "feed-2", subscription = "quiet")
        settings.value = settings.value.copy(hideEmptyLists = true)
        show()
        model.select(ListScope.Subscription("quiet"))

        composeRule.onNodeWithContentDescription("Lists").performClick()
        // The open feed, and its tag (expanded to show it).
        composeRule.onNodeWithText("News").assertIsDisplayed()
        // The top bar's title and the drawer's row.
        composeRule.onAllNodesWithText("Quiet Feed").assertCountEquals(2)

        model.select(ListScope.All)
        composeRule.waitUntil {
            composeRule.onAllNodesWithText("News").fetchSemanticsNodes().isEmpty()
        }
    }

    @Test
    fun aSwipeActsOnlyOnLettingGo() {
        seed("a", "An article", read = false)
        show()
        val row = composeRule.onNodeWithText("An article", substring = true)

        // All the way over and back again.
        row.performTouchInput {
            down(centerLeft + Offset(10f, 0f))
            moveTo(center.copy(x = right * 0.95f))
            moveTo(centerLeft + Offset(30f, 0f))
            up()
        }
        composeRule.waitForIdle()
        assertEquals("Unread", row.state())

        // Far across: nothing until letting go.
        row.performTouchInput {
            down(centerLeft + Offset(10f, 0f))
            moveTo(center.copy(x = right * 0.9f))
        }
        composeRule.waitForIdle()
        assertEquals("Unread", row.state())
        row.performTouchInput { up() }
        composeRule.waitUntil { row.isShownAs("Read") }
    }

    @Test
    fun aQuickShortFlickCounts() {
        seed("a", "An article", read = false)
        show()
        val row = composeRule.onNodeWithText("An article", substring = true)

        row.performTouchInput {
            swipeRight(startX = left + 10f, endX = right * 0.3f, durationMillis = 40)
        }
        composeRule.waitUntil { row.isShownAs("Read") }
    }

    @Test
    fun unstarringInStarredKeepsTheArticleUntilRefreshed() {
        seed("a", "A starred article", read = true, starred = true)
        settings.value = settings.value.copy(unreadOnly = false)
        show()
        model.select(ListScope.Starred)
        val row = composeRule.onNodeWithText("A starred article", substring = true)
        composeRule.waitUntil { row.isShownAs("Read, Starred") }

        row.performTouchInput { swipeLeft() }
        composeRule.waitUntil { row.isShownAs("Read") }
        row.assertIsDisplayed()

        model.pullToRefresh()
        composeRule.waitUntil {
            composeRule.onAllNodesWithText("A starred article").fetchSemanticsNodes().isEmpty()
        }
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
