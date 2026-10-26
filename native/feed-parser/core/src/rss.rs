//! RSS 2.0 / RSS 1.0 (RDF) parser — a direct port of the old
//! `src/server/feed/streaming/rss-parser.ts` state machine. Keep the control
//! flow in lockstep with that file's `onopentag`/`onclosetag` handlers; the
//! TS behavior tests are the parity gate.

use crate::types::{DateCandidate, ParsedEntry, ParsedFeed, VALID_UPDATE_PERIODS};
use crate::xml::{js_parse_int, js_trim, run_sax, Attrs, SaxHandler};

#[derive(Clone, Copy, PartialEq)]
enum State {
    Initial,
    InChannel,
    InItem,
    InChannelTitle,
    InChannelLink,
    InChannelDescription,
    InChannelTtl,
    InChannelSyUpdatePeriod,
    InChannelSyUpdateFrequency,
    InImage,
    InImageUrl,
    InItemTitle,
    InItemLink,
    InItemDescription,
    InItemContentEncoded,
    InItemGuid,
    InItemAuthor,
    InItemDcCreator,
    InItemPubDate,
    InItemDcDate,
}

#[derive(Default)]
struct Item {
    entry: ParsedEntry,
    /// Mirrors `currentItemContentEncoded`: the last value assigned from a
    /// `content:encoded` element (None when that element was empty), used to
    /// decide whether a `<description>` may also populate `content`.
    content_encoded: Option<String>,
    /// RSS `<author>` values, used only when the item has no `dc:creator`
    /// (which names authors rather than email addresses).
    rss_authors: Vec<String>,
}

struct RssHandler {
    feed: ParsedFeed,
    current: Option<Item>,
    state: State,
    buf: String,
    is_rdf: bool,
    max_entries: usize,
}

impl SaxHandler for RssHandler {
    fn on_open(&mut self, tag: &str, attrs: &Attrs) {
        // Before processing the new tag, capture any pending text content
        // from the current state. This handles malformed XML where elements
        // aren't properly closed (e.g. `<link>http://example.com<pubdate>`).
        let trimmed = js_trim(&self.buf);
        if !trimmed.is_empty() {
            let text = trimmed.to_string();

            // Channel-level text capture for unclosed elements.
            match self.state {
                State::InChannelLink => {
                    self.feed.site_url = Some(text.clone());
                    self.state = State::InChannel;
                }
                State::InChannelTitle => {
                    self.feed.title = Some(text.clone());
                    self.state = State::InChannel;
                }
                State::InChannelDescription => {
                    self.feed.description = Some(text.clone());
                    self.state = State::InChannel;
                }
                _ => {}
            }

            // Item-level text capture for unclosed elements.
            if let Some(item) = self.current.as_mut() {
                match self.state {
                    State::InItemLink => {
                        item.entry.link = Some(text);
                        self.state = State::InItem;
                    }
                    State::InItemTitle => {
                        item.entry.title = Some(text);
                        self.state = State::InItem;
                    }
                    State::InItemPubDate => {
                        item.entry.date_candidates.push(DateCandidate {
                            primary: true,
                            value: text,
                        });
                        self.state = State::InItem;
                    }
                    State::InItemDcDate => {
                        item.entry.date_candidates.push(DateCandidate {
                            primary: false,
                            value: text,
                        });
                        self.state = State::InItem;
                    }
                    State::InItemGuid => {
                        item.entry.guid = Some(text);
                        self.state = State::InItem;
                    }
                    State::InItemDescription => {
                        item.entry.summary = Some(text.clone());
                        if item.content_encoded.is_none() {
                            item.entry.content = Some(text);
                        }
                        self.state = State::InItem;
                    }
                    State::InItemContentEncoded => {
                        item.content_encoded = Some(text.clone());
                        item.entry.content = Some(text);
                        self.state = State::InItem;
                    }
                    State::InItemAuthor => {
                        item.rss_authors.push(text);
                        self.state = State::InItem;
                    }
                    State::InItemDcCreator => {
                        item.entry.authors.push(text);
                        self.state = State::InItem;
                    }
                    _ => {}
                }
            }
        }

        if tag == "rdf:rdf" {
            self.is_rdf = true;
            self.state = State::InChannel;
        }

        if tag == "channel" {
            self.state = State::InChannel;
        }

        if tag == "item" {
            self.state = State::InItem;
            self.current = Some(Item::default());
        }

        // Channel-level elements. (RDF puts items outside <channel>, hence
        // the initial-state arm.)
        if self.state == State::InChannel || (self.is_rdf && self.state == State::Initial) {
            match tag {
                "title" => self.state = State::InChannelTitle,
                // `!attribs.rel` — absent OR empty (falsy) rel counts.
                "link" if attrs.get_nonempty("rel").is_none() => self.state = State::InChannelLink,
                "description" => self.state = State::InChannelDescription,
                "ttl" => self.state = State::InChannelTtl,
                "sy:updateperiod" => self.state = State::InChannelSyUpdatePeriod,
                "sy:updatefrequency" => self.state = State::InChannelSyUpdateFrequency,
                "image" => self.state = State::InImage,
                _ => {}
            }

            if tag == "atom:link" {
                let rel = attrs.get("rel");
                if let Some(href) = attrs.get_nonempty("href") {
                    if rel == Some("hub") {
                        self.feed.hub_url = Some(href.to_string());
                    }
                    if rel == Some("self") {
                        self.feed.self_url = Some(href.to_string());
                    }
                }
            }
        }

        if self.state == State::InImage && tag == "url" {
            self.state = State::InImageUrl;
        }

        if self.state == State::InItem && self.current.is_some() {
            match tag {
                "title" => self.state = State::InItemTitle,
                "link" => self.state = State::InItemLink,
                "description" => self.state = State::InItemDescription,
                "content:encoded" => self.state = State::InItemContentEncoded,
                "guid" => self.state = State::InItemGuid,
                "author" => self.state = State::InItemAuthor,
                "dc:creator" => self.state = State::InItemDcCreator,
                "pubdate" => self.state = State::InItemPubDate,
                "dc:date" => self.state = State::InItemDcDate,
                _ => {}
            }
        }

        self.buf.clear();
    }

