package com.lionreader.shared.narration

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class NarrationCourseTest {
    private val opened = mutableListOf<String>()
    private val listed =
        object : NarrationList {
            val ids = listOf("a", "b", "c")

            override fun after(entryId: String) = ids.getOrNull(ids.indexOf(entryId) + 1)

            override fun open(entryId: String) {
                opened += entryId
            }
        }
    private val course = NarrationCourse { true }.also { it.list = listed }

    private fun at(entryId: String, paragraph: Int?) =
        NarrationState(entryId, "Title $entryId", paragraph, playing = true)

    // The rest of where narration goes is tested through the narrator (NarratorTest).

    @Test
    fun stoppingForgetsWhereItLeft() {
        course.follow(at("a", 3), "b")
        course.stopped()
        assertNull(course.follow(at("b", 0), "a"))
    }

    @Test
    fun anArticleWithNothingToSayFollowedToByTheReaderIsNotPassedOver() {
        course.goOnTo("b")
        course.started()
        course.follow(at("a", 0), "b")
        assertEquals(NarrationCourse.Silent.Stays, course.silent("b"))
        assertEquals(listOf("b"), opened)
    }

    @Test
    fun followingElsewhereEndsTheWayThroughTheList() {
        course.goOnTo("b")
        course.follow(at("a", 0), "c")
        assertEquals(NarrationCourse.Silent.Stays, course.silent("c"))
    }
}
