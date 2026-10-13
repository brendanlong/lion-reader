package com.lionreader.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

/** Whether the default network is unmetered (Wi-Fi, usually); nothing until there is one. */
fun Context.onUnmeteredNetwork(): Flow<Boolean> = callbackFlow {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) {
                trySend(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
            }

            override fun onLost(network: Network) {
                trySend(false)
            }
        }
    connectivity.registerDefaultNetworkCallback(callback)
    awaitClose { connectivity.unregisterNetworkCallback(callback) }
}
    .distinctUntilChanged()
