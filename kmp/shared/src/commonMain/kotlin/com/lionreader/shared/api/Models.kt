package com.lionreader.shared.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject

// Wire models for the `/api/v1` REST API. The contract is
// `docs/api/openapi.json`; fields the app doesn't use are left out and ignored
// on decode, so additive server changes never break an installed app.

@Serializable
enum class FeedType {
    @SerialName("web") WEB,
    @SerialName("email") EMAIL,
    @SerialName("saved") SAVED,
}

@Serializable
data class EntryListItem(
    val id: String,
    val subscriptionId: String? = null,
    val feedId: String,
    val type: FeedType,
    val url: String? = null,
    val title: String? = null,
    val author: String? = null,
    val summary: String? = null,
    val publishedAt: String? = null,
    val fetchedAt: String,
    val read: Boolean,
    val starred: Boolean,
    val feedTitle: String? = null,
    val siteName: String? = null,
    /** When read state last changed; null if it never has (or from an older server). */
    val readChangedAt: String? = null,
)

@Serializable
data class EntryListPage(val items: List<EntryListItem>, val nextCursor: String? = null)

@Serializable
data class FullEntry(
    val id: String,
    val subscriptionId: String? = null,
    val feedId: String,
    val type: FeedType,
    val url: String? = null,
    val title: String? = null,
    val author: String? = null,
    val summary: String? = null,
    val publishedAt: String? = null,
    val fetchedAt: String,
    val read: Boolean,
    val starred: Boolean,
    val feedTitle: String? = null,
    val siteName: String? = null,
    val contentOriginal: String? = null,
    val contentCleaned: String? = null,
    val fullContentCleaned: String? = null,
    val fullContentOriginal: String? = null,
    val fetchFullContent: Boolean = false,
    val readChangedAt: String? = null,
) {
    /** The body the web reader shows by default for this entry. */
    val displayContent: String?
        get() =
            (if (fetchFullContent) fullContentCleaned ?: fullContentOriginal else null)
                ?: contentCleaned
                ?: contentOriginal
                ?: summary
}

@Serializable data class GetManyRequest(val ids: List<String>)

@Serializable data class GetManyResponse(val entries: List<FullEntry>)

@Serializable data class StateChange(val id: String, val changedAt: String? = null)

@Serializable
data class MarkReadRequest(
    val entries: List<StateChange>,
    val read: Boolean,
    val clientSentAt: String,
)

@Serializable
data class SetStarredRequest(
    val entries: List<StateChange>,
    val starred: Boolean,
    val clientSentAt: String,
)

@Serializable
data class EntryState(
    val id: String,
    val subscriptionId: String? = null,
    val read: Boolean,
    val starred: Boolean,
    val readChangedAt: String? = null,
)

@Serializable data class BulkStateResponse(val entries: List<EntryState>)

@Serializable data class TagRef(val id: String, val name: String, val color: String? = null)

@Serializable
data class Subscription(
    val id: String,
    val type: FeedType,
    val url: String? = null,
    val title: String? = null,
    val siteUrl: String? = null,
    val tags: List<TagRef> = emptyList(),
    val fetchFullContent: Boolean = false,
)

@Serializable
data class SubscriptionPage(val items: List<Subscription>, val nextCursor: String? = null)

@Serializable data class Tag(val id: String, val name: String, val color: String? = null)

@Serializable data class TagList(val items: List<Tag>)

@Serializable
data class SyncCursors(
    val entries: String? = null,
    val entriesAfterId: String? = null,
    val subscriptions: String? = null,
    val tags: String? = null,
    val deletions: String? = null,
)

@Serializable data class Deletion(val entryId: String, val deletedAt: String)

@Serializable
data class SyncChanges(
    /** Raw, so an event type newer than this app is skipped; see [parseSyncEvent]. */
    val events: List<JsonObject>,
    val hasMore: Boolean,
    val cursors: SyncCursors,
    val deletions: List<Deletion> = emptyList(),
    val resyncRequired: Boolean = false,
)

