//! N-API bindings for the Lion Reader feed parser. All logic lives in the
//! `lion-reader-feed-parser-core` crate (unit-testable without Node); this
//! crate only maps types across the boundary.
//!
//! Each parser has a synchronous form (for background jobs, which already run
//! off the request path) and an async form that runs on the libuv thread pool
//! (for app-server request paths), mirroring `@lion-reader/sanitizer` and
//! `@lion-reader/readability`.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};

use lion_reader_feed_parser_core as core;

mod external_string;

use external_string::LargeString;

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
    /// `LargeString`: converts to JS as a zero-copy external string when
    /// large and pure ASCII (see `external_string.rs`).
    pub content: Option<LargeString>,
    pub summary: Option<LargeString>,
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
        // The LargeString conversions also run the external-eligibility
        // (ASCII) scan here, inside `Task::compute` for async parses — off
        // the main thread.
        content: if content_is_summary {
            None
        } else {
            entry.content.map(LargeString::from)
        },
        summary: entry.summary.map(LargeString::from),
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

#[napi(object)]
pub struct StringConversionStats {
    /// Zero-copy external Latin-1 strings actually created.
    pub external_created: f64,
    /// External creation requested but V8 copied anyway (`copied` out-param).
    pub external_declined_copied: f64,
    /// At/above the size threshold but not pure ASCII — ordinary copy.
    pub copied_non_ascii: f64,
    /// Below the size threshold — ordinary copy.
    pub copied_small: f64,
    /// External API unavailable (Node < 20.4) — ordinary copy.
    pub copied_no_api: f64,
}

/// Process-lifetime counters for how content/summary strings crossed the
/// N-API boundary. Diagnostic only (benchmarks, GC stress tests).
#[napi]
pub fn string_conversion_stats() -> StringConversionStats {
    use std::sync::atomic::Ordering;
    StringConversionStats {
        external_created: external_string::EXTERNAL_CREATED.load(Ordering::Relaxed) as f64,
        external_declined_copied: external_string::EXTERNAL_DECLINED_COPIED.load(Ordering::Relaxed)
            as f64,
        copied_non_ascii: external_string::COPIED_NON_ASCII.load(Ordering::Relaxed) as f64,
        copied_small: external_string::COPIED_SMALL.load(Ordering::Relaxed) as f64,
        copied_no_api: external_string::COPIED_NO_API.load(Ordering::Relaxed) as f64,
    }
}
