//! Atom 1.0 parser — a direct port of the old
//! `src/server/feed/streaming/atom-parser.ts` state machine. Keep the control
//! flow in lockstep with that file's `onopentag`/`onclosetag` handlers; the
//! TS behavior tests are the parity gate.

use crate::types::{DateCandidate, ParsedEntry, ParsedFeed, VALID_UPDATE_PERIODS};
use crate::xml::{js_parse_int, js_trim, run_sax, Attrs, SaxHandler};

#[derive(Clone, Copy, PartialEq)]
enum State {
    Initial,
    InFeed,
    InEntry,
    InFeedTitle,
    InFeedSubtitle,
    InFeedIcon,
    InFeedLogo,
    InFeedSyUpdatePeriod,
    InFeedSyUpdateFrequency,
    InEntryId,
    InEntryTitle,
    InEntrySummary,
    InEntryContent,
    InEntryMediaDescription,
    InEntryPublished,
    InEntryUpdated,
    InEntryAuthor,
    InEntryAuthorName,
}

#[derive(Default)]
struct Entry {
    entry: ParsedEntry,
    /// Mirrors `currentEntryContent`: the last value assigned from a
    /// `<content>` element, used to decide whether `<summary>` may also
    /// populate `content`.
    content: Option<String>,
}

struct AtomHandler {
    feed: ParsedFeed,
    current: Option<Entry>,
    state: State,
    buf: String,
    in_feed_level: bool,
    /// Depth of nested <source> elements inside the current entry. Atom
    /// copies an entry with a <source> describing its *original* feed
    /// (Planet-style aggregators do this), whose <id>/<title>/<published>/
    /// <link> would otherwise overwrite the entry's own fields. While inside
    /// a <source> we ignore element mapping so those children don't clobber
    /// the entry.
    source_depth: u32,
}

impl SaxHandler for AtomHandler {
    fn on_open(&mut self, tag: &str, attrs: &Attrs) {
        if tag == "feed" {
            self.state = State::InFeed;
            self.in_feed_level = true;
        }

        if tag == "entry" {
            self.state = State::InEntry;
            self.current = Some(Entry::default());
            self.in_feed_level = false;
            self.source_depth = 0;
        }

        if tag == "source" {
            self.source_depth += 1;
        }

        if self.in_feed_level && self.state == State::InFeed {
            match tag {
                "title" => self.state = State::InFeedTitle,
                "subtitle" => self.state = State::InFeedSubtitle,
                "icon" => self.state = State::InFeedIcon,
                "logo" => self.state = State::InFeedLogo,
                "sy:updateperiod" => self.state = State::InFeedSyUpdatePeriod,
                "sy:updatefrequency" => self.state = State::InFeedSyUpdateFrequency,
                _ => {}
            }

            if tag == "link" {
                let rel = attrs.get("rel");
                if let Some(href) = attrs.get_nonempty("href") {
                    // `!rel` — absent OR empty (falsy) rel means alternate.
                    let rel_falsy = rel.map_or(true, |r| r.is_empty());
                    if rel == Some("alternate") || rel_falsy {
                        self.feed.site_url = Some(href.to_string());
                    } else if rel == Some("hub") {
                        self.feed.hub_url = Some(href.to_string());
                    } else if rel == Some("self") {
                        self.feed.self_url = Some(href.to_string());
                    }
                }
            }
        }

        // Skip element mapping while inside a copied <source>: its children
        // (id/title/published/link/...) must not overwrite the entry's own
        // fields. The <source> open itself already incremented source_depth.
        if self.state == State::InEntry && self.source_depth == 0 {
            if let Some(entry) = self.current.as_mut() {
                match tag {
                    "id" => self.state = State::InEntryId,
                    "title" => self.state = State::InEntryTitle,
                    "summary" => self.state = State::InEntrySummary,
                    "content" => self.state = State::InEntryContent,
                    // Media RSS: YouTube nests these in <media:group>, which
                    // doesn't change state, so they're seen here whether
                    // grouped or direct.
                    "media:description" => self.state = State::InEntryMediaDescription,
                    "published" => self.state = State::InEntryPublished,
                    "updated" => self.state = State::InEntryUpdated,
                    "author" => self.state = State::InEntryAuthor,
                    _ => {}
                }

                if tag == "media:thumbnail" && entry.entry.media_thumbnail_url.is_none() {
                    if let Some(url) = attrs.get_nonempty("url") {
                        entry.entry.media_thumbnail_url = Some(url.to_string());
                    }
                }

                if tag == "link" {
                    let rel = attrs.get("rel");
                    if let Some(href) = attrs.get_nonempty("href") {
                        let rel_falsy = rel.map_or(true, |r| r.is_empty());
                        if rel == Some("alternate") || rel_falsy {
                            entry.entry.link = Some(href.to_string());
                        }
                    }
                }
            }
        }

        if self.state == State::InEntryAuthor && tag == "name" && self.source_depth == 0 {
            self.state = State::InEntryAuthorName;
        }

        self.buf.clear();
    }

    fn on_text(&mut self, text: &str) {
        self.buf.push_str(text);
    }

    fn on_close(&mut self, tag: &str) {
        if tag == "source" && self.source_depth > 0 {
            self.source_depth -= 1;
        }

        let trimmed = js_trim(&self.buf);
        let decoded: Option<String> = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };

