package com.lionreader.shared.narration

import com.lionreader.shared.settings.MarkReadOn
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class MarkReadWhenNarratedTest {
    private fun at(entryId: String, paragraph: Int, end: Boolean) =
        NarrationState(entryId, "Title", paragraph, playing = true, narratedToEnd = end)

    @Test
    fun withFinishedEachArticleIsMarkedAsNarrationReachesItsEnd() = runTest {
        val narration = MutableStateFlow<NarrationState?>(at("a", 0, end = false))
        val marked = mutableListOf<String>()
        val job =
            launch(UnconfinedTestDispatcher(testScheduler)) {
                markReadWhenNarrated(narration, { MarkReadOn.FINISHED }) { marked += it }
            }

        narration.value = at("a", 1, end = false)
        narration.value = at("a", 2, end = true)
        // Its closing cue is still the end: not again.
        narration.value = at("a", 3, end = true)
        narration.value = at("b", 0, end = false)
        narration.value = at("b", 1, end = true)
        // Back from its end, and to it again.
        narration.value = at("b", 0, end = false)
        narration.value = at("b", 1, end = true)
        narration.value = null

        assertEquals(listOf("a", "b", "b"), marked)
        job.cancel()
    }

    @Test
    fun otherwiseNarrationMarksNothing() = runTest {
        val narration = MutableStateFlow<NarrationState?>(null)
        val marked = mutableListOf<String>()
        for (setting in listOf(MarkReadOn.OPENED, MarkReadOn.NEVER)) {
            val job =
                launch(UnconfinedTestDispatcher(testScheduler)) {
                    markReadWhenNarrated(narration, { setting }) { marked += it }
                }
            narration.value = at("a", 2, end = true)
            narration.value = null
            job.cancel()
        }
        assertEquals(emptyList(), marked)
    }
}
