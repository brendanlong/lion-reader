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
    data object Copying : FileShareState

    /** Queued as [SaveWorker] work named [workName]. */
    data class Saving(val workName: String) : FileShareState

    data class Failed(val message: String) : FileShareState
}

/**
 * Copies a shared file ([copySharedFile]) and queues its save, once per dialog: a view model, so a
 * rotation mid-copy neither loses the file nor copies it twice. The copy runs in the app's scope,
 * so closing the dialog mid-copy (a slow cloud provider) still saves the file.
 */
class FileShareModel(application: Application) : AndroidViewModel(application) {
    private val _state = MutableStateFlow<FileShareState>(FileShareState.Copying)
    val state: StateFlow<FileShareState> = _state
    private var started = false

    fun start(uri: Uri, sharedType: String?) {
        if (started) return
        started = true
        val app = getApplication<Application>()
        app.graph.appScope.launch(Dispatchers.IO) {
            _state.value =
                when (val result = copySharedFile(app, uri, sharedType)) {
                    is CopyResult.Copied ->
                        FileShareState.Saving(SaveWorker.enqueue(app, result.file))
                    is CopyResult.Failed -> FileShareState.Failed(result.message)
                }
        }
    }
}
