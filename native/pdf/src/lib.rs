//! PDF → Markdown for file uploads.
//!
//! pdf_oxide does the layout analysis (reading order, columns, paragraphs,
//! headings from font size); [`cleanup`] turns its per-page output into one
//! article, and [`images`] places the page's images in it. The Markdown is
//! rendered by the app's usual Markdown pipeline.

mod cleanup;
mod images;
mod title;

pub use images::Image;

use pdf_oxide::converters::ConversionOptions;
use pdf_oxide::object::Object;
use pdf_oxide::optional_content::decode_pdf_text_string;
use pdf_oxide::PdfDocument;

/// Longest title, author or summary kept, in characters. The output budget
/// only covers the Markdown, and a document-info string can be any size.
const MAX_METADATA_CHARS: usize = 500;

pub struct Limits {
    /// The heap cap the process runs under, which bounds the images decoded.
    pub max_memory_bytes: u64,
    pub max_pages: usize,
    pub max_output_bytes: usize,
    /// For the images, which aren't part of the Markdown.
    pub max_image_bytes: usize,
}

#[derive(Debug)]
pub struct Converted {
    /// Image `i` appears as `![](pdf-image:i)`.
    pub markdown: String,
    pub images: Vec<Image>,
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
    ImagesTooLarge,
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
            ConvertError::ImagesTooLarge => "images_too_large",
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
        // `images` extracts them instead.
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
    let mut candidates = Vec::with_capacity(page_count);
    let mut total_bytes = 0;
    for index in 0..page_count {
        // One bad page shouldn't lose the rest of the document.
        let page = doc.to_markdown(index, &options).unwrap_or_default();
        total_bytes += page.len();
        if total_bytes > limits.max_output_bytes {
            return Err(ConvertError::OutputTooLarge);
        }
        candidates.push(images::page_candidates(
            &doc,
            index,
            &page,
            limits.max_memory_bytes,
        ));
        pages.push(page);
    }
    // Checked again once cleanup has stripped page numbers, but first here,
    // before a scan's images are decoded for nothing.
    if !pages
        .iter()
        .any(|page| page.chars().any(char::is_alphanumeric))
    {
        return Err(ConvertError::NoText);
    }
    let placed = images::place(pages, candidates, limits.max_image_bytes)
        .map_err(|images::ImagesTooLarge| ConvertError::ImagesTooLarge)?;

    let markdown = without_control_chars(&cleanup::assemble(placed.pages));
    if !cleanup::split_blocks(&markdown)
        .filter(|block| !cleanup::is_image(block))
        .any(|block| block.chars().any(char::is_alphanumeric))
    {
        return Err(ConvertError::NoText);
    }

    Ok(Converted {
        markdown,
        images: placed.images,
        title: info_string(&doc, "Title")
            .filter(|title| !title::is_junk_info_title(title))
            .or_else(|| first_page_title(&doc).and_then(|title| metadata_text(&title))),
        author: info_string(&doc, "Author"),
        summary: info_string(&doc, "Subject"),
    })
}

/// Postgres rejects NUL in text, and producers do NUL-terminate strings.
fn without_control_chars(text: &str) -> String {
    text.chars()
        .filter(|&c| !c.is_control() || c == '\n' || c == '\t')
        .collect()
}

/// One line of at most [`MAX_METADATA_CHARS`], or `None` if nothing is left.
fn metadata_text(text: &str) -> Option<String> {
    let text = without_control_chars(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let text: String = text.chars().take(MAX_METADATA_CHARS).collect();
    (!text.is_empty()).then_some(text)
}

fn first_page_title(doc: &PdfDocument) -> Option<String> {
    let (_, y0, _, y1) = doc.get_page_media_box(0).ok()?;
    let spans: Vec<title::SpanBox> = doc
        .extract_spans(0)
        .ok()?
        .into_iter()
        .map(title::SpanBox::from)
        .collect();
    title::layout_title(&spans, (y0 + y1) / 2.0)
}

/// A string from the document information dictionary (ISO 32000-1 §14.3.3).
fn info_string(doc: &PdfDocument, key: &str) -> Option<String> {
    let info = resolve(doc, doc.trailer().as_dict()?.get("Info")?)?;
    let value = resolve(doc, info.as_dict()?.get(key)?)?;
    metadata_text(&decode_pdf_text_string(value.as_string()?))
}

fn resolve(doc: &PdfDocument, object: &Object) -> Option<Object> {
    match object.as_reference() {
        Some(reference) => doc.load_object(reference).ok(),
        None => Some(object.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_text_drops_control_characters_and_caps_length() {
        assert_eq!(metadata_text("A\u{0}B\n  C\u{1}").as_deref(), Some("AB C"));
        assert_eq!(metadata_text(" \u{0} "), None);
        let long = "x".repeat(MAX_METADATA_CHARS + 1);
        assert_eq!(
            metadata_text(&long).map(|t| t.chars().count()),
            Some(MAX_METADATA_CHARS)
        );
    }

    #[test]
    fn markdown_keeps_newlines_and_tabs_but_no_other_control_characters() {
        assert_eq!(without_control_chars("a\u{0}b\n\tc\u{7f}"), "ab\n\tc");
    }
}
