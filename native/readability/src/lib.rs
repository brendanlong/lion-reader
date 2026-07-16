//! N-API bindings for article extraction. The algorithm is the `dom_smoothie`
//! crate — a Rust port of Mozilla Readability that stays synced with upstream —
//! so this crate only maps options and results across the boundary.
//!
//! Extraction policy (which options to use, minimum-length gates, URL
//! absolutization) lives in TypeScript (`src/server/feed/content-cleaner.ts`);
//! this module is a thin engine.

#[macro_use]
extern crate napi_derive;

use dom_smoothie::{Config, Readability};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};

#[napi(object)]
#[derive(Clone)]
pub struct ExtractOptions {
    /// Keep all classes on extracted elements (Mozilla `keepClasses`).
    pub keep_classes: Option<bool>,
    /// Character threshold for content detection (Mozilla `charThreshold`).
    pub char_threshold: Option<u32>,
}

#[napi(object)]
pub struct ExtractedArticle {
    /// The extracted article HTML.
    pub content: String,
    /// Plain text of the extracted article.
    pub text_content: String,
    /// Article excerpt/description, when one was found.
    pub excerpt: Option<String>,
    /// Extracted title ("" when none was found, matching readability.js).
    pub title: String,
    /// Author byline, when one was found.
    pub byline: Option<String>,
    /// Result of the fast is-probably-readable heuristic (informational —
    /// extraction ran regardless, matching the old cleanContent behavior).
    pub probably_readable: bool,
}

fn build_config(options: Option<&ExtractOptions>) -> Config {
    let mut cfg = Config::default();
    if let Some(options) = options {
        if let Some(keep_classes) = options.keep_classes {
            cfg.keep_classes = keep_classes;
        }
        if let Some(char_threshold) = options.char_threshold {
            cfg.char_threshold = char_threshold as usize;
        }
    }
    cfg
}

/// Maximum DOM nesting depth handed to the extractor. dom_smoothie's scoring
/// passes are super-linear in nesting depth (measured: depth 2000 ≈ 7s,
/// 3000 ≈ 22s, 5000 doesn't finish in a minute) and extraction runs on
/// attacker-controlled feed HTML, so pathological nesting must fail fast to
/// the raw-content fallback — the old JS pipeline got this for free by
/// overflowing the call stack (caught and mapped to null). Real articles
/// nest a few dozen levels; Blink flattens the tree beyond 512.
const MAX_DOM_DEPTH: usize = 512;

/// Iterative max-depth walk over the parsed document (recursion here would
/// hit the same stack problem we're guarding against).
fn exceeds_max_depth(reader: &Readability) -> bool {
    let mut stack: Vec<(_, usize)> = vec![(reader.doc.root(), 1)];
    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_DOM_DEPTH {
            return true;
        }
        if let Some(child) = node.first_child() {
            stack.push((child, depth + 1));
        }
        if let Some(sibling) = node.next_sibling() {
            stack.push((sibling, depth));
        }
    }
    false
}

fn run_extract(html: &str, options: Option<&ExtractOptions>) -> Result<Option<ExtractedArticle>> {
    // A panic inside the extractor (dom_smoothie has a couple of
    // partial_cmp().unwrap() sites on f32 scores) would otherwise unwind
    // across the N-API boundary and abort the whole Node process; treat it
    // as an ordinary extraction failure instead.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| extract_inner(html, options)))
        .unwrap_or(Ok(None))
}

fn extract_inner(html: &str, options: Option<&ExtractOptions>) -> Result<Option<ExtractedArticle>> {
    // No document URL: relative-URL resolution (including <base href>) is done
    // by the caller's absolutizeUrls post-pass, exactly as with the old
    // linkedom pipeline, so URL policy stays in one place.
    let mut reader = Readability::new(html, None, Some(build_config(options)))
        .map_err(|e| Error::new(Status::GenericFailure, format!("readability init failed: {e}")))?;
    if exceeds_max_depth(&reader) {
        return Ok(None);
    }
    let probably_readable = reader.is_probably_readable();
    match reader.parse() {
        Ok(article) => Ok(Some(ExtractedArticle {
            content: article.content.to_string(),
            text_content: article.text_content.to_string(),
            excerpt: article.excerpt,
            title: article.title,
            byline: article.byline,
            probably_readable,
        })),
        // Extraction failure (no main content found) is an expected outcome,
        // not an error: the caller falls back to the unclean content.
        Err(_) => Ok(None),
    }
}

/// Extracts the main article content from HTML (synchronous; ~3ms per 200KB).
#[napi]
pub fn extract_article(
    html: String,
    options: Option<ExtractOptions>,
) -> Result<Option<ExtractedArticle>> {
    run_extract(&html, options.as_ref())
}

pub struct ExtractJob {
    html: String,
    options: Option<ExtractOptions>,
}

impl Task for ExtractJob {
    type Output = Option<ExtractedArticle>;
    type JsValue = Option<ExtractedArticle>;

    fn compute(&mut self) -> Result<Self::Output> {
        run_extract(&self.html, self.options.as_ref())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async form of `extractArticle`: runs on the libuv thread pool so large
/// pages never block the event loop.
#[napi(ts_return_type = "Promise<ExtractedArticle | null>")]
pub fn extract_article_async(
    html: String,
    options: Option<ExtractOptions>,
) -> AsyncTask<ExtractJob> {
    AsyncTask::new(ExtractJob { html, options })
}
