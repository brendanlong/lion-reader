package com.lionreader.app

import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.navigation3.runtime.NavBackStack
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class NavKeysTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun theBackStackSurvivesSavedStateRestoration() {
        val restoration = StateRestorationTester(composeRule)
        lateinit var backStack: NavBackStack<NavKey>
        restoration.setContent { backStack = rememberNavBackStack(HomeKey) }
        val opened = EntryKey.openedFrom("b", listOf("a", "b", "c"))
        composeRule.runOnIdle {
            backStack.add(opened)
            backStack.add(SettingsKey)
        }

        restoration.emulateSavedInstanceStateRestore()

        composeRule.runOnIdle {
            assertEquals(listOf(HomeKey, opened, SettingsKey), backStack.toList())
        }
    }

    @Test
    fun anArticleKeepsOnlyTheListAroundIt() {
        val list = (0 until 1_000).map { "id-$it" }

        val key = EntryKey.openedFrom("id-500", list)

        assertEquals(list.subList(500 - PAGE_REACH, 500 + PAGE_REACH + 1), key.listIds)
        assertEquals(list.take(PAGE_REACH + 1), EntryKey.openedFrom("id-0", list).listIds)
        assertEquals(listOf("gone"), EntryKey.openedFrom("gone", list).listIds)
    }
}
