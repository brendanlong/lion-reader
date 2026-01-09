# LessWrong RSS & GraphQL API Reference

This document describes the RSS feed capabilities and GraphQL API for LessWrong (and related forums like EA Forum and Alignment Forum that use the ForumMagnum codebase).

## Table of Contents

- [RSS Feed](#rss-feed)
  - [Endpoint](#endpoint)
  - [Query Parameters](#query-parameters)
  - [Post Feed Views](#post-feed-views)
  - [Comment Feed Views](#comment-feed-views)
  - [Karma Threshold Logic](#karma-threshold-logic)
  - [Feed Item Structure](#feed-item-structure)
- [GraphQL API](#graphql-api)
  - [Endpoint](#graphql-endpoint)
  - [Posts](#posts)
  - [Users](#users)
  - [Comments](#comments)
  - [Tags](#tags)
- [Common Use Cases](#common-use-cases)

---

## RSS Feed

### Endpoint

```
GET /feed.xml
```

Returns an RSS 2.0 feed. Response is cached at the CDN for 10 minutes.

### Query Parameters

| Parameter         | Type   | Description                                                   |
| ----------------- | ------ | ------------------------------------------------------------- |
| `view`            | string | Feed type/view (see views below). Defaults to `rss`           |
| `type`            | string | Set to `comments` for comment feeds, otherwise returns posts  |
| `karmaThreshold`  | number | Minimum karma for posts to appear (see threshold logic below) |
| `filterSettings`  | JSON   | Advanced filtering (JSON-encoded object)                      |
| `tagId`           | string | For `tagRelevance` view - filter by tag ID                    |
| `userId`          | string | Filter by author user ID                                      |
| `parentCommentId` | string | For comment feeds - filter to replies of specific comment     |

### Post Feed Views

| View            | Description                           | Sort Order                 |
| --------------- | ------------------------------------- | -------------------------- |
| `rss` (default) | All newest posts                      | `postedAt` descending      |
| `frontpageRss`  | Frontpage posts only                  | `frontpageDate` descending |
| `curatedRss`    | Curated posts only                    | `curatedDate` descending   |
| `communityRss`  | Non-frontpage posts with karma > 2    | `postedAt` descending      |
| `metaRss`       | Meta posts only                       | `postedAt` descending      |
| `tagRelevance`  | Posts by tag (requires `tagId` param) | Tag relevance score        |

Note: View names can use either camelCase (`frontpageRss`) or kebab-case (`frontpage-rss`).

### Comment Feed Views

| View                | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `commentReplies`    | Replies to a specific comment (use with `parentCommentId`) |
| `recentComments`    | Recent comments with positive score (score > 0)            |
| `allRecentComments` | All recent comments including neutral/negative             |

### Karma Threshold Logic

The `karmaThreshold` parameter determines when posts appear in the feed based on when they reached certain karma levels. Posts have timestamps for when they exceeded various karma thresholds.

Input values are rounded to the nearest supported threshold:

| Input Range       | Actual Threshold | Date Field Used        |
| ----------------- | ---------------- | ---------------------- |
| < 16 (or not set) | 2                | `scoreExceeded2Date`   |
| 16-36             | 30               | `scoreExceeded30Date`  |
| 37-59             | 45               | `scoreExceeded45Date`  |
| 60-99             | 75               | `scoreExceeded75Date`  |
| 100-161           | 125              | `scoreExceeded125Date` |
| >= 162            | 200              | `scoreExceeded200Date` |

The feed item's date is the _later_ of:

1. The karma threshold date (when post reached the threshold)
2. The view-specific date (e.g., `frontpageDate` for frontpage feed)

This allows higher-threshold feeds to show older posts that recently became popular.

### Feed Item Structure

Each RSS item contains:

| Field         | Description                                                |
| ------------- | ---------------------------------------------------------- |
| `title`       | Post/comment title                                         |
| `description` | "Published on [date]" + full HTML content + "Discuss" link |
| `author`      | Display name or "[anonymous]"                              |
| `date`        | Computed date (see karma threshold logic)                  |
| `guid`        | Post/comment ID (for deduplication)                        |
| `url`         | Full URL to post/comment                                   |

**Example Post Feed URL:**

```
https://www.lesswrong.com/feed.xml?view=frontpageRss&karmaThreshold=30
```

**Example Comment Thread Feed URL:**

```
https://www.lesswrong.com/feed.xml?type=comments&view=commentReplies&parentCommentId=abc123
```

---

## GraphQL API

### GraphQL Endpoint

```
POST /graphql
```

Standard GraphQL endpoint. All queries should use the POST method with a JSON body containing `query` and `variables`.

### Posts

#### Query: `posts`

Fetch multiple posts with filtering and pagination.

```graphql
query posts($selector: PostSelector, $limit: Int, $offset: Int, $enableTotal: Boolean) {
  posts(selector: $selector, limit: $limit, offset: $offset, enableTotal: $enableTotal) {
    results {
      _id
      title
      slug
      postedAt
      # ... other fields
    }
    totalCount
  }
}
```

#### Query: `post`

Fetch a single post by ID or slug.

```graphql
query post($selector: SelectorInput) {
  post(selector: $selector) {
    result {
      _id
      title
      # ... fields
    }
  }
}
```

**Selector examples:**

```json
// By ID
{ "_id": "abc123" }

// By slug
{ "slug": "my-post-title" }
```

#### Post Selector Views

The `PostSelector` input accepts exactly one view key:

| View           | Parameters               | Description                    |
| -------------- | ------------------------ | ------------------------------ |
| `default`      | standard filters         | Default post list              |
| `userPosts`    | `userId`                 | Posts by specific user         |
| `frontpage`    | -                        | Frontpage posts                |
| `frontpageRss` | -                        | Frontpage posts (RSS ordering) |
| `curated`      | -                        | Curated posts                  |
| `curatedRss`   | -                        | Curated posts (RSS ordering)   |
| `community`    | -                        | Community posts                |
| `communityRss` | -                        | Community posts (RSS ordering) |
| `metaRss`      | -                        | Meta posts                     |
| `rss`          | -                        | General RSS feed               |
| `new`          | -                        | Newest posts                   |
| `top`          | -                        | Highest-scoring posts          |
| `magic`        | -                        | Algorithm-ranked posts         |
| `tagRelevance` | `tagId`                  | Posts by tag relevance         |
| `slugPost`     | `slug`                   | Single post by slug            |
| `legacyIdPost` | `legacyId`               | Post by legacy ID              |
| `drafts`       | -                        | User's draft posts             |
| `topQuestions` | -                        | Top question posts             |
| `events`       | filters                  | Event posts                    |
| `nearbyEvents` | `lat`, `lng`, `distance` | Geographically nearby events   |
| `globalEvents` | -                        | Global/online events           |

**Common filter parameters** (available on most views):

| Parameter        | Type     | Description                                               |
| ---------------- | -------- | --------------------------------------------------------- |
| `postIds`        | [String] | Include only these post IDs                               |
| `notPostIds`     | [String] | Exclude these post IDs                                    |
| `userId`         | String   | Filter by author                                          |
| `af`             | Boolean  | Alignment Forum posts only                                |
| `question`       | Boolean  | Question posts only                                       |
| `karmaThreshold` | Int      | Minimum karma                                             |
| `excludeEvents`  | Boolean  | Exclude event posts                                       |
| `after`          | String   | Posts after this date (ISO string)                        |
| `before`         | String   | Posts before this date                                    |
| `sortedBy`       | String   | Sort mode: `magic`, `top`, `new`, `old`, `recentComments` |
| `filterSettings` | JSON     | Advanced filtering settings                               |

#### Key Post Fields

**Core fields:**

- `_id`: Post ID
- `title`: Post title
- `slug`: URL slug
- `url`: External URL (for link posts)
- `postedAt`: Publication timestamp
- `userId`: Author user ID
- `user`: Author user object (nested)
- `coauthors`: Co-author user objects

**Content:**

- `contents`: Post content object with `html`, `markdown`, `wordCount`
- `customHighlight`: Custom excerpt HTML

**Scores & Engagement:**

- `baseScore`: Karma score
- `score`: Current weighted score
- `voteCount`: Number of votes
- `commentCount`: Number of comments
- `viewCount`: View count
- `extendedScore`: Extended score breakdown (for forums with multiple vote axes)

**Dates:**

- `postedAt`: Original publication date
- `frontpageDate`: When added to frontpage
- `curatedDate`: When curated
- `lastCommentedAt`: Last comment timestamp
- `scoreExceeded2Date` through `scoreExceeded200Date`: Karma milestone dates

**Status:**

- `draft`: Is draft
- `unlisted`: Is unlisted
- `sticky`: Is pinned
- `question`: Is a question post
- `debate`: Is a dialogue/debate post
- `isEvent`: Is an event
- `meta`: Is a meta post
- `af`: Is an Alignment Forum post
- `frontpageDate`: Non-null if on frontpage
- `curatedDate`: Non-null if curated

**Tags:**

- `tags`: Array of associated tag objects
- `tagRelevance`: JSONB object mapping tag IDs to relevance scores

**Events (when `isEvent` is true):**

- `startTime`, `endTime`: Event timing
- `location`: Location text
- `googleLocation`: Structured location data
- `onlineEvent`: Is online
- `globalEvent`: Is global

### Users

#### Query: `users`

```graphql
query users($selector: UserSelector, $limit: Int) {
  users(selector: $selector, limit: $limit) {
    results {
      _id
      displayName
      slug
      karma
      # ... fields
    }
    totalCount
  }
}
```

#### Query: `user`

```graphql
query user($selector: UserSelectorUniqueInput) {
  user(selector: $selector) {
    result {
      _id
      displayName
      # ... fields
    }
  }
}
```

**UserSelectorUniqueInput:**

```graphql
input UserSelectorUniqueInput {
  _id: String # User ID
  documentId: String # Alias for _id
  slug: String # User's URL slug
}
```

#### User Selector Views

| View             | Parameters           | Description           |
| ---------------- | -------------------- | --------------------- |
| `default`        | -                    | Default view          |
| `usersByUserIds` | `userIds: [String!]` | Specific users by ID  |
| `usersProfile`   | `userId` or `slug`   | Single user profile   |
| `allUsers`       | -                    | All users             |
| `recentlyActive` | -                    | Recently active users |
| `usersTopKarma`  | -                    | Users sorted by karma |

#### Key User Fields

**Identity:**

- `_id`: User ID
- `username`: Username
- `displayName`: Display name
- `slug`: Profile URL slug
- `email`: Email (only visible to user themselves)
- `createdAt`: Account creation date

**Profile:**

- `htmlBio`: Bio/description HTML
- `profileImageId`: Avatar image ID
- `jobTitle`: Job title
- `organization`: Organization
- `website`: Personal website
- `location`: Location text

**Social links:**

- `twitterProfileURL`
- `facebookProfileURL`
- `linkedinProfileURL`
- `githubProfileURL`
- `blueskyProfileURL`

**Stats:**

- `karma`: Total karma
- `afKarma`: Alignment Forum karma
- `postCount`: Number of posts
- `commentCount`: Number of comments
- `sequenceCount`: Sequences created

**Status:**

- `deleted`: Account deleted
- `isAdmin`: Is administrator
- `groups`: User groups array

### Comments

#### Query: `comments`

```graphql
query comments($selector: CommentSelector, $limit: Int) {
  comments(selector: $selector, limit: $limit) {
    results {
      _id
      contents {
        html
      }
      postedAt
      user {
        displayName
      }
      # ... fields
    }
    totalCount
  }
}
```

#### Comment Selector Views

| View                        | Key Parameters    | Description                 |
| --------------------------- | ----------------- | --------------------------- |
| `default`                   | -                 | Default view                |
| `postCommentsTop`           | `postId`          | Top comments on a post      |
| `postCommentsNew`           | `postId`          | Newest comments on a post   |
| `postCommentsOld`           | `postId`          | Oldest comments on a post   |
| `postCommentsMagic`         | `postId`          | Algorithm-ranked comments   |
| `postCommentsRecentReplies` | `postId`          | Recent replies              |
| `commentReplies`            | `parentCommentId` | Replies to specific comment |
| `profileComments`           | `userId`          | User's comments             |
| `recentComments`            | `sortBy`, `limit` | Recent comments (score > 0) |
| `allRecentComments`         | `sortBy`, `limit` | All recent comments         |
| `questionAnswers`           | `postId`          | Answers to a question post  |

**Common parameters:**

- `userId`: Filter by author
- `postId`: Filter by post
- `commentIds`: Include only these comment IDs
- `minimumKarma`: Minimum score
- `sortBy`: Sort mode (`top`, `new`, `old`, `magic`, `recentComments`)
- `limit`: Max results

#### Key Comment Fields

**Core:**

- `_id`: Comment ID
- `postId`: Parent post ID
- `userId`: Author user ID
- `user`: Author user object
- `parentCommentId`: Direct parent comment ID
- `topLevelCommentId`: Root comment of thread
- `contents`: Comment content with `html`, `markdown`

**Metadata:**

- `postedAt`: Posted timestamp
- `lastEditedAt`: Last edit timestamp
- `baseScore`: Karma score
- `voteCount`: Vote count
- `descendentCount`: Total reply count
- `directChildrenCount`: Direct reply count

**Status:**

- `deleted`: Is deleted
- `draft`: Is draft
- `answer`: Is an answer to a question
- `retracted`: Author retracted
- `moderatorHat`: Posted as moderator
- `promoted`: Promoted comment

### Tags

#### Query: `tags`

```graphql
query tags($selector: TagSelector, $limit: Int) {
  tags(selector: $selector, limit: $limit) {
    results {
      _id
      name
      slug
      postCount
      # ... fields
    }
  }
}
```

#### Query: `tag`

```graphql
query tag($selector: SelectorInput) {
  tag(selector: $selector) {
    result {
      _id
      name
      slug
      description {
        html
      }
    }
  }
}
```

#### Tag Selector Views

| View                  | Parameters           | Description               |
| --------------------- | -------------------- | ------------------------- |
| `default`             | -                    | Default view              |
| `tagsByTagIds`        | `tagIds: [String!]!` | Specific tags by ID       |
| `tagBySlug`           | `slug`               | Single tag by slug        |
| `tagsBySlugs`         | `slugs: [String!]!`  | Multiple tags by slug     |
| `allTagsAlphabetical` | -                    | All tags alphabetically   |
| `coreTags`            | -                    | Core/featured tags        |
| `suggestedFilterTags` | -                    | Tags suggested as filters |

#### Key Tag Fields

- `_id`: Tag ID
- `name`: Tag name
- `shortName`: Short name (if different)
- `slug`: URL slug
- `postCount`: Number of tagged posts
- `core`: Is a core tag
- `deleted`: Is deleted
- `isSubforum`: Has subforum
- `description`: Tag description with `html`, `htmlHighlight`
- `parentTag`: Parent tag (for hierarchical tags)
- `subTags`: Child tags

---

## Common Use Cases

### Get recent frontpage posts

```graphql
query RecentFrontpage {
  posts(selector: { frontpage: {} }, limit: 20) {
    results {
      _id
      title
      slug
      postedAt
      baseScore
      commentCount
      user {
        displayName
        slug
      }
      contents {
        htmlHighlight
      }
    }
  }
}
```

### Get posts by a specific user

```graphql
query UserPosts($userId: String!) {
  posts(selector: { userPosts: { userId: $userId } }, limit: 50) {
    results {
      _id
      title
      slug
      postedAt
      baseScore
    }
  }
}
```

### Get posts with a specific tag

```graphql
query TaggedPosts($tagId: String!) {
  posts(selector: { tagRelevance: { tagId: $tagId } }, limit: 30) {
    results {
      _id
      title
      slug
      postedAt
      baseScore
      tagRelevance
    }
  }
}
```

### Get a post with its comments

```graphql
query PostWithComments($postId: String!) {
  post(selector: { _id: $postId }) {
    result {
      _id
      title
      contents {
        html
      }
      user {
        displayName
      }
    }
  }
  comments(selector: { postCommentsTop: { postId: $postId } }, limit: 100) {
    results {
      _id
      contents {
        html
      }
      postedAt
      baseScore
      parentCommentId
      user {
        displayName
      }
    }
  }
}
```

### Get user profile with recent activity

```graphql
query UserProfile($slug: String!) {
  user(selector: { slug: $slug }) {
    result {
      _id
      displayName
      slug
      karma
      createdAt
      htmlBio
      postCount
      commentCount
    }
  }
}
```

### RSS Feed: High-quality frontpage posts

```
GET /feed.xml?view=frontpageRss&karmaThreshold=75
```

### RSS Feed: Curated posts only

```
GET /feed.xml?view=curatedRss
```

### RSS Feed: Posts with specific tag

```
GET /feed.xml?view=tagRelevance&tagId=TAG_ID_HERE
```

---

## Notes

- The GraphQL API is the primary way to access rich, structured data
- RSS feeds are best for simple subscription use cases
- For real-time updates, poll the GraphQL API (no WebSocket support)
- Rate limiting may apply; be respectful with request frequency
- All timestamps are in ISO 8601 format
- Post content is available as HTML, markdown, or plaintext depending on the field
