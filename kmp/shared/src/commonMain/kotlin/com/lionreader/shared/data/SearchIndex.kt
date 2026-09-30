package com.lionreader.shared.data

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlSchema
import com.lionreader.shared.db.LionReaderDatabase

/**
 * The database schema: [LionReaderDatabase.Schema] plus the triggers that keep the search index
 * (`entry_search`, Search.sq) in step with entries and their bodies. They're plain SQL here because
 * SQLDelight can't compile statements that name an FTS4 table's columns. Open databases with this,
 * not the generated schema. The index is keyed by `entry`'s implicit rowid: a migration that
 * rebuilds `entry`, or a VACUUM, renumbers it, so either has to rebuild the index (and recreate the
 * triggers) too.
 */
object AppSchema : SqlSchema<QueryResult.Value<Unit>> by LionReaderDatabase.Schema {
    override fun create(driver: SqlDriver): QueryResult.Value<Unit> {
        LionReaderDatabase.Schema.create(driver)
        SEARCH_TRIGGERS.forEach { driver.execute(null, it, 0) }
        return QueryResult.Unit
    }
}

private val SEARCH_TRIGGERS =
    listOf(
        """
        CREATE TRIGGER entry_search_insert AFTER INSERT ON entry BEGIN
          INSERT INTO entry_search(rowid, title, author, source, summary)
          VALUES (NEW.rowid, NEW.title, NEW.author, COALESCE(NEW.feed_title, NEW.site_name),
            NEW.summary);
        END
        """,
        """
        CREATE TRIGGER entry_search_update
        AFTER UPDATE OF title, author, feed_title, site_name, summary ON entry
        WHEN OLD.title IS NOT NEW.title OR OLD.author IS NOT NEW.author
          OR OLD.feed_title IS NOT NEW.feed_title OR OLD.site_name IS NOT NEW.site_name
          OR OLD.summary IS NOT NEW.summary
        BEGIN
          UPDATE entry_search
          SET title = NEW.title, author = NEW.author,
            source = COALESCE(NEW.feed_title, NEW.site_name), summary = NEW.summary
          WHERE rowid = NEW.rowid;
        END
        """,
        """
        CREATE TRIGGER entry_search_delete AFTER DELETE ON entry BEGIN
          DELETE FROM entry_search WHERE rowid = OLD.rowid;
        END
        """,
        // INSERT OR REPLACE doesn't fire delete triggers, so a replaced body
        // only fires this one.
        """
        CREATE TRIGGER entry_search_body AFTER INSERT ON entry_body BEGIN
          UPDATE entry_search SET body = NEW.search_text
          WHERE rowid = (SELECT rowid FROM entry WHERE id = NEW.entry_id);
          UPDATE entry_body SET search_text = '' WHERE entry_id = NEW.entry_id;
        END
        """,
        """
        CREATE TRIGGER entry_search_body_delete AFTER DELETE ON entry_body BEGIN
          UPDATE entry_search SET body = NULL
          WHERE rowid = (SELECT rowid FROM entry WHERE id = OLD.entry_id);
        END
        """,
    )

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
