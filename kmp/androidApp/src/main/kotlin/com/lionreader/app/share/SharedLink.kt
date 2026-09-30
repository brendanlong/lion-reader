package com.lionreader.app.share

private val LINK = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)

/**
 * The link in text another app shared: the first http(s) URL, since apps often send "Title
 * https://…" or a sentence around it. Closing punctuation the URL is wrapped in isn't part of it.
 */
fun sharedLink(text: String?): String? {
    val match = LINK.find(text ?: return null)?.value ?: return null
    var link = match.trimEnd('.', ',', ';', ':', '!', '?', '"', '\'', '>')
    // A ")" belongs to the link only if the link opened one (Wikipedia-style titles).
    while (link.endsWith(')') && link.count { it == ')' } > link.count { it == '(' }) {
        link = link.dropLast(1).trimEnd('.', ',', ';', ':', '!', '?', '"', '\'')
    }
    return link
}
