package com.lionreader.shared.home

import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.Navigation

/** The list's name, for its title bar: a tag's or feed's own, once [navigation] has loaded. */
fun listTitle(scope: ListScope, navigation: Navigation?): String =
    when (scope) {
        ListScope.All -> "All"
        ListScope.Starred -> "Starred"
        ListScope.Saved -> "Saved"
        ListScope.RecentlyRead -> "Recently read"
        ListScope.Uncategorized -> "Uncategorized"
        is ListScope.Tag -> navigation?.tags?.firstOrNull { it.id == scope.id }?.name ?: "Tag"
        is ListScope.Subscription ->
            navigation?.subscriptions?.firstOrNull { it.id == scope.id }?.title ?: "Feed"
    }
