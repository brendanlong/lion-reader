package com.lionreader.shared.narration

import com.lionreader.shared.api.ENHANCED_VOICES
import com.lionreader.shared.api.EnhancedVoiceFiles
import kotlin.test.Test
import kotlin.test.assertEquals

class EnhancedVoiceTest {
    @Test
    fun resolvesAVoiceByItsId() {
        val voice = ENHANCED_VOICES.last()
        assertEquals(voice, resolveEnhancedVoice(voice.id))
    }

    @Test
    fun fallsBackToTheDefaultForNoneOrOneNotOffered() {
        assertEquals(EnhancedVoiceFiles.DEFAULT_VOICE, resolveEnhancedVoice(null).id)
        // A Piper voice id, as the web stored before enhanced voices moved to Phonon.
        assertEquals(
            EnhancedVoiceFiles.DEFAULT_VOICE,
            resolveEnhancedVoice("en_US-lessac-medium").id,
        )
    }
}
