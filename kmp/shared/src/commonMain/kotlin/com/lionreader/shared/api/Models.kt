package com.lionreader.shared.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject

// Wire models for the `/api/v1` REST API. The contract is
// `docs/api/openapi.json`; fields the app doesn't use are left out and ignored
// on decode, so additive server changes never break an installed app.

@Serializable
data class EntryListItem(
    val id: String,
    /** The entry's origin: its feed's subscription, or Saved for a saved article. */
    val subscriptionId: String? = null,
    /**
     * Every active subscription holding the entry (its feed, its collections, Saved for a saved
     * article): the lists it's in.
     */
    val subscriptionIds: List<String>,
    /**
     * `web`, `email` or `saved`; a string, so a type newer than this app still decodes. What's
     * saved is decided by [subscriptionIds]; the type only picks the shown source.
     */
    val type: String,
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
    /** When read state last changed; null if it never has. */
    val readChangedAt: String? = null,
)

@Serializable
data class EntryListPage(val items: List<EntryListItem>, val nextCursor: String? = null)

@Serializable
data class FullEntry(
    val id: String,
    val subscriptionId: String? = null,
    /** As [EntryListItem.subscriptionIds]. */
    val subscriptionIds: List<String>,
    val type: String,
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
    /** The sanitized body the web's entry view shows by default; null when there's none. */
    val content: String?,
    val readChangedAt: String? = null,
)

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
    val read: Boolean,
    val starred: Boolean,
    val readChangedAt: String? = null,
)

@Serializable data class BulkStateResponse(val entries: List<EntryState>)

@Serializable data class TagRef(val id: String, val name: String, val color: String? = null)

/**
 * [Subscription.type] of a collection: a list of articles from other feeds (see
 * SubscriptionEntry.sq).
 */
const val COLLECTION_TYPE = "collection"

/**
 * [Subscription.type] of the user's Saved subscription, which the server lists once the first save
 * creates it: the app learns its id from that row. Also [EntryListItem.type] of a saved article.
 */
const val SAVED_TYPE = "saved"

@Serializable
data class Subscription(
    val id: String,
    /** A string, so a type newer than this app still decodes (like [EntryListItem.type]). */
    val type: String,
    val url: String? = null,
    /** The custom title if there is one, else [originalTitle]. */
    val title: String? = null,
    /** The feed's own title. */
    val originalTitle: String? = null,
    val tags: List<TagRef>,
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
    val deletions: List<Deletion>,
    val resyncRequired: Boolean,
)

@Serializable
data class EventEntry(
    /** As [EntryListItem.type]. */
    val type: String,
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

/**
 * What `subscription_created` carried before its `row`: a server that predates it sends only this.
 */
@Serializable
data class EventSubscription(
    val id: String,
    val customTitle: String? = null,
    val tags: List<TagRef>,
)

/** As [EventSubscription]. */
@Serializable
data class EventFeed(
    val url: String? = null,
    val title: String? = null,
    /** The subscription's type, as [Subscription.type]. */
    val type: String,
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
        /** As [EntryListItem.subscriptionIds]. */
        val subscriptionIds: List<String>,
        /** Absent for spam, which the server's lists leave out. */
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
        /** As [EntryListItem.subscriptionIds]; sent with or without [entry]. */
        val subscriptionIds: List<String>,
        val subscriptionId: String? = null,
        val entry: EventEntry? = null,
    ) : SyncEvent

    @Serializable
    @SerialName("subscription_created")
    data class SubscriptionCreated(
        val subscriptionId: String,
        /** The subscription as the server lists it; null from a server that predates it. */
        val row: Subscription? = null,
        val subscription: EventSubscription? = null,
        val feed: EventFeed? = null,
    ) : SyncEvent {
        /** [row], or else what an older server sent in its place. */
        val subscriptionRow: Subscription
            get() =
                row
                    ?: Subscription(
                        subscriptionId,
                        type = feed?.type,
                        url = feed?.url,
                        title = subscription?.customTitle ?: feed?.title,
                        originalTitle = feed?.title,
                        tags = subscription?.tags.orEmpty(),
                    )
    }

    @Serializable
    @SerialName("subscription_updated")
    data class SubscriptionUpdated(
        val subscriptionId: String,
        /** As [SubscriptionCreated.row]; without it, [tags] and [customTitle] say what changed. */
        val row: Subscription? = null,
        val tags: List<TagRef> = emptyList(),
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

/** [id] is what speech requests take; [name] is for showing. */
@Serializable data class CloudVoice(val id: String, val name: String)

@Serializable
data class VoiceModel(
    val id: String,
    val displayName: String,
    val voices: List<CloudVoice>,
    /** A voice id. */
    val defaultVoice: String,
    /** The provider's id, e.g. `deepinfra`. */
    val provider: String,
    /** The provider's name, for showing, e.g. `DeepInfra`. */
    val providerDisplayName: String,
) {
    fun hasVoice(id: String): Boolean = voices.any { it.id == id }

    fun voiceName(id: String): String = voices.firstOrNull { it.id == id }?.name ?: id
}

@Serializable
data class VoiceModels(val models: List<VoiceModel>, val defaultModelId: String) {
    /** The server's default model, or failing that the first. */
    val defaultModel: VoiceModel?
        get() = models.firstOrNull { it.id == defaultModelId } ?: models.firstOrNull()

    /**
     * What narration uses for the chosen [modelId] and [voiceId] (null: the defaults): each if it's
     * still offered, else the default model, and its default voice. Null when there are no models.
     */
    fun resolve(modelId: String?, voiceId: String?): ResolvedVoice? {
        val model = models.firstOrNull { it.id == modelId } ?: defaultModel ?: return null
        return ResolvedVoice(model, voiceId?.takeIf(model::hasVoice) ?: model.defaultVoice)
    }
}

/** A cloud model and one of its voices' id. */
data class ResolvedVoice(val model: VoiceModel, val voice: String)

@Serializable
data class SpeechRequest(
    val model: String,
    val voice: String,
    val text: String,
    /** Silence the server adds after the speech. */
    val pauseSeconds: Float,
)

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
