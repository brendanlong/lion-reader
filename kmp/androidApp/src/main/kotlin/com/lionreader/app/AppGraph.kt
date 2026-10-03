package com.lionreader.app

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.datastore.preferences.preferencesDataStore
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.lionreader.app.narration.CloudSpeechRequests
import com.lionreader.app.narration.CloudVoices
import com.lionreader.app.narration.DeviceVoices
import com.lionreader.app.narration.Narrator
import com.lionreader.app.narration.SpeechEngine
import com.lionreader.app.narration.SystemTts
import com.lionreader.app.ui.PageTurns
import com.lionreader.shared.account.AccountSession
import com.lionreader.shared.account.AccountStorage
import com.lionreader.shared.account.Accounts
import com.lionreader.shared.account.BackgroundSync
import com.lionreader.shared.account.KeyValueStore
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.narration.SpeechUnavailable
import com.lionreader.shared.settings.AppSettings
import com.lionreader.shared.settings.NarrationEngine
import com.lionreader.shared.settings.SettingsRepository
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.UserAgent
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val Context.settingsStore by preferencesDataStore("settings")

/**
 * The app's singletons: the shared [accounts] and settings, with what Android adds to them
 * (narration, and where accounts keep their data). Everything in one process shares them — the UI,
 * the sync worker, and the sign-in callback.
 */
class AppGraph(
    private val context: Context,
    http: HttpClient = appHttpClient(),
    /** How soon to ask again which account a sign-in is, at first (it backs off). */
    confirmRetryMillis: Long = 5_000,
) {
    val settings = SettingsRepository(context.settingsStore, deviceDefaults())

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val currentSettings: StateFlow<AppSettings> =
        settings.settings.stateIn(scope, SharingStarted.Eagerly, settings.defaults)

    /** The device's text-to-speech engine (voices for Settings, and narration). */
    val systemTts: SystemTts by lazy { SystemTts(context) }

    private val narratorInstance = lazy { Narrator(context, currentSettings, ::speechEngine) }

    /** Text-to-speech narration; one article at a time, app-wide. */
    val narrator: Narrator by narratorInstance

    /** Whether narration is playing (without starting the narrator to ask). */
    val narrating: Boolean
        get() = narratorInstance.isInitialized() && narrator.state.value?.playing == true

    /** What the volume buttons turn the pages of, when the settings have them do so. */
    val pageTurns = PageTurns()

    val accounts =
        Accounts(
            PrefsStore(context.getSharedPreferences("auth", Context.MODE_PRIVATE)),
            AndroidAccountStorage(context),
            WorkManagerSync(context),
            http,
            BuildConfig.SIGN_IN_CALLBACK_PATH,
            allowHttp = BuildConfig.DEBUG,
            retention = { currentSettings.value.retention },
            io = Dispatchers.IO,
            // Narration may be reading the account's articles, with cloud voices on whoever's
            // tokens are in now.
            beforeSessionEnds = {
                if (narratorInstance.isInitialized()) {
                    withContext(Dispatchers.Main) { narrator.stop() }
                }
            },
            confirmRetryMillis = confirmRetryMillis,
            now = System::currentTimeMillis,
        )

    /** Shared by every article's engine, so its limit on requests at once holds app-wide. */
    private val cloudSpeechRequests = CloudSpeechRequests()

    private suspend fun speechEngine(settings: AppSettings): SpeechEngine =
        when (settings.narrationEngine) {
            NarrationEngine.DEVICE -> DeviceVoices(systemTts, settings.narrationVoice)
            NarrationEngine.CLOUD -> {
                val session =
                    accounts.account.value
                        ?: throw SpeechUnavailable("Sign in to use cloud voices.")
                val choice = session.cloudVoice(settings.cloudVoiceModel, settings.cloudVoice)
                CloudVoices(
                    session.connection.api,
                    choice.model.id,
                    choice.voice,
                    // The server takes up to 2 seconds.
                    settings.cloudVoicePauseSeconds.coerceIn(0f, 2f),
                    cloudVoiceCache(session),
                    session.work,
                    cloudSpeechRequests,
                )
            }
        }

    /** Only the setting: the narrator follows it. */
    fun setNarrationSpeed(speed: Float) {
        scope.launch { settings.update { it.copy(narrationSpeed = speed) } }
    }

    /** A full sync (article bodies included) in a background job. */
    fun syncInBackground() = SyncScheduler.syncNow(context)

    /** Cloud narration audio of [session]'s articles, so it goes with the account. */
    fun cloudVoiceCache(session: AccountSession): File = cloudVoiceCache(context, session.dbName)
}

private fun appHttpClient() =
    HttpClient(OkHttp) {
        install(UserAgent) { agent = "LionReader-Android/${BuildConfig.VERSION_NAME}" }
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            requestTimeoutMillis = 60_000
        }
    }

/** Every account's cloud voice cache. */
private fun cloudVoiceCaches(context: Context) = File(context.cacheDir, "cloud-voices")

private fun cloudVoiceCache(context: Context, dbName: String) =
    File(cloudVoiceCaches(context), dbName.removeSuffix(".db"))

/** Accounts' databases, and their cloud narration audio in the cache. */
private class AndroidAccountStorage(private val context: Context) : AccountStorage {
    override fun openDatabase(name: String) = AndroidSqliteDriver(AppSchema, context, name)

    override fun delete(name: String) {
        context.deleteDatabase(name)
        cloudVoiceCache(context, name).deleteRecursively()
    }

    override fun deleteAllBut(keep: String?) {
        context
            .databaseList()
            .filter { it.startsWith("account-") && it.endsWith(".db") && it != keep }
            .forEach { context.deleteDatabase(it) }
        val kept = keep?.let { cloudVoiceCache(context, it) }
        cloudVoiceCaches(context)
            .listFiles()
            ?.filter { it != kept }
            ?.forEach { it.deleteRecursively() }
    }
}

/** Written with `commit`, so a write is on disk when it returns (see [KeyValueStore]). */
private class PrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)

    override fun getBoolean(key: String, default: Boolean) = prefs.getBoolean(key, default)

    override fun getLong(key: String, default: Long) = prefs.getLong(key, default)

    override fun edit(changes: KeyValueStore.Editor.() -> Unit) =
        prefs.edit(commit = true) {
            val editor = this
            object : KeyValueStore.Editor {
                    override fun putString(key: String, value: String?) {
                        editor.putString(key, value)
                    }

                    override fun putBoolean(key: String, value: Boolean) {
                        editor.putBoolean(key, value)
                    }

                    override fun putLong(key: String, value: Long) {
                        editor.putLong(key, value)
                    }

                    override fun remove(key: String) {
                        editor.remove(key)
                    }
                }
                .changes()
        }
}

private class WorkManagerSync(private val context: Context) : BackgroundSync {
    override fun flushSoon() = SyncScheduler.flushSoon(context)

    override fun syncNow() = SyncScheduler.syncNow(context)

    override fun schedulePeriodic() = SyncScheduler.schedulePeriodic(context)

    override fun cancelAll() {
        SyncScheduler.cancelAll(context)
    }
}