    fn on_text(&mut self, text: &str) {
        self.buf.push_str(text);
    }

    fn on_close(&mut self, tag: &str) {
        let trimmed = js_trim(&self.buf);
        let decoded: Option<String> = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };

        // Channel-level elements.
        match self.state {
            State::InChannelTitle => {
                self.feed.title = decoded.clone();
                self.state = State::InChannel;
            }
            State::InChannelLink => {
                self.feed.site_url = decoded.clone();
                self.state = State::InChannel;
            }
            State::InChannelDescription => {
                self.feed.description = decoded.clone();
                self.state = State::InChannel;
            }
            State::InChannelTtl => {
                if let Some(text) = &decoded {
                    if let Some(parsed) = js_parse_int(text) {
                        if parsed > 0.0 {
                            self.feed.ttl_minutes = Some(parsed);
                        }
                    }
                }
                self.state = State::InChannel;
            }
            State::InChannelSyUpdatePeriod => {
                if let Some(text) = &decoded {
                    let normalized = text.to_lowercase();
                    if VALID_UPDATE_PERIODS.contains(&normalized.as_str()) {
                        self.feed.update_period = Some(normalized);
                    }
                }
                self.state = State::InChannel;
            }
            State::InChannelSyUpdateFrequency => {
                if let Some(text) = &decoded {
                    if let Some(parsed) = js_parse_int(text) {
                        if parsed > 0.0 {
                            self.feed.update_frequency = Some(parsed);
                        }
                    }
                }
                self.state = State::InChannel;
            }
            State::InImageUrl => {
                self.feed.icon_url = decoded.clone();
                self.state = State::InImage;
            }
            State::InImage if tag == "image" => {
                self.state = State::InChannel;
            }
            _ => {}
        }

        // Item-level elements.
        if let Some(item) = self.current.as_mut() {
            match self.state {
                State::InItemTitle => {
                    item.entry.title = decoded.clone();
                    self.state = State::InItem;
                }
                State::InItemLink => {
                    item.entry.link = decoded.clone();
                    self.state = State::InItem;
                }
                State::InItemDescription => {
                    item.entry.summary = decoded.clone();
                    if item.content_encoded.is_none() {
                        item.entry.content = decoded.clone();
                    }
                    self.state = State::InItem;
                }
                State::InItemContentEncoded => {
                    item.content_encoded = decoded.clone();
                    item.entry.content = decoded.clone();
                    self.state = State::InItem;
                }
                State::InItemGuid => {
                    item.entry.guid = decoded.clone();
                    self.state = State::InItem;
                }
                State::InItemAuthor => {
                    item.rss_authors.extend(decoded.clone());
                    self.state = State::InItem;
                }
                State::InItemDcCreator => {
                    item.entry.authors.extend(decoded.clone());
                    self.state = State::InItem;
                }
                State::InItemPubDate => {
                    if let Some(text) = &decoded {
                        item.entry.date_candidates.push(DateCandidate {
                            primary: true,
                            value: text.clone(),
                        });
                    }
                    self.state = State::InItem;
                }
                State::InItemDcDate => {
                    if let Some(text) = &decoded {
                        item.entry.date_candidates.push(DateCandidate {
                            primary: false,
                            value: text.clone(),
                        });
                    }
                    self.state = State::InItem;
                }
                _ => {}
            }
        }

