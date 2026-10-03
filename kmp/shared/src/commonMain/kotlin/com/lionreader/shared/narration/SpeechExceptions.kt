package com.lionreader.shared.narration

/** The engine can't narrate (signed out, no key, the voice rejected): stop, and say why. */
class SpeechUnavailable(message: String) : SpeechException(message)

/**
 * The engine can't be reached for now (no connection, server trouble): the narrator plays what it
 * has and tries again, pausing if it runs out for long.
 */
class SpeechInterrupted(message: String) : SpeechException(message)

/** Why a chunk couldn't be synthesized, other than the chunk itself (which is just skipped). */
sealed class SpeechException(message: String) : Exception(message)
