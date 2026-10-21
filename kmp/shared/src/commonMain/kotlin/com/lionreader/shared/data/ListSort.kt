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

/** By date, in every list's direction ([oldestFirst], a setting). */
fun dateSort(oldestFirst: Boolean): ListSort = if (oldestFirst) ListSort.OLDEST else ListSort.NEWEST

/**
 * What a list is shown in, as the server lists it (`planEntryPage`): by what the user chose for it
 * on this screen, while it has values for that, else by its default: position (first first) for a
 * list with positions, so a book opens at its first chapter, and date for any other. Nothing
 * remembers a choice past the screen (that's #2100).
 */
fun shownSort(chosen: ListSort?, sortable: Sortable, oldestFirst: Boolean): ListSort =
    when {
        chosen?.field == SortField.DATE -> dateSort(oldestFirst)
        chosen != null && sortable.has(chosen.field) -> chosen
        sortable.position -> ListSort.FIRST
        else -> dateSort(oldestFirst)
    }
