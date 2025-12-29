package com.lionreader.data.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Interface for monitoring network connectivity.
 *
 * This abstraction allows for easier testing by enabling mock implementations.
 */
interface ConnectivityMonitorInterface {
    /**
     * StateFlow indicating current network connectivity status.
     *
     * Emits `true` when the device has internet connectivity, `false` otherwise.
     */
    val isOnline: StateFlow<Boolean>

    /**
     * Returns the current connectivity state.
     *
     * This is a convenience method that returns the current value of [isOnline].
     * For reactive updates, prefer observing the [isOnline] StateFlow directly.
     *
     * @return true if device has internet connectivity, false otherwise
     */
    fun checkOnline(): Boolean
}

/**
 * Monitors network connectivity and provides reactive updates.
 *
 * This class registers a NetworkCallback with the ConnectivityManager to track
 * network availability in real-time. When connectivity is restored after being
 * lost, it triggers an immediate sync via [SyncScheduler].
 *
 * Usage:
 * - Observe [isOnline] StateFlow for reactive connectivity updates
 * - Call [isOnline()] function for one-time connectivity checks
 * - Call [unregister()] when the monitor is no longer needed (e.g., in onDestroy)
 */
@Singleton
class ConnectivityMonitor @Inject constructor(
    @ApplicationContext private val context: Context,
) : ConnectivityMonitorInterface {
    companion object {
        private const val TAG = "ConnectivityMonitor"
    }

    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _isOnline = MutableStateFlow(checkCurrentConnectivity())

    /**
     * StateFlow indicating current network connectivity status.
     *
     * Emits `true` when the device has internet connectivity, `false` otherwise.
     * This flow is updated in real-time as network conditions change.
     */
    override val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    /**
     * Callback reference for tracking sync trigger.
     * Set by [SyncScheduler] to trigger immediate sync when connectivity is restored.
     */
    private var onConnectivityRestored: (() -> Unit)? = null

    /**
     * Flag to track if callback was previously offline.
     * Used to detect connectivity restoration events.
     */
    private var wasOffline = !_isOnline.value

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            Log.d(TAG, "Network available")
            val previouslyOffline = wasOffline
            wasOffline = false

            if (!_isOnline.value) {
                _isOnline.value = true
            }

            // Trigger sync when connectivity is restored after being offline
            if (previouslyOffline) {
                Log.d(TAG, "Connectivity restored, triggering sync")
                onConnectivityRestored?.invoke()
            }
        }

        override fun onLost(network: Network) {
            Log.d(TAG, "Network lost")
            wasOffline = true

            // Verify we have no other active networks before marking offline
            val activeNetwork = connectivityManager.activeNetwork
            if (activeNetwork == null) {
                _isOnline.value = false
            } else {
                // Check if the remaining active network has internet capability
                val capabilities = connectivityManager.getNetworkCapabilities(activeNetwork)
                val hasInternet = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
                val isValidated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
                _isOnline.value = hasInternet && isValidated
            }
        }

        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities,
        ) {
            val hasInternet = networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val isValidated = networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val newOnlineState = hasInternet && isValidated

            Log.d(TAG, "Capabilities changed - hasInternet: $hasInternet, validated: $isValidated")

            if (_isOnline.value != newOnlineState) {
                val previouslyOffline = !_isOnline.value
                _isOnline.value = newOnlineState
                wasOffline = !newOnlineState

                // Trigger sync when connectivity is restored
                if (newOnlineState && previouslyOffline) {
                    Log.d(TAG, "Connectivity validated, triggering sync")
                    onConnectivityRestored?.invoke()
                }
            }
        }
    }

    private var isRegistered = false

    init {
        registerCallback()
    }

    /**
     * Registers the network callback with the ConnectivityManager.
     *
     * Should be called once during initialization. The callback is automatically
     * registered in the init block, so this is mainly for re-registration after
     * [unregister] is called.
     */
    fun registerCallback() {
        if (isRegistered) {
            Log.d(TAG, "Network callback already registered")
            return
        }

        val networkRequest = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        try {
            connectivityManager.registerNetworkCallback(networkRequest, networkCallback)
            isRegistered = true
            Log.d(TAG, "Network callback registered")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register network callback", e)
        }
    }

    /**
     * Unregisters the network callback from the ConnectivityManager.
     *
     * Call this when the monitor is no longer needed to prevent memory leaks.
     * The callback can be re-registered by calling [registerCallback].
     */
    fun unregister() {
        if (!isRegistered) {
            Log.d(TAG, "Network callback not registered, skipping unregister")
            return
        }

        try {
            connectivityManager.unregisterNetworkCallback(networkCallback)
            isRegistered = false
            Log.d(TAG, "Network callback unregistered")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unregister network callback", e)
        }
    }

    /**
     * Sets a callback to be invoked when connectivity is restored.
     *
     * This is used by [SyncScheduler] to trigger immediate sync when
     * the device comes back online after being offline.
     *
     * @param callback The callback to invoke, or null to clear
     */
    fun setOnConnectivityRestoredCallback(callback: (() -> Unit)?) {
        onConnectivityRestored = callback
    }

    /**
     * Returns the current connectivity state.
     *
     * This is a convenience method that returns the current value of [isOnline].
     * For reactive updates, prefer observing the [isOnline] StateFlow directly.
     *
     * @return true if device has internet connectivity, false otherwise
     */
    override fun checkOnline(): Boolean = _isOnline.value

    /**
     * Checks current connectivity by querying the ConnectivityManager directly.
     *
     * This performs a synchronous check of the current network state.
     * Used to initialize the [isOnline] state.
     */
    private fun checkCurrentConnectivity(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false

        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
