//! N-API bindings for the Lion Reader sanitizer. All logic lives in the
//! `lion-reader-sanitizer-core` crate (unit-testable without Node); this
//! crate only maps types across the boundary.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Status, Task};

use lion_reader_sanitizer_core as core;

#[napi(object)]
pub struct SanitizeOutput {
    pub html: String,
    /// Non-fatal diagnostics (e.g. unrecognized MathJax wrappers) for the
    /// caller to log.
    pub warnings: Vec<String>,
}

fn run_pipeline(html: &str) -> Result<SanitizeOutput> {
    let mut warnings = Vec::new();
    match core::sanitize_entry_html(html, &mut warnings) {
        Ok(sanitized) => Ok(SanitizeOutput {
            html: sanitized,
            warnings,
        }),
        Err(message) => Err(Error::new(
            Status::GenericFailure,
            format!("sanitizer failed: {message}"),
        )),
    }
}

/// Sanitizes untrusted entry HTML for safe rendering in the browser
/// (synchronous; ~1ms per 100KB).
#[napi]
pub fn sanitize_entry_html(html: String) -> Result<SanitizeOutput> {
    run_pipeline(&html)
}

pub struct SanitizeJob {
    html: String,
}

impl Task for SanitizeJob {
    type Output = SanitizeOutput;
    type JsValue = SanitizeOutput;

    fn compute(&mut self) -> Result<Self::Output> {
        run_pipeline(&self.html)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async form of `sanitizeEntryHtml`: runs on the libuv thread pool so large
/// bodies never block the event loop.
#[napi(ts_return_type = "Promise<SanitizeOutput>")]
pub fn sanitize_entry_html_async(html: String) -> AsyncTask<SanitizeJob> {
    AsyncTask::new(SanitizeJob { html })
}

#[napi(object)]
pub struct NormalizedEmbed {
    pub src: String,
    pub provider: String,
    pub sandbox: String,
    pub allow: String,
}

/// The canonical hostnames every surviving embed src is rewritten to. The
/// CSP (`src/server/http/csp.ts`) uses this to double-enforce the embed
/// host allow-list in `frame-src`, so it must stay the same list the
/// sanitizer rewrites to — exporting it here keeps one source of truth.
#[napi]
pub fn embed_canonical_hostnames() -> Vec<String> {
    core::embeds::EMBED_CANONICAL_HOSTNAMES
        .iter()
        .map(|host| host.to_string())
        .collect()
}

/// Validates an untrusted iframe src against the allow-listed embed
/// providers and returns the normalized embed, or null if the iframe should
/// be dropped. Exposed for tests and TS callers that synthesize embeds.
#[napi]
pub fn normalize_embed(src: String) -> Option<NormalizedEmbed> {
    core::embeds::normalize_embed(&src).map(|embed| NormalizedEmbed {
        src: embed.src,
        provider: embed.provider.to_string(),
        sandbox: embed.sandbox.to_string(),
        allow: embed.allow.to_string(),
    })
}

#[napi(object)]
pub struct MediaBases {
    pub base_url: String,
    pub root_base_url: Option<String>,
}

#[napi(object)]
pub struct AbsolutizeOptions {
    pub root_base_url: Option<String>,
    pub media: Option<MediaBases>,
    pub image_url_prefix: Option<String>,
}

#[napi(object)]
pub struct ExtractedImage {
    pub name: String,
    pub content_type: String,
    pub data: Buffer,
}

#[napi(object)]
pub struct AbsolutizeOutput {
    pub html: String,
    pub images: Vec<ExtractedImage>,
}

fn run_absolutize(
    html: &str,
    base_url: Option<String>,
    options: Option<AbsolutizeOptions>,
) -> Result<core::absolutize::Rewritten> {
    let options = options.unwrap_or(AbsolutizeOptions {
        root_base_url: None,
        media: None,
        image_url_prefix: None,
    });
    let document = base_url.map(|url| core::absolutize::Bases {
        url,
        root: options.root_base_url,
    });
    let media = options.media.map(|media| core::absolutize::Bases {
        url: media.base_url,
        root: media.root_base_url,
    });
    core::absolutize::rewrite_urls(
        html,
        document.as_ref(),
        media.as_ref(),
        options.image_url_prefix.as_deref(),
    )
    .map_err(|message| {
        Error::new(
            Status::GenericFailure,
            format!("absolutizeUrls failed: {message}"),
        )
    })
}

fn to_output(rewritten: core::absolutize::Rewritten) -> AbsolutizeOutput {
    AbsolutizeOutput {
        html: rewritten.html,
        images: rewritten
            .images
            .into_iter()
            .map(|image| ExtractedImage {
                name: image.name,
                content_type: image.content_type.to_string(),
                data: image.data.into(),
            })
            .collect(),
    }
}

/// Absolutizes relative URLs in `src`/`href`/`poster`/`srcset` and moves
/// inlined images out (see `rewrite_urls` in `core/src/absolutize.rs`).
/// Throws when lol_html rejects the input.
#[napi]
pub fn absolutize_urls(
    html: String,
    base_url: Option<String>,
    options: Option<AbsolutizeOptions>,
) -> Result<AbsolutizeOutput> {
    run_absolutize(&html, base_url, options).map(to_output)
}

pub struct AbsolutizeJob {
    html: String,
    base_url: Option<String>,
    options: Option<AbsolutizeOptions>,
}

impl Task for AbsolutizeJob {
    type Output = core::absolutize::Rewritten;
    type JsValue = AbsolutizeOutput;

    fn compute(&mut self) -> Result<Self::Output> {
        run_absolutize(&self.html, self.base_url.take(), self.options.take())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(to_output(output))
    }
}

/// Async form of `absolutizeUrls`, on the libuv thread pool.
#[napi(ts_return_type = "Promise<AbsolutizeOutput>")]
pub fn absolutize_urls_async(
    html: String,
    base_url: Option<String>,
    options: Option<AbsolutizeOptions>,
) -> AsyncTask<AbsolutizeJob> {
    AsyncTask::new(AbsolutizeJob {
        html,
        base_url,
        options,
    })
}
