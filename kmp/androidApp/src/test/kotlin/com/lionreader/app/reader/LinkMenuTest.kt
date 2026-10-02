package com.lionreader.app.reader

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import com.lionreader.app.share.SaveWorker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests set up themselves.
@Config(application = android.app.Application::class)
class LinkMenuTest {
    @get:Rule val composeRule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val url = "https://example.com/story"
    private var dismissed = false

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
        )
        composeRule.setContent { LinkMenu(LinkPress(url, 10f, 10f)) { dismissed = true } }
    }

    @Test
    fun showsWhereTheLinkGoesThenOpenSaveShareCopy() {
        composeRule.onNodeWithText(url).assertExists()
        val labels = listOf("Open", "Save", "Share", "Copy link")
        val tops = labels.map {
            composeRule.onAllNodesWithText(it).fetchSemanticsNodes().single().boundsInRoot.top
        }
        assertEquals(tops.sorted(), tops)
    }

    @Test
    fun savingQueuesTheSameJobAsSharingALinkToTheApp() {
        composeRule.onNodeWithText("Save").performClick()

        val work =
            WorkManager.getInstance(context)
                .getWorkInfosForUniqueWork(SaveWorker.workName(url))
                .get()
        assertEquals(1, work.size)
        assertTrue(dismissed)
    }

    @Test
    fun copyingPutsTheLinkOnTheClipboard() {
        composeRule.onNodeWithText("Copy link").performClick()

        val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
        assertEquals(url, clip?.getItemAt(0)?.text)
        assertTrue(dismissed)
    }
}

class LinkTargetTest {
    @Test
    fun onlyWebPagesOutsideTheArticle() {
        assertEquals("https://example.com/a", linkTarget(" https://example.com/a "))
        assertEquals("http://example.com/", linkTarget("http://example.com/"))
        assertNull(linkTarget("mailto:someone@example.com"))
        assertNull(linkTarget("javascript:alert(1)"))
        // A relative link resolves against the reader's own origin.
        assertNull(linkTarget("$ASSET_ORIGIN/notes#1"))
        assertNull(linkTarget(null))
    }
}
