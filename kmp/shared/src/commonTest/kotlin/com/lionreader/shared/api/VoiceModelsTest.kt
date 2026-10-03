package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VoiceModelsTest {
    private fun model(id: String, vararg voices: String) =
        VoiceModel(
            id,
            "Model $id",
            voices.map { CloudVoice(it, "Voice $it") },
            defaultVoice = voices.first(),
            provider = "p",
            providerDisplayName = "P",
        )

    private val kokoro = model("kokoro", "heart", "bella")
    private val orpheus = model("orpheus", "tara", "leo")
    private val available = VoiceModels(listOf(kokoro, orpheus), defaultModelId = "orpheus")

    @Test
    fun theChosenModelAndVoiceWhenOffered() {
        assertEquals(ResolvedVoice(kokoro, "bella"), available.resolve("kokoro", "bella"))
    }

    @Test
    fun noChoiceIsTheServersDefaultModelAndItsDefaultVoice() {
        assertEquals(ResolvedVoice(orpheus, "tara"), available.resolve(null, null))
    }

    @Test
    fun aModelNoLongerOfferedFallsBackToTheDefault() {
        assertEquals(ResolvedVoice(orpheus, "tara"), available.resolve("gone", "bella"))
    }

    @Test
    fun aVoiceTheModelDoesntHaveIsItsDefaultVoice() {
        assertEquals(ResolvedVoice(kokoro, "heart"), available.resolve("kokoro", "tara"))
        assertEquals(ResolvedVoice(orpheus, "leo"), available.resolve(null, "leo"))
    }

    @Test
    fun aDefaultTheServerDoesntListIsTheFirstModel() {
        val models = VoiceModels(listOf(kokoro, orpheus), defaultModelId = "gone")
        assertEquals(kokoro, models.defaultModel)
        assertEquals(ResolvedVoice(kokoro, "heart"), models.resolve(null, null))
    }

    @Test
    fun noModelsIsNothing() {
        assertNull(VoiceModels(emptyList(), "").resolve("kokoro", "heart"))
    }
}
