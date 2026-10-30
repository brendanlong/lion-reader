package com.lionreader.app.share

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import com.lionreader.app.graph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

sealed interface FileShareState {
    /** Not open yet: closing the dialog now would end the read grant, losing the file. */
    data object Opening : FileShareState

    data object Copying : FileShareState

    /** Queued as [SaveWorker] work named [workName]. */
    data class Saving(val workName: String) : FileShareState

    data class Failed(val message: String) : FileShareState
}

/**
 * Opens a shared file ([openSharedFile]), copies it ([copySharedFile]) and queues its save, once
 * per dialog: a view model, so a rotation mid-copy neither loses the file nor copies it twice. The
 * copy runs in the app's scope, so closing the dialog once the file is open (a slow cloud provider)
 * still saves the file.
 */
class FileShareModel(application: Application) : AndroidViewModel(application) {
    private val _state = MutableStateFlow<FileShareState>(FileShareState.Opening)
    val state: StateFlow<FileShareState> = _state
    private var started = false

    fun start(uri: Uri, sharedType: String?) {
        if (started) return
        started = true
        val app = getApplication<Application>()
        app.graph.appScope.launch(Dispatchers.IO) {
            val opened = openSharedFile(app, uri, sharedType)
            _state.value =
                when (opened) {
                    is ShareFailed -> FileShareState.Failed(opened.message)
                    is SharedStream -> {
                        _state.value = FileShareState.Copying
                        when (val copied = copySharedFile(app, opened)) {
                            is CopiedFile -> FileShareState.Saving(SaveWorker.enqueue(app, copied))
                            is ShareFailed -> FileShareState.Failed(copied.message)
                        }
                    }
                }
        }
    }
}
