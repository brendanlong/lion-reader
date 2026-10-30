package com.lionreader.app.share

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import com.lionreader.app.graph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

sealed interface FileShareState {
    /** Not open yet: the read grant ends with the dialog, so closing it now cancels the save. */
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
    private var job: Job? = null

    fun start(uri: Uri, sharedType: String?) {
        if (job != null) return
        val app = getApplication<Application>()
        job =
            app.graph.appScope.launch(Dispatchers.IO) {
                val opened = openSharedFile(app, uri, sharedType)
                if (opened is ShareFailed) {
                    _state.value = FileShareState.Failed(opened.message)
                    return@launch
                }
                opened as SharedStream
                if (!isActive) {
                    opened.input.close()
                    return@launch
                }
                _state.value = FileShareState.Copying
                _state.value =
                    when (val copied = copySharedFile(app, opened)) {
                        is CopiedFile -> FileShareState.Saving(SaveWorker.enqueue(app, copied))
                        is ShareFailed -> FileShareState.Failed(copied.message)
                    }
            }
    }

    /** The dialog closed while [FileShareState.Opening]: the file won't be readable, so no save. */
    fun cancelOpening() {
        if (_state.value == FileShareState.Opening) job?.cancel()
    }
}
