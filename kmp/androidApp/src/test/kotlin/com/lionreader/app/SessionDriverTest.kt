package com.lionreader.app

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import java.util.Collections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(application = Application::class)
class SessionDriverTest {
    private val driver =
        SessionDriver(
            AndroidSqliteDriver(AppSchema, ApplicationProvider.getApplicationContext(), null)
        )
    private val reader = Reader(LionReaderDatabase(driver), { 0L }, Dispatchers.IO) {}

    @Test
    fun aClosedSessionsDatabaseCancelsWhatUsesIt() {
        runBlocking { reader.setStarred("entry", true) }

        driver.close()

        assertThrows(CancellationException::class.java) {
            runBlocking { reader.setStarred("entry", false) }
        }
        assertThrows(CancellationException::class.java) {
            runBlocking { reader.unreadIds(ListScope.All) }
        }
    }

    /** What a screen or a sync still has running when the session ends doesn't crash the app. */
    @Test
    fun workStillRunningEndsQuietly() {
        val crashes = Collections.synchronizedList(mutableListOf<Throwable>())
        val scope =
            CoroutineScope(
                SupervisorJob() +
                    Dispatchers.IO +
                    CoroutineExceptionHandler { _, e -> crashes += e }
            )
        val unread =
            reader
                .timeline(ListScope.All, true, emptySet(), 50)
                .stateIn(
                    scope,
                    SharingStarted.Eagerly,
                    null,
                )
        runBlocking { unread.first { it != null } }

        driver.close()
        // A commit that landed just before: the list queries again.
        driver.notifyListeners("entry", "outbox_state", "entry_body", "subscription")
        val write = scope.launch { reader.setRead(listOf("entry"), true) }
        runBlocking {
            write.join()
            delay(200)
        }

        assertTrue(write.isCancelled)
        assertEquals(emptyList<Throwable>(), crashes)
    }
}
