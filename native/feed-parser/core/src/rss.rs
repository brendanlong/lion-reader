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
}

struct RssHandler {
    feed: ParsedFeed,
    current: Option<Item>,
    state: State,
    buf: String,
    is_rdf: bool,
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
                        if item.entry.author.is_none() {
                            item.entry.author = Some(text);
                        }
                        self.state = State::InItem;
                    }
                    State::InItemDcCreator => {
                        item.entry.author = Some(text);
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
                "link" if attrs.get_nonempty("rel").is_none() => {
                    self.state = State::InChannelLink
                }
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
                    if item.entry.author.is_none() {
                        item.entry.author = decoded.clone();
                    }
                    self.state = State::InItem;
                }
                State::InItemDcCreator => {
                    item.entry.author = decoded.clone();
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
            if let Some(item) = self.current.take() {
                self.feed.entries.push(item.entry);
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

/// Parses an RSS feed (RSS 2.0 or RSS 1.0/RDF) from a string.
pub fn parse_rss(content: &str) -> Result<ParsedFeed, String> {
    let mut handler = RssHandler {
        feed: ParsedFeed::default(),
        current: None,
        state: State::Initial,
        buf: String::new(),
        is_rdf: false,
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
        let feed = parse_rss(xml).unwrap();
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
        let feed = parse_rss(xml).unwrap();
        assert_eq!(feed.site_url.as_deref(), Some("https://example.com"));
        assert_eq!(feed.description.as_deref(), Some("Test description"));
        assert_eq!(
            feed.entries[0].link.as_deref(),
            Some("https://example.com/post-1")
        );
        assert_eq!(feed.entries[0].date_candidates.len(), 1);
    }
}
