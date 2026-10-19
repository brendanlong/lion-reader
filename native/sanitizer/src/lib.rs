//! N-API bindings for the Lion Reader sanitizer. All logic lives in the
//! `lion-reader-sanitizer-core` crate (unit-testable without Node); this
//! crate only maps types across the boundary.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, JsFunction, Result, Status, Task, ValueType};

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

/// Calls `rewrite(tagName, name, value)` for each of `names` present on each
/// element, in document order, and writes back a returned string that
/// differs; `null`/`undefined` leaves the value alone. Values are raw (not
/// entity-decoded). Throws if `rewrite` throws or lol_html rejects the input.
#[napi(
    ts_args_type = "html: string, names: string[], rewrite: (tagName: string, name: string, value: string) => string | null | undefined"
)]
pub fn rewrite_attributes(
    env: Env,
    html: String,
    names: Vec<String>,
    rewrite: JsFunction,
) -> Result<String> {
    core::attributes::rewrite_attributes(&html, &names, |tag, name, value| {
        let args = [
            env.create_string(tag)?,
            env.create_string(name)?,
            env.create_string(value)?,
        ];
        let result = rewrite.call(None, &args)?;
        match result.get_type()? {
            ValueType::String => Ok(Some(result.coerce_to_string()?.into_utf8()?.into_owned()?)),
            ValueType::Null | ValueType::Undefined => Ok(None),
            _ => Err(Error::new(
                Status::InvalidArg,
                "rewriteAttributes callback must return a string, null or undefined".to_string(),
            )),
        }
    })
    .map_err(|e| match e {
        core::attributes::RewriteError::Callback(e) => e,
        core::attributes::RewriteError::Rewriter(message) => Error::new(
            Status::GenericFailure,
            format!("rewriteAttributes failed: {message}"),
        ),
    })
}
