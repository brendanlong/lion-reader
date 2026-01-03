package com.lionreader.ui.narration

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lionreader.service.NarrationService
import com.lionreader.service.NarrationState
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class NarrationViewModel
    @Inject
    constructor(
        @ApplicationContext private val context: Context,
    ) : ViewModel() {
        private var narrationService: NarrationService? = null
        private var isBound = false

        private val _narrationState = MutableStateFlow<NarrationState>(NarrationState.Idle)
        val narrationState: StateFlow<NarrationState> = _narrationState.asStateFlow()

        private val serviceConnection =
            object : ServiceConnection {
                override fun onServiceConnected(
                    name: ComponentName?,
                    service: IBinder?,
                ) {
                    val binder = service as? NarrationService.NarrationBinder
                    narrationService = binder?.getService()
                    isBound = true

                    // Start collecting playback state from the service
                    narrationService?.let { svc ->
                        viewModelScope.launch {
                            svc.playbackState.collect { state ->
                                _narrationState.value = state
                            }
                        }
                    }
                }

                override fun onServiceDisconnected(name: ComponentName?) {
                    narrationService = null
                    isBound = false
                }
            }

        /**
         * Start narrating an entry.
         * This will bind to the service if not already bound and start playback.
         */
        fun startNarration(
            entryId: String,
            title: String,
            feedTitle: String?,
            content: String,
        ) {
            // Start the service as a foreground service
            val intent = Intent(context, NarrationService::class.java)
            context.startForegroundService(intent)

            // Bind to the service if not already bound
            if (!isBound) {
                context.bindService(
                    intent,
                    serviceConnection,
                    Context.BIND_AUTO_CREATE,
                )
            }

            // Wait for service to be bound before starting narration
            // If already bound, start immediately
            narrationService?.startNarration(
                entryId = entryId,
                title = title,
                feedTitle = feedTitle ?: "",
                content = content,
            ) ?: run {
                // Service not yet bound, set loading state
                // The actual narration will start once the service connects
                _narrationState.value = NarrationState.Loading
                viewModelScope.launch {
                    // Wait a bit for service to bind, then try again
                    kotlinx.coroutines.delay(100)
                    narrationService?.startNarration(
                        entryId = entryId,
                        title = title,
                        feedTitle = feedTitle ?: "",
                        content = content,
                    )
                }
            }
        }

        /**
         * Pause the current narration.
         */
        fun pauseNarration() {
            narrationService?.pausePlayback() ?: run {
                // Service not bound, can't pause
                _narrationState.value = NarrationState.Error("Service not available")
            }
        }

        /**
         * Resume the paused narration.
         */
        fun resumeNarration() {
            narrationService?.resumePlayback() ?: run {
                // Service not bound, can't resume
                _narrationState.value = NarrationState.Error("Service not available")
            }
        }

        /**
         * Stop the narration completely.
         */
        fun stopNarration() {
            narrationService?.stopPlayback()
            // Service will stop itself, but we can unbind here
            unbindService()
        }

        /**
         * Skip to the next paragraph.
         */
        fun skipForward() {
            narrationService?.skipToNextParagraph() ?: run {
                _narrationState.value = NarrationState.Error("Service not available")
            }
        }

        /**
         * Skip to the previous paragraph.
         */
        fun skipBackward() {
            narrationService?.skipToPreviousParagraph() ?: run {
                _narrationState.value = NarrationState.Error("Service not available")
            }
        }

        /**
         * Check if currently narrating a specific entry.
         */
        fun isNarrating(entryId: String): Boolean =
            when (val state = _narrationState.value) {
                is NarrationState.Playing -> state.entryId == entryId
                is NarrationState.Paused -> state.entryId == entryId
                else -> false
            }

        private fun unbindService() {
            if (isBound) {
                try {
                    context.unbindService(serviceConnection)
                    isBound = false
                    narrationService = null
                } catch (e: Exception) {
                    // Service might already be unbound
                }
            }
        }

        override fun onCleared() {
            unbindService()
            super.onCleared()
        }
    }
