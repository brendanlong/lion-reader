//! The raster images that go into the article, and where in the text each one
//! goes. pdf_oxide's own `include_images` isn't used: it puts a page's images
//! after all of its text and silently drops any over 200KB of base64, which
//! is most photographs.
//!
//! Each image is placed before the first line of text below it in its column,
//! which for a figure is its caption. An image drawn on several pages is a
//! logo or other page furniture and is dropped, as is one covering its page (a
//! scan behind an OCR text layer, or a cover).

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hasher};

use pdf_oxide::extractors::images::PdfImageHandle;
use pdf_oxide::extractors::ImageData;
use pdf_oxide::geometry::Rect;
use pdf_oxide::PdfDocument;

use crate::cleanup::{split_blocks, MIN_RUNNING_HEADER_PAGES};
use crate::title::SpanBox;

/// pdf_oxide's own cutoff: anything smaller is a glyph, bullet or rule.
const MIN_IMAGE_SIDE_PIXELS: u32 = 32;
/// Larger images are skipped before they are decoded: decoding takes several
/// bytes a pixel, and the helper's heap is capped. pdf_oxide's own default,
/// which covers a full page at 300 DPI.
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
/// An image covering more of its page than this is the page itself.
const MAX_PAGE_COVERAGE: f32 = 0.8;
/// Spans within this many points vertically share a line.
const LINE_TOLERANCE: f32 = 2.0;
/// A line below an image with fewer letters and digits than this (a subfigure
/// label like "(a)") could match text anywhere, so the next line down is used.
const MIN_ANCHOR_CHARS: usize = 8;

/// The Markdown URL of the image at `index` in [`Placed::images`].
pub const IMAGE_URL_SCHEME: &str = "pdf-image:";

#[derive(Debug)]
pub struct Image {
    pub content_type: &'static str,
    pub data: Vec<u8>,
}

/// An image found on a page, not yet decoded.
pub struct Candidate<'doc> {
    handle: PdfImageHandle<'doc>,
    /// Identifies the image's data, to find it on other pages.
    hash: u64,
    /// The index among the page's blocks ([`split_blocks`]) the image goes
    /// before, or `None` for the end of the page.
    before_block: Option<usize>,
}

/// A page's images worth keeping, with where each goes. Call it right after
/// converting the page, while pdf_oxide still has the page's spans cached.
pub fn page_candidates<'doc>(
    doc: &'doc PdfDocument,
    page_index: usize,
    markdown: &str,
) -> Vec<Candidate<'doc>> {
    let Ok(handles) = doc.page_image_handles(page_index) else {
        return Vec::new();
    };
    let page_area = doc
        .get_page_media_box(page_index)
        .map(|(x0, y0, x1, y1)| (x1 - x0).abs() * (y1 - y0).abs())
        .unwrap_or(0.0);
    let mut seen = HashSet::new();
    let handles: Vec<(PdfImageHandle, u64)> = handles
        .into_iter()
        .filter(|h| {
            h.width >= MIN_IMAGE_SIDE_PIXELS
                && h.height >= MIN_IMAGE_SIDE_PIXELS
                && u64::from(h.width) * u64::from(h.height) <= MAX_IMAGE_PIXELS
                && h.bbox.width * h.bbox.height <= page_area * MAX_PAGE_COVERAGE
        })
        .filter_map(|h| {
            let hash = hash_bytes(&h.raw_compressed_bytes().ok()?);
            // The same image drawn twice on a page (a pattern, a mask).
            seen.insert(hash).then_some((h, hash))
        })
        .collect();
    if handles.is_empty() {
        return Vec::new();
    }

    let spans: Vec<SpanBox> = doc
        .extract_spans(page_index)
        .unwrap_or_default()
        .into_iter()
        .map(SpanBox::from)
        .collect();
    let blocks: Vec<String> = split_blocks(markdown).map(|b| squash(&b)).collect();
    handles
        .into_iter()
        .map(|(handle, hash)| Candidate {
            before_block: anchor_block(&blocks, &spans, &handle.bbox),
            handle,
            hash,
        })
        .collect()
}

/// The converted pages with their images placed, and the images in the order
/// their placeholders number them.
pub struct Placed {
    pub pages: Vec<String>,
    pub images: Vec<Image>,
}

pub struct ImagesTooLarge;

