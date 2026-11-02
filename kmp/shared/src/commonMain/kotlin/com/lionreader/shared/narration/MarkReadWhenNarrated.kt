package com.lionreader.shared.narration

import com.lionreader.shared.settings.MarkReadOn
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map

/**
 * With [MarkReadOn.FINISHED], has [markRead] mark each article read as [narration] says the last of
 * its text: whether or not it's on screen, as narration goes on with the article closed or the
 * screen off. Again if narration comes back to its end after leaving it.
 */
suspend fun markReadWhenNarrated(
    narration: Flow<NarrationState?>,
    markReadOn: () -> MarkReadOn,
    markRead: suspend (entryId: String) -> Unit,
) {
    narration
        .map { state -> state?.takeIf { it.narratedToEnd }?.entryId }
        .distinctUntilChanged()
        .filterNotNull()
        .collect { if (markReadOn() == MarkReadOn.FINISHED) markRead(it) }
}
