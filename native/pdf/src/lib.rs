//! PDF → Markdown for file uploads.
//!
//! pdf_oxide does the layout analysis (reading order, columns, paragraphs,
//! headings from font size); [`cleanup`] turns its per-page output into one
//! article. The Markdown is rendered by the app's usual Markdown pipeline.

mod cleanup;
mod title;

use pdf_oxide::converters::ConversionOptions;
use pdf_oxide::object::Object;
use pdf_oxide::optional_content::decode_pdf_text_string;
use pdf_oxide::PdfDocument;

pub struct Limits {
    pub max_pages: usize,
    pub max_output_bytes: usize,
}

#[derive(Debug)]
pub struct Converted {
    pub markdown: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConvertError {
    /// Not a PDF, or too damaged to open.
    Unreadable,
    /// Needs a password we don't have.
    Encrypted,
    TooManyPages,
    OutputTooLarge,
    /// No extractable text: almost always a scan, which would need OCR.
    NoText,
}

impl ConvertError {
    /// The wire name the TypeScript caller matches on.
    pub fn code(&self) -> &'static str {
        match self {
            ConvertError::Unreadable => "unreadable",
            ConvertError::Encrypted => "encrypted",
            ConvertError::TooManyPages => "too_many_pages",
            ConvertError::OutputTooLarge => "output_too_large",
            ConvertError::NoText => "no_text",
        }
    }
}

fn conversion_options() -> ConversionOptions {
    ConversionOptions {
        // pdf_oxide's running header/footer pass rescans every page for each
        // page (quadratic: 100s for a 244-page book on one core, versus under
        // 1s without it); `cleanup` strips them in one pass instead.
        strip_running_headers_footers: false,
        include_images: false,
        ..Default::default()
    }
}

pub fn convert(bytes: Vec<u8>, limits: &Limits) -> Result<Converted, ConvertError> {
    let doc = PdfDocument::from_bytes(bytes).map_err(|_| ConvertError::Unreadable)?;
    // True for unencrypted documents and for ones whose user password is
    // empty (encrypted only to set permissions), which open like any other.
    if !doc.authenticate(b"").unwrap_or(false) {
        return Err(ConvertError::Encrypted);
    }
    let page_count = doc.page_count().map_err(|_| ConvertError::Unreadable)?;
    if page_count > limits.max_pages {
        return Err(ConvertError::TooManyPages);
    }

    let options = conversion_options();
    let mut pages = Vec::with_capacity(page_count);
    let mut total_bytes = 0;
    for index in 0..page_count {
        // One bad page shouldn't lose the rest of the document.
        let page = doc.to_markdown(index, &options).unwrap_or_default();
        total_bytes += page.len();
        if total_bytes > limits.max_output_bytes {
            return Err(ConvertError::OutputTooLarge);
        }
        pages.push(page);
    }

    let markdown = cleanup::assemble(pages);
    if !markdown.chars().any(char::is_alphanumeric) {
        return Err(ConvertError::NoText);
    }

    Ok(Converted {
        markdown,
        title: info_string(&doc, "Title")
            .filter(|title| !title::is_junk_info_title(title))
            .or_else(|| first_page_title(&doc)),
        author: info_string(&doc, "Author"),
        summary: info_string(&doc, "Subject"),
    })
}

fn first_page_title(doc: &PdfDocument) -> Option<String> {
    let (_, y0, _, y1) = doc.get_page_media_box(0).ok()?;
    let spans: Vec<title::SpanBox> = doc
        .extract_spans(0)
        .ok()?
        .into_iter()
        .map(|span| title::SpanBox {
            text: span.text,
            size: span.font_size,
            x: span.bbox.x,
            width: span.bbox.width,
            y: span.bbox.y,
            height: span.bbox.height,
        })
        .collect();
    title::layout_title(&spans, (y0 + y1) / 2.0)
}

/// A string from the document information dictionary (ISO 32000-1 §14.3.3).
fn info_string(doc: &PdfDocument, key: &str) -> Option<String> {
    let info = resolve(doc, doc.trailer().as_dict()?.get("Info")?)?;
    let value = resolve(doc, info.as_dict()?.get(key)?)?;
    let text = decode_pdf_text_string(value.as_string()?);
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn resolve(doc: &PdfDocument, object: &Object) -> Option<Object> {
    match object.as_reference() {
        Some(reference) => doc.load_object(reference).ok(),
        None => Some(object.clone()),
    }
}