/// Decodes the images worth keeping and puts a placeholder for each into its
/// page, failing once their encoded size passes `max_bytes`.
pub fn place(
    pages: Vec<String>,
    candidates: Vec<Vec<Candidate>>,
    max_bytes: usize,
) -> Result<Placed, ImagesTooLarge> {
    let mut pages_with: HashMap<u64, usize> = HashMap::new();
    for page in &candidates {
        for candidate in page {
            *pages_with.entry(candidate.hash).or_default() += 1;
        }
    }

    let mut images = Vec::new();
    let mut total_bytes = 0;
    let mut placed_pages = Vec::with_capacity(pages.len());
    for (markdown, page_candidates) in pages.into_iter().zip(candidates) {
        let mut before: HashMap<Option<usize>, Vec<String>> = HashMap::new();
        for candidate in page_candidates {
            if pages_with[&candidate.hash] >= MIN_RUNNING_HEADER_PAGES {
                continue;
            }
            // One image pdf_oxide can't decode shouldn't lose the rest.
            let Some(image) = encode(&candidate.handle) else {
                continue;
            };
            total_bytes += image.data.len();
            if total_bytes > max_bytes {
                return Err(ImagesTooLarge);
            }
            before
                .entry(candidate.before_block)
                .or_default()
                .push(format!("![]({IMAGE_URL_SCHEME}{})", images.len()));
            images.push(image);
        }
        if before.is_empty() {
            placed_pages.push(markdown);
            continue;
        }
        let mut blocks = Vec::new();
        for (index, block) in split_blocks(&markdown).enumerate() {
            blocks.extend(before.remove(&Some(index)).unwrap_or_default());
            blocks.push(block);
        }
        blocks.extend(before.into_values().flatten());
        placed_pages.push(blocks.join("\n\n"));
    }
    Ok(Placed {
        pages: placed_pages,
        images,
    })
}

/// A JPEG as stored, since every browser shows one; anything else (or a CMYK
/// JPEG, which browsers draw with the wrong colors) as PNG.
fn encode(handle: &PdfImageHandle) -> Option<Image> {
    let image = handle.decode().ok()?;
    match image.data() {
        ImageData::Jpeg(data) if image.color_space().components() != 4 => Some(Image {
            content_type: "image/jpeg",
            data: data.clone(),
        }),
        _ => Some(Image {
            content_type: "image/png",
            data: image.to_png_bytes().ok()?,
        }),
    }
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

/// Letters and digits only, lowercased, so a line of spans matches its block
/// whatever Markdown, spacing and hyphenation pdf_oxide gave it.
fn squash(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The first block (as [`squash`]ed) holding the nearest line of text below
/// `image` that overlaps it horizontally.
fn anchor_block(blocks: &[String], spans: &[SpanBox], image: &Rect) -> Option<usize> {
    let image_right = image.x + image.width;
    let mut below: Vec<&SpanBox> = spans
        .iter()
        .filter(|s| {
            s.y + s.height <= image.y + LINE_TOLERANCE
                && s.x < image_right
                && s.x + s.width > image.x
        })
        .collect();
    // Nearest line first, each line left to right.
    below.sort_by(|a, b| b.y.total_cmp(&a.y).then(a.x.total_cmp(&b.x)));
    let mut lines = below.chunk_by(|a, b| (a.y - b.y).abs() < LINE_TOLERANCE);
    lines.find_map(|line| {
        let text: String = line.iter().map(|s| squash(&s.text)).collect();
        if text.chars().count() < MIN_ANCHOR_CHARS {
            return None;
        }
        blocks.iter().position(|block| block.contains(&text))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(text: &str, x: f32, y: f32) -> SpanBox {
        SpanBox {
            text: text.to_string(),
            size: 10.0,
            x,
            width: 50.0,
            y,
            height: 10.0,
        }
    }

    fn blocks(blocks: &[&str]) -> Vec<String> {
        blocks.iter().map(|b| squash(b)).collect()
    }

    #[test]
    fn anchors_an_image_at_the_caption_below_it_in_its_column() {
        let image = Rect::new(300.0, 500.0, 200.0, 150.0);
        let spans = [
            span("Left column text beside the figure", 50.0, 480.0),
            span("Figure 2:", 300.0, 480.0),
            span("A cat.", 360.0, 480.0),
            span("Text further down", 300.0, 300.0),
        ];
        let page = blocks(&[
            "Left column text beside the figure",
            "Text further down",
            "**Figure 2:** A cat.",
        ]);
        assert_eq!(anchor_block(&page, &spans, &image), Some(2));
    }

    #[test]
    fn skips_short_labels_to_find_the_caption() {
        let image = Rect::new(100.0, 500.0, 200.0, 150.0);
        let spans = [
            span("(a)", 150.0, 488.0),
            span("Figure 1: Two panels", 100.0, 470.0),
        ];
        let page = blocks(&["a", "Figure 1: Two panels"]);
        assert_eq!(anchor_block(&page, &spans, &image), Some(1));
    }

    #[test]
    fn an_image_with_no_text_below_has_no_anchor() {
        let image = Rect::new(100.0, 100.0, 200.0, 150.0);
        let spans = [span("Text above the image", 100.0, 400.0)];
        assert_eq!(
            anchor_block(&blocks(&["Text above the image"]), &spans, &image),
            None
        );
    }

    #[test]
    fn squash_ignores_markdown_spacing_and_hyphens() {
        assert_eq!(
            squash("**Figure 1:** A representa-tion"),
            squash("Figure 1: A representation")
        );
    }
}
