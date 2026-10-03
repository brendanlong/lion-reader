package com.lionreader.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.lionreader.shared.settings.ThemeChoice

// The web's tokens (src/app/globals.css): amber accent, zinc neutrals.
private val Amber700 = Color(0xFFB45309)
private val Amber500 = Color(0xFFF59E0B)
private val Amber800 = Color(0xFF92400E)
private val Zinc900 = Color(0xFF18181B)
private val Zinc800 = Color(0xFF27272A)
private val Zinc100 = Color(0xFFF4F4F5)

private val LightColors =
    lightColorScheme(
        primary = Amber700,
        onPrimary = Color.White,
        secondary = Amber700,
        secondaryContainer = Color(0xFFFEF3C7),
        onSecondaryContainer = Amber800,
        background = Color.White,
        surface = Color.White,
        surfaceContainer = Zinc100,
        surfaceContainerLow = Color(0xFFFAFAFA),
        surfaceContainerHigh = Zinc100,
    )

private val DarkColors =
    darkColorScheme(
        primary = Amber500,
        onPrimary = Zinc900,
        secondary = Amber500,
        secondaryContainer = Color(0xFF451A03),
        onSecondaryContainer = Amber500,
        background = Zinc900,
        surface = Zinc900,
        surfaceContainer = Zinc800,
        surfaceContainerLow = Color(0xFF1F1F23),
        surfaceContainerHigh = Zinc800,
    )

// OLED: true black behind everything, so unlit pixels stay off. Raised bars
// lift to a near-black gray rather than taking on the amber accent.
private val BlackColors =
    DarkColors.copy(
        surfaceTint = Color.White,
        background = Color.Black,
        surface = Color.Black,
        surfaceContainerLowest = Color.Black,
        surfaceContainerLow = Color.Black,
        surfaceContainer = Color(0xFF121212),
        surfaceContainerHigh = Color(0xFF1C1C1C),
        surfaceContainerHighest = Color(0xFF262626),
    )

// E-ink: contrast from borders, never fills; every surface white.
private val EpaperColors =
    lightColorScheme(
        primary = Amber800,
        onPrimary = Color.White,
        secondary = Color.Black,
        background = Color.White,
        surface = Color.White,
        surfaceContainer = Color.White,
        surfaceContainerHigh = Color.White,
        surfaceContainerLow = Color.White,
        surfaceVariant = Color.White,
        onSurfaceVariant = Color.Black,
        outline = Color.Black,
        outlineVariant = Color.Black,
        secondaryContainer = Color.White,
        // Elevated surfaces (the article's bottom bar) are tinted with this: solid white.
        surfaceTint = Color.White,
    )

fun ThemeChoice.isDark(systemDark: Boolean): Boolean =
    when (this) {
        ThemeChoice.SYSTEM -> systemDark
        ThemeChoice.DARK,
        ThemeChoice.BLACK -> true
        ThemeChoice.LIGHT,
        ThemeChoice.EPAPER -> false
    }

fun colorsFor(theme: ThemeChoice, systemDark: Boolean): ColorScheme =
    when {
        theme == ThemeChoice.EPAPER -> EpaperColors
        theme == ThemeChoice.BLACK -> BlackColors
        theme.isDark(systemDark) -> DarkColors
        else -> LightColors
    }

@Composable
fun LionReaderTheme(theme: ThemeChoice, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colorsFor(theme, isSystemInDarkTheme()), content = content)
}
