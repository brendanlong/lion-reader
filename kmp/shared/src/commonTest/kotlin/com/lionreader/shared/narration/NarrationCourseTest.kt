package com.lionreader.shared.narration

import com.lionreader.shared.api.NarrationCues
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NarrationCourseTest {
    private var goesOn = true
    private val opened = mutableListOf<String>()
    private val listed =
        object : NarrationList {
            val ids = listOf("a", "b", "c")

            override fun after(entryId: String) = ids.getOrNull(ids.indexOf(entryId) + 1)

            override fun open(entryId: String) {
                opened += entryId
            }
        }
    private val course = NarrationCourse { goesOn }.also { it.list = listed }

    private fun at(entryId: String, paragraph: Int?) =
        NarrationState(entryId, "Title $entryId", paragraph, playing = true)

    @Test
    fun followingBackResumesWhereItLeft() {
        assertNull(course.follow(at("a", 3), "b"))
        // Passed through without a place: "a"'s is still the one remembered.
        assertNull(course.follow(at("b", null), "c"))
        assertEquals(3, course.follow(at("c", null), "a"))
    }

    @Test
    fun aFinishedArticleStartsAgain() {
        course.follow(at("a", 3), "b")
        course.follow(at("b", null), "a")
        assertTrue(course.finished("a"))
        assertNull(course.follow(at("a", null), "b"))
        assertNull(course.follow(at("b", null), "a"))
    }

    @Test
    fun stoppingForgetsWhereItLeft() {
        course.follow(at("a", 3), "b")
        course.stopped()
        assertNull(course.follow(at("b", 0), "a"))
    }

    @Test
    fun theClosingSaysWhatComesNext() {
        assertEquals(listOf(NarrationCues.NEXT_ARTICLE), course.closing("b"))
        assertEquals(listOf(NarrationCues.NO_MORE_ARTICLES), course.closing("c"))
        goesOn = false
        assertEquals(emptyList(), course.closing("b"))
    }

    @Test
    fun aFinishedArticleGoesOnToTheNextOrStops() {
        assertTrue(course.finished("a"))
        assertEquals(listOf("b"), opened)
        assertFalse(course.finished("c"))
        goesOn = false
        assertFalse(course.finished("a"))
        assertEquals(listOf("b"), opened)
    }

    @Test
    fun anArticleWithNothingToSayIsPassedOverOnlyOnTheWayThroughTheList() {
        course.finished("a")
        course.follow(at("a", 0), "b")
        assertEquals(NarrationCourse.Silent.GoneOn, course.silent("b"))
        assertEquals(listOf("b", "c"), opened)
        course.follow(at("b", null), "c")
        assertEquals(NarrationCourse.Silent.Ended, course.silent("c"))

        // Followed to by the reader, not gone on to.
        course.started()
        course.follow(at("a", 0), "b")
        assertEquals(NarrationCourse.Silent.Stays, course.silent("b"))
    }

    @Test
    fun followingElsewhereEndsTheWayThroughTheList() {
        course.finished("a")
        course.follow(at("a", 0), "c")
        assertEquals(NarrationCourse.Silent.Stays, course.silent("c"))
    }
}
