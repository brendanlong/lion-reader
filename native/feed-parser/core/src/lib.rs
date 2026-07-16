//! Core logic of the Lion Reader feed parser (RSS 2.0 / RSS 1.0-RDF, Atom,
//! OPML).
//!
//! This crate is pure Rust (no N-API) so it can be unit-tested with plain
//! `cargo test`. The thin napi wrapper crate in the parent directory exposes
//! the parse functions to Node.
//!
//! Each parser is a direct port of the old htmlparser2-based SAX state machine
//! (`src/server/feed/streaming/{rss,atom,opml}-parser.ts`), running on
//! quick-xml — same streaming model, no DOM. The TS behavior tests
//! (`tests/unit/streaming-feed-parser-*.test.ts`) are the parity gate, so the
//! ports preserve the old semantics exactly, including the handling of
//! real-world malformed feeds (unclosed `<link>`/`<title>` elements).
//!
//! Date strings are deliberately NOT parsed here: the old parsers used V8's
//! lenient `new Date()` (plus RSS-specific fallbacks), which no Rust date
//! library reproduces. Entries instead carry the raw date strings as ordered
//! [`types::DateCandidate`]s and the TypeScript wrapper replays the original
//! selection logic (pubDate/published overwrite when they parse; dc:date/
//! updated apply only while no date is set) with the original JS parsers.

pub mod atom;
pub mod opml;
pub mod rss;
pub mod types;
pub mod xml;
