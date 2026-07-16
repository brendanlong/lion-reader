//! Output types shared by the RSS and Atom parsers. These mirror the old
//! `FeedParseResult`/`ParsedEntry` shapes, except that dates are returned as
//! ordered raw-string candidates for the TypeScript wrapper to parse (see the
//! crate docs for why).

/// One raw date string from an entry, in document order.
#[derive(Debug, Clone, PartialEq)]
pub struct DateCandidate {
    /// `true` for the primary element (RSS `pubDate`, Atom `published`): a
    /// successfully-parsed value overwrites any previously selected date.
    /// `false` for the fallback element (RSS `dc:date`, Atom `updated`): it
    /// applies only while no date has been selected yet.
    pub primary: bool,
    pub value: String,
}

/// A parsed feed entry. All fields mirror the old `ParsedEntry`, with `None`
/// standing in for `undefined`.
#[derive(Debug, Default, Clone)]
pub struct ParsedEntry {
    pub guid: Option<String>,
    pub link: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub content: Option<String>,
    pub summary: Option<String>,
    /// Media RSS `media:description` (Atom parser only — YouTube).
    pub media_description: Option<String>,
    /// Media RSS `media:thumbnail` URL, first one found (Atom parser only).
    pub media_thumbnail_url: Option<String>,
    /// Raw date strings in document order; the TS wrapper replays selection.
    pub date_candidates: Vec<DateCandidate>,
}

/// Parsed feed metadata + entries, mirroring the old `FeedParseResult`.
#[derive(Debug, Default)]
pub struct ParsedFeed {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_url: Option<String>,
    pub icon_url: Option<String>,
    pub hub_url: Option<String>,
    pub self_url: Option<String>,
    /// RSS `<ttl>`, parsed with JS `parseInt` semantics and required > 0.
    pub ttl_minutes: Option<f64>,
    /// `sy:updatePeriod`, lowercased and validated against the RSS 1.0
    /// syndication module's value set.
    pub update_period: Option<String>,
    /// `sy:updateFrequency`, parsed with JS `parseInt` semantics, required > 0.
    pub update_frequency: Option<f64>,
    pub entries: Vec<ParsedEntry>,
}

/// A feed from an OPML file, mirroring the old `OpmlFeed`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpmlFeed {
    pub xml_url: String,
    pub title: Option<String>,
    pub html_url: Option<String>,
    pub category: Option<Vec<String>>,
}

/// Result of OPML parsing. Structural validation (the old "missing opml
/// element" / "missing body element" errors) is left to the caller via the
/// `has_*` flags so the error type/messages stay in TypeScript.
#[derive(Debug, Default)]
pub struct OpmlResult {
    pub feeds: Vec<OpmlFeed>,
    pub has_opml: bool,
    pub has_body: bool,
}

/// Valid `sy:updatePeriod` values (RSS 1.0 Syndication Module).
pub const VALID_UPDATE_PERIODS: [&str; 5] = ["hourly", "daily", "weekly", "monthly", "yearly"];
