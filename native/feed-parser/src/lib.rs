//! N-API bindings for the Lion Reader feed parser. All logic lives in the
//! `lion-reader-feed-parser-core` crate (unit-testable without Node); this
//! crate only maps types across the boundary.
//!
//! Each parser has a synchronous form (for background jobs, which already run
//! off the request path) and an async form that runs on the libuv thread pool
//! (for app-server request paths), mirroring `@lion-reader/sanitizer` and
//! `@lion-reader/readability`.
//!
//! The string conversions here are the dominant boundary cost for
//! content-heavy feeds. Zero-copy external strings
//! (`node_api_create_external_string_latin1`) were tried and rejected — real
//! feed bodies are almost never pure ASCII, and even 100%-ASCII data only
//! gained ~1.2x because V8's UTF-8 copy is already cheap for one-byte
//! strings. See `bench/README.md` and issue #1291 for the numbers and the
//! reverted implementation.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};

use lion_reader_feed_parser_core as core;

#[napi(object)]
pub struct DateCandidate {
    /// `true` for the primary date element (RSS `pubDate`, Atom `published`):
    /// a successfully-parsed value overwrites any previously selected date.
    /// `false` for the fallback element (RSS `dc:date`, Atom `updated`): it
    /// applies only while no date has been selected yet.
    pub primary: bool,
    pub value: String,
}

#[napi(object)]
pub struct RawParsedEntry {
    pub guid: Option<String>,
    pub link: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    /// Absent when `content_is_summary` is set — the caller reuses `summary`.
    pub content: Option<String>,
    pub summary: Option<String>,
    /// True when the entry's content is byte-identical to its summary (the
    /// common description-only RSS / summary-only Atom case). The string is
    /// then shipped across the N-API boundary once, as `summary`, instead of
    /// being materialized as two separate JS strings — for feeds that deliver
    /// whole articles in `<description>`, that halves the dominant cost of
    /// the parse (V8 string creation) and the resulting JS fields share one
    /// string.
    pub content_is_summary: bool,
    /// Media RSS `media:description` (plain text; Atom/YouTube feeds).
    pub media_description: Option<String>,
    /// Media RSS `media:thumbnail` URL, first one found.
    pub media_thumbnail_url: Option<String>,
    /// Raw date strings in document order; the caller replays selection with
    /// the JS date parsers (see `src/server/feed/streaming/`).
    pub date_candidates: Vec<DateCandidate>,
}

#[napi(object)]
pub struct RawParsedFeed {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub hub_url: Option<String>,
    pub self_url: Option<String>,
    /// RSS `<ttl>` in minutes (already validated > 0).
    pub ttl_minutes: Option<f64>,
    /// `sy:updatePeriod`, lowercased and validated.
    pub update_period: Option<String>,
    /// `sy:updateFrequency` (already validated > 0).
    pub update_frequency: Option<f64>,
    pub entries: Vec<RawParsedEntry>,
}

#[napi(object)]
pub struct RawOpmlFeed {
    pub xml_url: String,
    pub title: Option<String>,
    pub html_url: Option<String>,
    pub category: Option<Vec<String>>,
}

#[napi(object)]
pub struct RawOpmlResult {
    pub feeds: Vec<RawOpmlFeed>,
    /// Whether an `<opml>` element was seen (validation stays in TS).
    pub has_opml: bool,
    /// Whether a `<body>` element was seen (validation stays in TS).
    pub has_body: bool,
}

fn convert_entry(entry: core::types::ParsedEntry) -> RawParsedEntry {
    // See `content_is_summary`: comparing the two Rust strings (a memcmp) is
    // orders of magnitude cheaper than creating a redundant JS string.
    let content_is_summary = entry.content.is_some() && entry.content == entry.summary;
    RawParsedEntry {
        guid: entry.guid,
        link: entry.link,
        title: entry.title,
        author: entry.author,
        content: if content_is_summary {
            None
        } else {
            entry.content
        },
        summary: entry.summary,
        content_is_summary,
        media_description: entry.media_description,
        media_thumbnail_url: entry.media_thumbnail_url,
        date_candidates: entry
            .date_candidates
            .into_iter()
            .map(|c| DateCandidate {
                primary: c.primary,
                value: c.value,
            })
            .collect(),
    }
}