        match self.state {
            State::InFeedTitle => {
                self.feed.title = decoded.clone();
                self.state = State::InFeed;
            }
            State::InFeedSubtitle => {
                self.feed.description = decoded.clone();
                self.state = State::InFeed;
            }
            State::InFeedIcon => {
                self.feed.icon_url = decoded.clone();
                self.state = State::InFeed;
            }
            State::InFeedLogo => {
                if self.feed.icon_url.is_none() {
                    self.feed.icon_url = decoded.clone();
                }
                self.state = State::InFeed;
            }
            State::InFeedSyUpdatePeriod => {
                if let Some(text) = &decoded {
                    let normalized = text.to_lowercase();
                    if VALID_UPDATE_PERIODS.contains(&normalized.as_str()) {
                        self.feed.update_period = Some(normalized);
                    }
                }
                self.state = State::InFeed;
            }
            State::InFeedSyUpdateFrequency => {
                if let Some(text) = &decoded {
                    if let Some(parsed) = js_parse_int(text) {
                        if parsed > 0.0 {
                            self.feed.update_frequency = Some(parsed);
                        }
                    }
                }
                self.state = State::InFeed;
            }
            _ => {}
        }

        if let Some(entry) = self.current.as_mut() {
            match self.state {
                State::InEntryId => {
                    entry.entry.guid = decoded.clone();
                    self.state = State::InEntry;
                }
                State::InEntryTitle => {
                    entry.entry.title = decoded.clone();
                    self.state = State::InEntry;
                }
                State::InEntrySummary => {
                    entry.entry.summary = decoded.clone();
                    if entry.content.is_none() {
                        entry.entry.content = decoded.clone();
                    }
                    self.state = State::InEntry;
                }
                State::InEntryContent => {
                    entry.content = decoded.clone();
                    entry.entry.content = decoded.clone();
                    self.state = State::InEntry;
                }
                State::InEntryMediaDescription => {
                    entry.entry.media_description = decoded.clone();
                    self.state = State::InEntry;
                }
                State::InEntryPublished => {
                    if let Some(text) = &decoded {
                        entry.entry.date_candidates.push(DateCandidate {
                            primary: true,
                            value: text.clone(),
                        });
                    }
                    self.state = State::InEntry;
                }
                State::InEntryUpdated => {
                    if let Some(text) = &decoded {
                        entry.entry.date_candidates.push(DateCandidate {
                            primary: false,
                            value: text.clone(),
                        });
                    }
                    self.state = State::InEntry;
                }
                State::InEntryAuthorName => {
                    entry.entry.author = decoded.clone();
                    self.state = State::InEntryAuthor;
                }
                State::InEntryAuthor if tag == "author" => {
                    self.state = State::InEntry;
                }
                _ => {}
            }
        }

        if tag == "entry" {
            if let Some(entry) = self.current.take() {
                self.feed.entries.push(entry.entry);
                self.state = State::InFeed;
                self.in_feed_level = true;
            }
        }

        if tag == "feed" {
            self.state = State::Initial;
            self.in_feed_level = false;
        }

        self.buf.clear();
    }
}

/// Parses an Atom feed from a string.
pub fn parse_atom(content: &str) -> Result<ParsedFeed, String> {
    let mut handler = AtomHandler {
        feed: ParsedFeed::default(),
        current: None,
        state: State::Initial,
        buf: String::new(),
        in_feed_level: false,
        source_depth: 0,
    };
    run_sax(content, true, &mut handler)?;
    Ok(handler.feed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_atom() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>Example Atom Feed</title>
              <link href="https://example.com" rel="alternate"/>
              <link href="https://example.com/feed.xml" rel="self"/>
              <entry>
                <id>urn:1</id>
                <title>First Entry</title>
                <link href="https://example.com/entry-1"/>
                <summary>Summary</summary>
                <content type="html">Full content</content>
                <published>2024-01-01T12:00:00Z</published>
                <author><name>John Doe</name></author>
              </entry>
            </feed>"#;
        let feed = parse_atom(xml).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Example Atom Feed"));
        assert_eq!(feed.site_url.as_deref(), Some("https://example.com"));
        assert_eq!(
            feed.self_url.as_deref(),
            Some("https://example.com/feed.xml")
        );
        let entry = &feed.entries[0];
        assert_eq!(entry.guid.as_deref(), Some("urn:1"));
        assert_eq!(entry.link.as_deref(), Some("https://example.com/entry-1"));
        assert_eq!(entry.summary.as_deref(), Some("Summary"));
        assert_eq!(entry.content.as_deref(), Some("Full content"));
        assert_eq!(entry.author.as_deref(), Some("John Doe"));
    }

    #[test]
    fn source_metadata_does_not_clobber_entry() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom">
              <title>Aggregator</title>
              <entry>
                <id>urn:entry:guid</id>
                <title>My Title</title>
                <source>
                  <id>urn:source</id>
                  <title>Source</title>
                  <updated>2019-05-05T00:00:00Z</updated>
                </source>
                <updated>2024-07-07T09:00:00Z</updated>
              </entry>
            </feed>"#;
        let feed = parse_atom(xml).unwrap();
        let entry = &feed.entries[0];
        assert_eq!(entry.guid.as_deref(), Some("urn:entry:guid"));
        assert_eq!(entry.title.as_deref(), Some("My Title"));
        assert_eq!(
            entry.date_candidates,
            vec![DateCandidate {
                primary: false,
                value: "2024-07-07T09:00:00Z".to_string()
            }]
        );
    }
}
