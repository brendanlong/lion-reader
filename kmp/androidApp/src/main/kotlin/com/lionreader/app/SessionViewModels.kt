package com.lionreader.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner

/**
 * The ViewModels of the signed-in session ([AccountSession]). Held by the Activity, so they survive
 * rotation, but cleared when their session ends: keyed by the account alone, a ViewModel would
 * outlive a sign-out and hand the next session of that account the closed one's database.
 */
internal class SessionViewModels : ViewModel() {
    private var session: Any? = null
    private var store = ViewModelStore()

    /** Where [session]'s ViewModels live; any other session's are cleared. */
    fun ownerFor(session: Any): ViewModelStoreOwner {
        if (session !== this.session) {
            store.clear()
            store = ViewModelStore()
            this.session = session
        }
        val current = store
        return object : ViewModelStoreOwner {
            override val viewModelStore = current
        }
    }

    /** [session] is over: its ViewModels go now rather than when the next one starts. */
    fun ended(session: Any) {
        if (session !== this.session) return
        store.clear()
        this.session = null
    }

    override fun onCleared() = store.clear()
}
