//! N-API bindings for the Lion Reader sanitizer. All logic lives in the
//! `lion-reader-sanitizer-core` crate (unit-testable without Node); this
//! crate only maps types across the boundary.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};

use lion_reader_sanitizer_core as core;

/// Version of the sanitization rules compiled into this module — the single
/// source of truth for `SANITIZER_VERSION`.
#[napi]
pub const SANITIZER_VERSION: u32 = core::SANITIZER_VERSION;

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
        Ok(sanitized) => Ok(SanitizeOutput { html: sanitized, warnings }),
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