@Serializable
data class EventEntry(
    val title: String? = null,
    val author: String? = null,
    val summary: String? = null,
    val url: String? = null,
    val publishedAt: String? = null,
    val fetchedAt: String,
    val siteName: String? = null,
    val feedTitle: String? = null,
    val read: Boolean? = null,
    val starred: Boolean? = null,
    val readChangedAt: String? = null,
)

@Serializable
data class EntryMetadata(
    val title: String? = null,
    val author: String? = null,
    val summary: String? = null,
    val url: String? = null,
    val publishedAt: String? = null,
)

@Serializable
data class EventSubscription(
    val id: String,
    val feedId: String,
    val customTitle: String? = null,
    val tags: List<TagRef> = emptyList(),
)

@Serializable
data class EventFeed(
    val id: String,
    val type: FeedType,
    val url: String? = null,
    val title: String? = null,
    val siteUrl: String? = null,
)

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed interface SyncEvent {
    @Serializable
    @SerialName("new_entry")
    data class NewEntry(
        val entryId: String,
        val subscriptionId: String? = null,
        val feedId: String? = null,
        val feedType: FeedType,
        val entry: EventEntry? = null,
    ) : SyncEvent

    @Serializable
    @SerialName("entry_updated")
    data class EntryUpdated(val entryId: String, val metadata: EntryMetadata) : SyncEvent

    @Serializable
    @SerialName("entry_state_changed")
    data class EntryStateChanged(
        val entryId: String,
        val read: Boolean,
        val starred: Boolean,
        val readChangedAt: String? = null,
        val subscriptionId: String? = null,
        val feedId: String? = null,
        val feedType: FeedType? = null,
        val entry: EventEntry? = null,
    ) : SyncEvent

    @Serializable
    @SerialName("subscription_created")
    data class SubscriptionCreated(
        val subscription: EventSubscription,
        val feed: EventFeed,
    ) : SyncEvent

    @Serializable
    @SerialName("subscription_updated")
    data class SubscriptionUpdated(
        val subscriptionId: String,
        val tags: List<TagRef>,
        val customTitle: String? = null,
    ) : SyncEvent

    @Serializable
    @SerialName("subscription_deleted")
    data class SubscriptionDeleted(val subscriptionId: String) : SyncEvent

    @Serializable @SerialName("tag_created") data class TagCreated(val tag: TagRef) : SyncEvent

    @Serializable @SerialName("tag_updated") data class TagUpdated(val tag: TagRef) : SyncEvent

    @Serializable @SerialName("tag_deleted") data class TagDeleted(val tagId: String) : SyncEvent
}

@Serializable data class AccountUser(val id: String, val email: String)

@Serializable data class Me(val user: AccountUser)

/** The server's limit on one speech request. */
const val MAX_CLOUD_SPEECH_CHARS = 1000

@Serializable
data class VoiceModel(
    val id: String,
    val displayName: String,
    /** Ids, which are what synthesis takes. */
    val voices: List<String>,
    val defaultVoice: String,
    /** Display names, for the voices whose name isn't their id. */
    val voiceNames: Map<String, String> = emptyMap(),
    /** The provider's id (e.g. `deepinfra`); absent from older servers. */
    val provider: String? = null,
    /** The provider's name, for showing (e.g. `DeepInfra`); absent from older servers. */
    val providerDisplayName: String? = null,
) {
    val providerName: String?
        get() = providerDisplayName ?: provider

    fun voiceName(id: String): String = voiceNames[id] ?: id
}

@Serializable data class VoiceModels(val models: List<VoiceModel>, val defaultModelId: String)

// Both always sent: the server requires the keys, and ApiJson drops nulls.
@Serializable data class SpeechRequest(val model: String, val voice: String, val text: String)

@Serializable data class SaveArticleRequest(val url: String)

@Serializable data class SavedArticle(val id: String, val title: String? = null)

@Serializable data class SaveArticleResponse(val article: SavedArticle)

@Serializable data class SummarizationAvailability(val available: Boolean)

@Serializable data class GenerateSummaryRequest(val entryId: String)

@Serializable data class GeneratedSummary(val summary: String)

@Serializable
data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Long,
)
