package com.lionreader.shared.links

/** [url] if it's a web address, the only kind the app opens, shares or links: feeds supply them. */
fun webUrl(url: String?): String? =
    url?.trim()?.takeIf { it.startsWith("https://", true) || it.startsWith("http://", true) }
