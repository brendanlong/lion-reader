package com.lionreader.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionViewModelsTest {
    private class Probe : ViewModel() {
        var cleared = false

        override fun onCleared() {
            cleared = true
        }
    }

    private fun probe(owner: ViewModelStoreOwner): Probe =
        ViewModelProvider.create(owner, viewModelFactory { initializer { Probe() } })[Probe::class]

    @Test
    fun theSameSessionKeepsItsViewModels() {
        val sessions = SessionViewModels()
        val session = Any()

        val first = probe(sessions.ownerFor(session))

        assertSame(first, probe(sessions.ownerFor(session)))
        assertFalse(first.cleared)
    }

    /** Signing out and back in to the same account is a new session, with new ViewModels. */
    @Test
    fun aNewSessionGetsNewViewModelsAndClearsTheOldOnes() {
        val sessions = SessionViewModels()
        val old = probe(sessions.ownerFor(Any()))

        val new = probe(sessions.ownerFor(Any()))

        assertNotSame(old, new)
        assertTrue(old.cleared)
        assertFalse(new.cleared)
    }

    @Test
    fun anEndedSessionsViewModelsAreCleared() {
        val sessions = SessionViewModels()
        val session = Any()
        val model = probe(sessions.ownerFor(session))

        sessions.ended(Any())
        assertFalse(model.cleared)
        sessions.ended(session)
        assertTrue(model.cleared)
        assertNotSame(model, probe(sessions.ownerFor(session)))
    }
}
