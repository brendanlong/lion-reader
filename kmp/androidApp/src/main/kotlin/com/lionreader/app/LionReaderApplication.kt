package com.lionreader.app

import android.app.Application

class LionReaderApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        useLauncherIcon()
        graph.followSyncInterval()
    }
}

val android.content.Context.graph: AppGraph
    get() = (applicationContext as LionReaderApplication).graph
