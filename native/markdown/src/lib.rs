//! N-API bindings for the Markdown renderer.
//!
//! The rendering itself lives in `lion-reader-markdown-core`; this crate is the
//! thin JS boundary. Two forms, matching the sanitizer and the Readability
//! extractor: a synchronous one for background jobs, and an `AsyncTask` one
//! that runs on the libuv thread pool so an app-server request path never
//! blocks the event loop on a large document (see #1431).

#[macro_use]
extern crate napi_derive;

use lion_reader_markdown_core::{render, RenderError, RenderLimits};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Result, Task};

/// Byte budgets for one render, both required so the limits stay owned by
/// `usageLimitsConfig` on the TypeScript side.
#[napi(object)]
pub struct MarkdownLimits {
    /// Maximum size of the Markdown source, in bytes.
    pub max_input_bytes: u32,
    /// Maximum size of the rendered HTML, in bytes.
    pub max_output_bytes: u32,
}

/// The outcome of a render.
///
/// A rejected budget is reported as a value rather than a thrown error: the
/// caller turns it into the same user-facing "content too large" error every
/// other size limit produces, and a string reason keeps that mapping explicit
/// instead of matching on an exception message.
#[napi(object)]
pub struct RenderedMarkdown {
    /// The rendered HTML, or `null` when a budget was exceeded.
    pub html: Option<String>,
    /// Which budget was exceeded — `"input"` or `"output"` — or `null` on success.
    pub limit_exceeded: Option<String>,
}

fn run(markdown: &str, limits: &MarkdownLimits) -> RenderedMarkdown {
    let limits = RenderLimits {
        max_input_bytes: limits.max_input_bytes as usize,
        max_output_bytes: limits.max_output_bytes as usize,
    };

    // A panic unwinding across the N-API boundary aborts the whole Node
    // process, so it stops here. Rendering has no partial result worth
    // salvaging, so an unexpected panic is reported as the over-budget case —
    // the caller already handles it, and it can't be mistaken for success.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render(markdown, limits)));

    match result {
        Ok(Ok(html)) => RenderedMarkdown {
            html: Some(html),
            limit_exceeded: None,
        },
        Ok(Err(RenderError::InputTooLarge)) => RenderedMarkdown {
            html: None,
            limit_exceeded: Some("input".to_string()),
        },
        Ok(Err(RenderError::OutputTooLarge)) | Err(_) => RenderedMarkdown {
            html: None,
            limit_exceeded: Some("output".to_string()),
        },
    }
}

/// Renders Markdown to HTML (synchronous).
#[napi]
pub fn render_markdown(markdown: String, limits: MarkdownLimits) -> Result<RenderedMarkdown> {
    Ok(run(&markdown, &limits))
}

pub struct RenderJob {
    markdown: String,
    limits: MarkdownLimits,
}

impl Task for RenderJob {
    type Output = RenderedMarkdown;
    type JsValue = RenderedMarkdown;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(run(&self.markdown, &self.limits))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async form of `renderMarkdown`: runs on the libuv thread pool so large
/// documents never block the event loop.
#[napi(ts_return_type = "Promise<RenderedMarkdown>")]
pub fn render_markdown_async(markdown: String, limits: MarkdownLimits) -> AsyncTask<RenderJob> {
    AsyncTask::new(RenderJob { markdown, limits })
}
