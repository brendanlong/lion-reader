package com.lionreader.shared.account

import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.apiFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext

/** How a background sync went, for the platform's job scheduler. */
enum class SyncOutcome {
    DONE,
    /** Try again later, after a backoff. */
    RETRY,
    /** Give up: signed out. */
    FAILED,
}

/**
 * A background sync: a [full] one (article bodies included), or just sending the outbox. Only for
 * an account whose tokens are known to be its. Anything but signing out is tried again later: the
 * periodic sync would anyway.
 */
suspend fun Accounts.runBackgroundSync(full: Boolean, io: CoroutineDispatcher): SyncOutcome {
    val session = account.value ?: return SyncOutcome.DONE
    if (!session.connection.auth.signedIn.value || !session.confirmed.value) {
        return SyncOutcome.DONE
    }
    return try {
        // SyncEngine doesn't leave the caller's thread, and it's database work.
        withContext(io) { if (full) session.sync.sync() else session.sync.flushOutbox() }
        SyncOutcome.DONE
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        if (e.apiFailure() == ApiFailure.SignedOut) SyncOutcome.FAILED else SyncOutcome.RETRY
    }
}

/** How saving a shared link went. */
sealed interface SaveOutcome {
    /** Saved; the caller syncs to bring it onto the device. */
    data class Saved(val title: String?) : SaveOutcome

    /** Try again later, after a backoff. */
    data object Retry : SaveOutcome

    /** Give up, saying why. */
    data class Failed(val message: String) : SaveOutcome
}

/**
 * Saves a shared link to the account, for a background job that waits for a network. It only gives
 * up when the server rejects the link or the user isn't signed in; anything else is tried again
 * (saving a URL twice just updates the article).
 */
suspend fun ServerConnection.saveLink(url: String): SaveOutcome {
    if (!auth.signedIn.value) return SaveOutcome.Failed(SIGN_IN_TO_SAVE)
    return try {
        SaveOutcome.Saved(api.saveArticle(url).title)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        when (val why = e.apiFailure()) {
            ApiFailure.SignedOut -> SaveOutcome.Failed(SIGN_IN_TO_SAVE)
            is ApiFailure.Rejected ->
                SaveOutcome.Failed(why.message ?: "Lion Reader couldn't save this link.")
            else -> SaveOutcome.Retry
        }
    }
}

private const val SIGN_IN_TO_SAVE = "Sign in to Lion Reader to save links."
