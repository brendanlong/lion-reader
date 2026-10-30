package com.lionreader.shared.data

import app.cash.sqldelight.db.AfterVersion
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlSchema
import com.lionreader.shared.api.SAVED_TYPE
import com.lionreader.shared.db.LionReaderDatabase

/**
 * The database schema: [LionReaderDatabase.Schema] plus the triggers that keep the search index
 * (`entry_search`, Search.sq) in step with entries, and with bodies going (a body's text goes in
 * with it: [indexBody]). They're plain SQL here because SQLDelight can't compile statements that
 * name an FTS4 table's columns. Open databases with this, not the generated schema. The index is
 * keyed by `entry`'s implicit rowid, so a migration that rebuilds `entry` must keep each row's
 * rowid (as 7.sqm does) and be listed in [ENTRY_REBUILDS], since dropping `entry` drops its
 * triggers; so must one that drops the triggers to change them (as 8.sqm does). One that rebuilds
 * `entry_body` adds its trigger back in its own `AfterVersion` (as 11.sqm's does). Don't VACUUM: it
 * renumbers rowids.
 */
object AppSchema : SqlSchema<QueryResult.Value<Unit>> by LionReaderDatabase.Schema {
    override fun create(driver: SqlDriver): QueryResult.Value<Unit> {
        LionReaderDatabase.Schema.create(driver)
        SEARCH_TRIGGERS.forEach { driver.execute(null, it, 0) }
        driver.execute(null, AUTOMERGE, 0)
        return QueryResult.Unit
    }

    override fun migrate(
        driver: SqlDriver,
        oldVersion: Long,
        newVersion: Long,
        vararg callbacks: AfterVersion,
    ): QueryResult.Value<Unit> =
        LionReaderDatabase.Schema.migrate(
            driver,
            oldVersion,
            newVersion,
            *ENTRY_REBUILDS.map { version ->
                    AfterVersion(version) { d ->
                        ENTRY_TRIGGERS.forEach { d.execute(null, it, 0) }
                    }
                }
                .toTypedArray(),
            // 8.sqm: saved articles were indexed under their feed title, "Saved Articles".
            AfterVersion(8) { d ->
                d.execute(
                    null,
                    """
                    UPDATE entry_search
                    SET source = (SELECT ${source("e")} FROM entry e WHERE e.rowid = entry_search.rowid)
                    WHERE rowid IN (SELECT rowid FROM entry WHERE type = '$SAVED_TYPE')
                    """,
                    0,
                )
            },
            AfterVersion(11) { d ->
                BODY_TRIGGERS.forEach { d.execute(null, it, 0) }
                d.execute(null, AUTOMERGE, 0)
            },
            *callbacks,
        )
}

/**
 * Has FTS4 merge the index's segments a little on each write, rather than all of a level's at once
 * when it fills: that merge, inside a body download's transaction, held the write lock for seconds
 * (1.8 s on a Pixel 4), with the user waiting behind it to store an article's body. SQLite stores
 * the setting in the database. 8 is SQLite's suggestion, and overall the fastest of those measured.
 */
internal const val AUTOMERGE_SEGMENTS = 8

private const val AUTOMERGE =
    "INSERT INTO entry_search(entry_search) VALUES('automerge=$AUTOMERGE_SEGMENTS')"

/** The migrations (by the version they start from) that drop `entry`'s triggers. */
private val ENTRY_REBUILDS = listOf(7L, 8L)

/** The source indexed for [row]: what the UI shows (Reader's `entrySource`). */
private fun source(row: String): String =
    "CASE WHEN $row.type = '$SAVED_TYPE' THEN COALESCE($row.site_name, $row.feed_title) " +
        "ELSE COALESCE($row.feed_title, $row.site_name) END"