fn convert_feed(feed: core::types::ParsedFeed) -> RawParsedFeed {
    RawParsedFeed {
        title: feed.title,
        description: feed.description,
        site_url: feed.site_url,
        icon_url: feed.icon_url,
        hub_url: feed.hub_url,
        self_url: feed.self_url,
        ttl_minutes: feed.ttl_minutes,
        update_period: feed.update_period,
        update_frequency: feed.update_frequency,
        entries: feed.entries.into_iter().map(convert_entry).collect(),
    }
}

fn convert_opml(result: core::types::OpmlResult) -> RawOpmlResult {
    RawOpmlResult {
        feeds: result
            .feeds
            .into_iter()
            .map(|feed| RawOpmlFeed {
                xml_url: feed.xml_url,
                title: feed.title,
                html_url: feed.html_url,
                category: feed.category,
            })
            .collect(),
        has_opml: result.has_opml,
        has_body: result.has_body,
    }
}

/// A panic inside the parser would otherwise unwind across the N-API boundary
/// and abort the whole Node process; surface it as an ordinary JS error.
fn run_guarded<T>(label: &str, f: impl FnOnce() -> std::result::Result<T, String>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err("parser panicked".to_string()))
        .map_err(|message| Error::new(Status::GenericFailure, format!("{label}: {message}")))
}

fn run_parse_rss(content: &str) -> Result<RawParsedFeed> {
    run_guarded("RSS parse failed", || core::rss::parse_rss(content)).map(convert_feed)
}

fn run_parse_atom(content: &str) -> Result<RawParsedFeed> {
    run_guarded("Atom parse failed", || core::atom::parse_atom(content)).map(convert_feed)
}

fn run_parse_opml(content: &str) -> Result<RawOpmlResult> {
    run_guarded("OPML parse failed", || core::opml::parse_opml(content)).map(convert_opml)
}

/// Parses an RSS feed (RSS 2.0 or RSS 1.0/RDF). Synchronous.
#[napi]
pub fn parse_rss(content: String) -> Result<RawParsedFeed> {
    run_parse_rss(&content)
}

/// Parses an Atom feed. Synchronous.
#[napi]
pub fn parse_atom(content: String) -> Result<RawParsedFeed> {
    run_parse_atom(&content)
}

/// Parses an OPML file. Synchronous.
#[napi]
pub fn parse_opml(content: String) -> Result<RawOpmlResult> {
    run_parse_opml(&content)
}

pub enum FeedFormat {
    Rss,
    Atom,
}

pub struct ParseFeedJob {
    content: String,
    format: FeedFormat,
}

impl Task for ParseFeedJob {
    type Output = RawParsedFeed;
    type JsValue = RawParsedFeed;

    fn compute(&mut self) -> Result<Self::Output> {
        match self.format {
            FeedFormat::Rss => run_parse_rss(&self.content),
            FeedFormat::Atom => run_parse_atom(&self.content),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async form of `parseRss`: runs on the libuv thread pool so large feeds
/// never block the event loop.
#[napi(ts_return_type = "Promise<RawParsedFeed>")]
pub fn parse_rss_async(content: String) -> AsyncTask<ParseFeedJob> {
    AsyncTask::new(ParseFeedJob {
        content,
        format: FeedFormat::Rss,
    })
}

/// Async form of `parseAtom`: runs on the libuv thread pool so large feeds
/// never block the event loop.
#[napi(ts_return_type = "Promise<RawParsedFeed>")]
pub fn parse_atom_async(content: String) -> AsyncTask<ParseFeedJob> {
    AsyncTask::new(ParseFeedJob {
        content,
        format: FeedFormat::Atom,
    })
}

pub struct ParseOpmlJob {
    content: String,
}

impl Task for ParseOpmlJob {
    type Output = RawOpmlResult;
    type JsValue = RawOpmlResult;

    fn compute(&mut self) -> Result<Self::Output> {
        run_parse_opml(&self.content)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async form of `parseOpml`: runs on the libuv thread pool so large OPML
/// files never block the event loop.
#[napi(ts_return_type = "Promise<RawOpmlResult>")]
pub fn parse_opml_async(content: String) -> AsyncTask<ParseOpmlJob> {
    AsyncTask::new(ParseOpmlJob { content })
}
