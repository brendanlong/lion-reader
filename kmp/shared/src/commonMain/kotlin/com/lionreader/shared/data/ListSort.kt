package com.lionreader.shared.data

/** What a list can be ordered by (#2064). */
enum class SortField(val label: String) {
    DATE("Date"),
    /** The user's score for each entry (set by an AI assistant), higher first. */
    SCORE("Score"),
    /** Each entry's place in a collection (an ebook's chapters), lower first. */
    POSITION("Position"),
}

/**
 * A list's order: its [field] and a direction, named for what the number means, the field's default
 * first. Entries without a score or position come after those with one in both directions, newest
 * first, as the server orders them (`planEntryPage`), so Lowest isn't Highest reversed.
 */
enum class ListSort(val field: SortField, val label: String) {
    NEWEST(SortField.DATE, "Newest"),
    OLDEST(SortField.DATE, "Oldest"),
    HIGHEST(SortField.SCORE, "Highest"),
    LOWEST(SortField.SCORE, "Lowest"),
    FIRST(SortField.POSITION, "First"),
    LAST(SortField.POSITION, "Last");

    companion object {
        fun directions(field: SortField): List<ListSort> = entries.filter { it.field == field }
    }
}

/** Which orders besides date a list has values for, as the server's `sortable`. */
data class Sortable(val score: Boolean, val position: Boolean) {
    fun has(field: SortField): Boolean =
        when (field) {
            SortField.DATE -> true
            SortField.SCORE -> score
            SortField.POSITION -> position
        }

    /** The fields to offer, Date always. */
    val fields: List<SortField>
        get() = SortField.entries.filter(::has)

    companion object {
        val DATE_ONLY = Sortable(score = false, position = false)
    }
}

/**
 * What a list is shown in: its [chosen] order while the list has values for it, else by date
 * ([oldestFirst]), keeping the choice for when they come back.
 */
fun shownSort(chosen: ListSort, sortable: Sortable, oldestFirst: Boolean): ListSort =
    if (sortable.has(chosen.field)) chosen
    else if (oldestFirst) ListSort.OLDEST else ListSort.NEWEST

/** The key a list's chosen order is kept under (`AppSettings.listSorts`). */
val ListScope.sortKey: String
    get() =
        when (this) {
            ListScope.All -> "all"
            ListScope.Starred -> "starred"
            ListScope.Saved -> "saved"
            ListScope.Uncategorized -> "uncategorized"
            ListScope.RecentlyRead -> "recently-read"
            is ListScope.Subscription -> "subscription:$id"
            is ListScope.Tag -> "tag:$id"
        }