private val ENTRY_TRIGGERS =
    listOf(
        """
        CREATE TRIGGER entry_search_insert AFTER INSERT ON entry BEGIN
          INSERT INTO entry_search(rowid, title, author, source, summary)
          VALUES (NEW.rowid, NEW.title, NEW.author, ${source("NEW")}, NEW.summary);
        END
        """,
        """
        CREATE TRIGGER entry_search_update
        AFTER UPDATE OF title, author, type, feed_title, site_name, summary ON entry
        WHEN OLD.title IS NOT NEW.title OR OLD.author IS NOT NEW.author
          OR OLD.type IS NOT NEW.type OR OLD.feed_title IS NOT NEW.feed_title
          OR OLD.site_name IS NOT NEW.site_name OR OLD.summary IS NOT NEW.summary
        BEGIN
          UPDATE entry_search
          SET title = NEW.title, author = NEW.author,
            source = ${source("NEW")}, summary = NEW.summary
          WHERE rowid = NEW.rowid;
        END
        """,
        """
        CREATE TRIGGER entry_search_delete AFTER DELETE ON entry BEGIN
          DELETE FROM entry_search WHERE rowid = OLD.rowid;
        END
        """,
    )

private val BODY_TRIGGERS =
    listOf(
        """
        CREATE TRIGGER entry_search_body_delete AFTER DELETE ON entry_body BEGIN
          UPDATE entry_search SET body = NULL
          WHERE rowid = (SELECT rowid FROM entry WHERE id = OLD.entry_id);
        END
        """
    )

internal val SEARCH_TRIGGERS = ENTRY_TRIGGERS + BODY_TRIGGERS

/**
 * Puts [text] in the search index as [entryId]'s body, in the transaction storing the body: plain
 * SQL, as SQLDelight can't compile an UPDATE of an FTS4 table (it overflows its stack).
 */
internal fun SqlDriver.indexBody(entryId: String, text: String) {
    execute(
        null,
        "UPDATE entry_search SET body = ? WHERE rowid = (SELECT rowid FROM entry WHERE id = ?)",
        2,
    ) {
        bindString(0, text)
        bindString(1, entryId)
    }
}

/** Tags inside a word (`<b>qu</b>ick`); any other tag separates words. */
private val INLINE_TAG =
    Regex(
        "</?(a|abbr|b|code|em|i|mark|s|small|span|strong|sub|sup|u)\\b[^>]*>",
        RegexOption.IGNORE_CASE,
    )
// Quoted attribute values can hold a `>`.
private val TAG = Regex("<(?:[^>\"']|\"[^\"]*\"|'[^']*')*>")
private val ENTITY = Regex("&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);")
private val SPACE = Regex("\\s+")
private val NAMED_ENTITIES =
    mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'")

/** An article body's words, for the search index: tags dropped, entities decoded. */
fun searchText(html: String): String =
    html
        .replace(INLINE_TAG, "")
        .replace(TAG, " ")
        .replace(ENTITY) { match ->
            val name = match.groupValues[1]
            val code =
                when {
                    name.startsWith("#x", ignoreCase = true) -> name.drop(2).toIntOrNull(16)
                    name.startsWith("#") -> name.drop(1).toIntOrNull()
                    else -> null
                }
            if (code != null && code in 1..0x10FFFF && code !in 0xD800..0xDFFF) {
                codePointString(code)
            } else {
                // Other named ones (&nbsp;, &mdash;…) are punctuation or space.
                NAMED_ENTITIES[name] ?: " "
            }
        }
        .replace(SPACE, " ")
        .trim()

private fun codePointString(code: Int): String =
    if (code < 0x10000) code.toChar().toString()
    else {
        val offset = code - 0x10000
        charArrayOf((0xD800 + (offset shr 10)).toChar(), (0xDC00 + (offset and 0x3FF)).toChar())
            .concatToString()
    }

private val WORD = Regex("[\\p{L}\\p{N}]+")

/**
 * What the user typed, as an FTS4 query: every word must appear, each as a prefix (so results come
 * while typing). Only letters and digits survive, each word quoted, so nothing typed is FTS syntax
 * (not even AND/OR/NOT). Null when there are no words.
 */
fun searchQuery(text: String): String? =
    WORD.findAll(text)
        .map { "\"${it.value}*\"" }
        .toList()
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" ")
