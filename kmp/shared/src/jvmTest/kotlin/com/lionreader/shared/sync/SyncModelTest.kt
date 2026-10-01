package com.lionreader.shared.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.lionreader.shared.data.AppSchema
import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Reader
import com.lionreader.shared.db.LionReaderDatabase
import kotlin.coroutines.ContinuationInterceptor
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.fail
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

private const val SEEDS = 300
private const val STEPS = 60

/**
 * Random sequences of local changes, changes from another device, server-side changes, flaky
 * requests (failed before or after being applied), overlapping syncs and restarts, checked against
 * invariants once everything settles:
 * - the device agrees with the server on which entries exist and their read/starred state, and on
 *   unread counts;
 * - the user's last change to every entry and field reached the server;
 * - downloaded bodies are the server's current ones;
 * - nothing is left unsent.
 *
 * A failure names its seed; rerun that seed alone to debug it.
 */
class SyncModelTest {
    @Test
    fun randomHistoriesConverge() =
        runTest(timeout = 30.minutes) {
            // SYNC_MODEL_SEED=N replays one seed (printing its requests on failure);
            // SYNC_MODEL_SEEDS=N runs more than the default.
            val only = System.getenv("SYNC_MODEL_SEED")?.toInt()
            val count = System.getenv("SYNC_MODEL_SEEDS")?.toInt() ?: SEEDS
            val seeds = if (only != null) listOf(only) else (0 until count).toList()
            val failures = seeds.mapNotNull { seed -> runSeed(seed)?.let { "seed $seed: $it" } }
            if (failures.isNotEmpty()) fail(failures.take(5).joinToString("\n\n"))
        }

    /** Null when every invariant holds, else what broke and how it got there. */
    private suspend fun runSeed(seed: Int): String? {
        val random = Random(seed)
        var clock = 1_800_000_000_000L
        val server = ModelServer({ clock }, random)
        // Small pages make multi-page catch-ups (and their edge cases) common.
        server.syncPageSize = 1 + random.nextInt(8)
        repeat(8) { server.addEntry(read = random.nextBoolean(), starred = random.nextInt(4) == 0) }
        repeat(2) { server.addEntry(subscriptionId = null) }

        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        AppSchema.create(driver)
        val db = LionReaderDatabase(driver)
        val api =
            server.api(currentCoroutineContext()[ContinuationInterceptor] as CoroutineDispatcher)
        val policy = RetentionPolicy(windowDays = 3650, maxReadEntries = 100_000)
        fun newEngine() = SyncEngine(api, db, { clock }, { policy })
        fun newReader() = Reader(db, { clock }, Dispatchers.Unconfined) {}
        var engine = newEngine()
        var reader = newReader()

        // The user's changes, in order: (entry, field) -> (value, time).
        val lastLocal = mutableMapOf<Pair<String, String>, Pair<Boolean, Long>>()
        val log = mutableListOf<String>()

        suspend fun localEntries() =
            reader.timeline(ListScope.All, false, emptySet(), 10_000).first()
        suspend fun quietly(block: suspend () -> Unit) {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // A flaky request; the next sync retries.
            }
        }
        suspend fun localChange() {
            val entry = localEntries().randomOrNull(random) ?: return
            if (random.nextBoolean()) {
                reader.setRead(listOf(entry.id), !entry.read)
                lastLocal[entry.id to "read"] = !entry.read to clock
                log += "local read ${entry.id}=${!entry.read}"
            } else {
                reader.setStarred(entry.id, !entry.starred)
                lastLocal[entry.id to "starred"] = !entry.starred to clock
                log += "local star ${entry.id}=${!entry.starred}"
            }
        }

