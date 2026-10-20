package com.lionreader.app.share

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface FileShareState {
    data object Copying : FileShareState

    /** Queued as [SaveWorker] work named [workName]. */
    data class Saving(val workName: String) : FileShareState

    data class Failed(val message: String) : FileShareState
}

/**
 * Copies a shared file ([copySharedFile]) and queues its save, once: a view model, so the share
 * dialog's recreation (a rotation mid-copy) neither loses the file nor saves it twice.
 */
class FileShareModel(application: Application) : AndroidViewModel(application) {
    private val _state = MutableStateFlow<FileShareState>(FileShareState.Copying)
    val state: StateFlow<FileShareState> = _state
    private var started = false

    fun start(uri: Uri, mimeType: String?) {
        if (started) return
        started = true
        viewModelScope.launch {
            val app = getApplication<Application>()
            _state.value =
                when (
                    val result = withContext(Dispatchers.IO) { copySharedFile(app, uri, mimeType) }
                ) {
                    is CopyResult.Copied -> {
                        SaveWorker.enqueue(app, result.file)
                        FileShareState.Saving(SaveWorker.workName(result.file))
                    }
                    is CopyResult.Failed -> FileShareState.Failed(result.message)
                }
        }
    }
}
