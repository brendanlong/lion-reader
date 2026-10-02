package com.lionreader.app.ui

import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class ShortNumberTest {
    private val locale = Locale.getDefault()

    @After
    fun restore() {
        Locale.setDefault(locale)
    }

    @Test
    fun dropsTrailingZerosInTheUsersLocale() {
        Locale.setDefault(Locale.US)
        assertEquals(listOf("1", "0.25", "1.5"), listOf(1f, 0.25f, 1.5f).map(::shortNumber))
        Locale.setDefault(Locale.GERMANY)
        assertEquals(
            listOf("1", "0,25", "2×"),
            listOf(shortNumber(1f), shortNumber(0.25f), speedLabel(2f)),
        )
    }
}
