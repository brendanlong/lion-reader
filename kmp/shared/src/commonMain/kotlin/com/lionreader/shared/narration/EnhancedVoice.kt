package com.lionreader.shared.narration

import com.lionreader.shared.api.ENHANCED_VOICES
import com.lionreader.shared.api.EnhancedVoice
import com.lionreader.shared.api.EnhancedVoiceFiles

/**
 * The enhanced voice [id] names, or the default for null or one that isn't offered (as the web).
 */
fun resolveEnhancedVoice(id: String?): EnhancedVoice =
    ENHANCED_VOICES.firstOrNull { it.id == id }
        ?: ENHANCED_VOICES.first { it.id == EnhancedVoiceFiles.DEFAULT_VOICE }