        try {
            server.faultRate = 0.25
            repeat(STEPS) {
                clock += random.nextLong(1, 60_000)
                when (random.nextInt(100)) {
                    in 0..29 -> localChange()
                    in 30..34 -> {
                        val scope =
                            if (random.nextBoolean()) ListScope.All
                            else ListScope.Subscription("sub-1")
                        reader.setRead(reader.unreadIds(scope), true)
                        // Mark-all records a read change per unread local entry.
                        db.outboxQueries
                            .selectStates()
                            .executeAsList()
                            .filter { it.field_ == "read" && it.changed_at == clock }
                            .forEach { lastLocal[it.entry_id to "read"] = true to clock }
                        log += "local mark-all $scope"
                    }
                    in 35..49 -> {
                        val entry = server.visible.randomOrNull(random) ?: return@repeat
                        val field = if (random.nextBoolean()) "read" else "starred"
                        val value = !(if (field == "read") entry.read else entry.starred)
                        server.remoteWrite(entry, field, value)
                        log += "remote $field ${entry.id}=$value"
                    }
                    in 50..56 -> {
                        val subscription =
                            if (random.nextInt(4) == 0) null
                            else server.subscriptions.random(random)
                        log += "server new ${server.addEntry(subscriptionId = subscription).id}"
                    }
                    in 57..60 -> {
                        val saved =
                            server.visible.filter { it.subscriptionId == null }.randomOrNull(random)
                        if (saved != null) {
                            server.delete(saved)
                            log += "server delete ${saved.id}"
                        }
                    }
                    in 61..64 -> {
                        val entry = server.visible.randomOrNull(random) ?: return@repeat
                        server.editContent(entry)
                        log += "server edit ${entry.id}"
                    }
                    in 65..79 -> {
                        quietly { engine.sync(downloadContent = random.nextBoolean()) }
                        log += "sync"
                    }
                    in 80..89 -> {
                        quietly { engine.flushOutbox() }
                        log += "flush"
                    }
                    in 90..94 -> {
                        // Overlapping work, interleaved at suspension points.
                        coroutineScope {
                            launch { quietly { engine.sync() } }
                            launch { quietly { engine.flushOutbox() } }
                            launch { localChange() }
                            launch {
                                // Opening an entry downloads its body alongside the sync.
                                localEntries().randomOrNull(random)?.let {
                                    quietly { engine.ensureContent(it.id) }
                                }
                            }
                        }
                        log += "overlap"
                    }
                    else -> {
                        engine = newEngine()
                        reader = newReader()
                        log += "restart"
                    }
                }
            }

            // Settle: no more faults, sync until nothing is left to send.
            server.faultRate = 0.0
            clock += 1
            repeat(3) { engine.sync() }

            return checkInvariants(server, db, reader, lastLocal)?.let {
                if (System.getenv("SYNC_MODEL_SEED") != null) server.requestLog.forEach(::println)
                "$it\nhistory: ${log.joinToString(", ")}"
            }
        } finally {
            driver.close()
        }
    }

    private suspend fun checkInvariants(
        server: ModelServer,
        db: LionReaderDatabase,
        reader: Reader,
        lastLocal: Map<Pair<String, String>, Pair<Boolean, Long>>,
    ): String? {
        val local =
            reader.timeline(ListScope.All, false, emptySet(), 10_000).first().associateBy { it.id }
        val remote = server.visible.associateBy { it.id }

        if (local.keys != remote.keys) {
            return "entries differ: only local ${local.keys - remote.keys}, only server ${remote.keys - local.keys}"
        }
        for ((id, entry) in remote) {
            val mine = local.getValue(id)
            if (mine.read != entry.read || mine.starred != entry.starred) {
                return "$id: device read=${mine.read} starred=${mine.starred}, server read=${entry.read} starred=${entry.starred}"
            }
        }

        val pending = db.outboxQueries.countStates().executeAsOne()
        if (pending != 0L) return "$pending changes still unsent"

        val undelivered = server.recentlyReadUndelivered()
        val recentlyRead =
            reader.timeline(ListScope.RecentlyRead, false, emptySet(), 10_000).first().map {
                it.id
            } - undelivered
        val serverRecentlyRead = server.recentlyRead() - undelivered
        if (recentlyRead != serverRecentlyRead) {
            return "recently read: device $recentlyRead, server $serverRecentlyRead"
        }

        for ((key, change) in lastLocal) {
            val (id, field) = key
            if (id !in remote) continue
            val (value, time) = change
            val received =
                server.clientWrites.any {
                    it.entryId == id &&
                        it.field == field &&
                        it.value == value &&
                        it.changedAt == time
                }
            if (!received) return "the change $field $id=$value at $time never reached the server"
        }

        // With everything synced (the test keeps all entries), the device's own
        // counts must equal the server's.
        val nav = reader.navigation().first()
        val counts = server.counts()
        if (nav.allUnread != counts.all)
            return "all unread: device ${nav.allUnread}, server ${counts.all}"
        if (nav.starredUnread != counts.starred) {
            return "starred unread: device ${nav.starredUnread}, server ${counts.starred}"
        }
        if (nav.savedUnread != counts.saved) {
            return "saved unread: device ${nav.savedUnread}, server ${counts.saved}"
        }
        for ((sub, unread) in counts.bySubscription) {
            val mine = nav.subscriptions.find { it.id == sub }?.unread
            if (mine != unread) return "$sub unread: device $mine, server $unread"
        }

        for ((id, entry) in remote) {
            val body = reader.entry(id).first()?.content
            val wanted = !entry.read || entry.starred || entry.subscriptionId == null
            if (body != null && body != entry.content)
                return "$id: stale body $body, server ${entry.content}"
            if (wanted && body == null) return "$id: body never downloaded"
        }
        return null
    }
}