        // End of item — add to entries.
        if tag == "item" {
            if let Some(mut item) = self.current.take() {
                if item.entry.authors.is_empty() {
                    item.entry.authors = item.rss_authors;
                }
                if self.feed.entries.len() < self.max_entries {
                    self.feed.entries.push(item.entry);
                }
                self.state = if self.is_rdf {
                    State::Initial
                } else {
                    State::InChannel
                };
            }
        }

        if tag == "channel" {
            self.state = State::Initial;
        }

        self.buf.clear();
    }
}

/// Parses an RSS feed (RSS 2.0 or RSS 1.0/RDF) from a string, keeping its
/// first `max_entries` items. The rest are still parsed (channel elements may
/// follow them) but dropped as soon as each closes.
pub fn parse_rss(content: &str, max_entries: usize) -> Result<ParsedFeed, String> {
    let mut handler = RssHandler {
        feed: ParsedFeed::default(),
        current: None,
        state: State::Initial,
        buf: String::new(),
        is_rdf: false,
        max_entries,
    };
    run_sax(content, true, &mut handler)?;
    Ok(handler.feed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_rss() {
        let xml = r#"<?xml version="1.0"?>
            <rss version="2.0">
              <channel>
                <title>Example Feed</title>
                <link>https://example.com</link>
                <ttl>60</ttl>
                <item>
                  <title>First &#039;Post&#039;</title>
                  <link>https://example.com/post-1</link>
                  <description><![CDATA[<p>Hi &lt;code&gt;</p>]]></description>
                  <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
                </item>
              </channel>
            </rss>"#;
        let feed = parse_rss(xml, usize::MAX).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Example Feed"));
        assert_eq!(feed.site_url.as_deref(), Some("https://example.com"));
        assert_eq!(feed.ttl_minutes, Some(60.0));
        assert_eq!(feed.entries.len(), 1);
        let entry = &feed.entries[0];
        assert_eq!(entry.title.as_deref(), Some("First 'Post'"));
        assert_eq!(entry.content.as_deref(), Some("<p>Hi &lt;code&gt;</p>"));
        assert_eq!(
            entry.date_candidates,
            vec![DateCandidate {
                primary: true,
                value: "Mon, 01 Jan 2024 12:00:00 GMT".to_string()
            }]
        );
    }

    #[test]
    fn collects_every_author_preferring_dc_creator() {
        let xml = r#"<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
              <channel>
                <item>
                  <guid>both</guid>
                  <author>a@example.com (Ada)</author>
                  <dc:creator>Ada Lovelace</dc:creator>
                  <dc:creator></dc:creator>
                  <dc:creator><![CDATA[Alan Turing]]></dc:creator>
                </item>
                <item>
                  <guid>rss-only</guid>
                  <author>a@example.com</author>
                  <author>b@example.com</author>
                </item>
              </channel>
            </rss>"#;
        let feed = parse_rss(xml, usize::MAX).unwrap();
        assert_eq!(feed.entries[0].authors, ["Ada Lovelace", "Alan Turing"]);
        assert_eq!(feed.entries[1].authors, ["a@example.com", "b@example.com"]);
    }

    #[test]
    fn unclosed_comment_or_cdata_keeps_content_parsed_before_it() {
        // htmlparser2 treated an unclosed comment/CDATA as swallowing the
        // rest of the input without erroring; the parse keeps whatever came
        // before. quick-xml reports these as EOF SyntaxErrors, which run_sax
        // maps to a graceful end-of-input.
        let xml = r#"<rss version="2.0">
          <channel>
            <title>Feed</title>
            <item><title>Post</title><guid>p1</guid></item>
            <!-- unclosed comment swallows the rest
            <item><title>Never seen</title></item>
        "#;
        let feed = parse_rss(xml, usize::MAX).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Feed"));
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.entries[0].guid.as_deref(), Some("p1"));

        let xml = r#"<rss><channel><title>Feed</title><item><guid>p1</guid></item><description><![CDATA[never closed"#;
        let feed = parse_rss(xml, usize::MAX).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Feed"));
        assert_eq!(feed.entries.len(), 1);
    }

    #[test]
    fn truncated_feed_implicitly_closes_open_elements() {
        // htmlparser2 fired onclosetag for every still-open element at EOF,
        // so a truncated feed keeps its last partially-written entry.
        let feed = parse_rss("<rss><channel><title>Feed", usize::MAX).unwrap();
        assert_eq!(feed.title.as_deref(), Some("Feed"));
        assert!(feed.entries.is_empty());

        let feed = parse_rss(
            "<rss><channel><title>Feed</title><item><title>Post",
            usize::MAX,
        )
        .unwrap();
        assert_eq!(feed.title.as_deref(), Some("Feed"));
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.entries[0].title.as_deref(), Some("Post"));
    }

    #[test]
    fn end_tag_dispatch_matches_htmlparser2_stack_semantics() {
        // An end tag closes down to its nearest open match (</item> closes
        // the unclosed <title> first)...
        let feed = parse_rss(
            "<rss><channel><item><title>Post</item><item><guid>g2</guid></item>",
            usize::MAX,
        )
        .unwrap();
        assert_eq!(feed.entries.len(), 2);
        assert_eq!(feed.entries[0].title.as_deref(), Some("Post"));
        assert_eq!(feed.entries[1].guid.as_deref(), Some("g2"));

        // ...and an end tag with no open match is ignored entirely, so the
        // text buffer keeps accumulating across it.
        let feed = parse_rss(
            "<rss><channel><item><description>foo</p>bar</description></item></channel></rss>",
            usize::MAX,
        )
        .unwrap();
        assert_eq!(feed.entries[0].summary.as_deref(), Some("foobar"));
        assert_eq!(feed.entries[0].content.as_deref(), Some("foobar"));

        // A deep close (</channel> while inside an item title) captures the
        // title and pushes the entry on the way out.
        let feed = parse_rss(
            "<rss><channel><item><title>Post</channel></rss>",
            usize::MAX,
        )
        .unwrap();
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.entries[0].title.as_deref(), Some("Post"));
    }

    #[test]
    fn handles_unclosed_link_tags() {
        let xml = r#"<rss version="2.0">
          <channel>
            <title>Test Feed</title>
            <link>https://example.com
            <description>Test description</description>
            <item>
              <title>Post</title>
              <link>https://example.com/post-1
              <pubdate>Mon, 01 Jan 2024 12:00:00 GMT</pubdate>
            </item>
          </channel>
        </rss>"#;
        let feed = parse_rss(xml, usize::MAX).unwrap();
        assert_eq!(feed.site_url.as_deref(), Some("https://example.com"));
        assert_eq!(feed.description.as_deref(), Some("Test description"));
        assert_eq!(
            feed.entries[0].link.as_deref(),
            Some("https://example.com/post-1")
        );
        assert_eq!(feed.entries[0].date_candidates.len(), 1);
    }

    #[test]
    fn keeps_first_max_entries_and_channel_elements_after_them() {
        let xml = r#"<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
          <channel>
            <item><guid>g1</guid></item>
            <item><guid>g2</guid></item>
            <item><guid>g3</guid></item>
            <title>Feed</title>
            <atom:link rel="hub" href="https://hub.example.com/"/>
          </channel>
        </rss>"#;
        let feed = parse_rss(xml, 2).unwrap();
        let guids: Vec<_> = feed.entries.iter().map(|e| e.guid.as_deref()).collect();
        assert_eq!(guids, [Some("g1"), Some("g2")]);
        assert_eq!(feed.title.as_deref(), Some("Feed"));
        assert_eq!(feed.hub_url.as_deref(), Some("https://hub.example.com/"));

        // RDF puts items outside <channel>; a dropped item must still return
        // the parser to the state that reads elements after it.
        let rdf = r#"<rdf:RDF><item><guid>g1</guid></item><item><guid>g2</guid></item>
          <channel><title>Feed</title></channel></rdf:RDF>"#;
        let feed = parse_rss(rdf, 1).unwrap();
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.title.as_deref(), Some("Feed"));
    }
}
