//! Finding a PDF's title. The document-info Title is usually missing (arXiv
//! leaves it blank) or junk ("Microsoft Word - draft3.docx"), so the fallback
//! is the largest text in the top half of the first page. pdf_oxide's own
//! headings don't do: its reading order scatters a multi-line title around the
//! author block.

use std::collections::HashMap;

/// Title text must be at least this much larger than the page's body text.
const MIN_TITLE_TO_BODY_RATIO: f32 = 1.2;
/// Spans this close to the largest size count as the same size.
const SIZE_TOLERANCE: f32 = 0.5;
/// On a title line, smaller spans down to this fraction of the title size are
/// kept: small caps set the lowercase letters smaller (`LoRA: LOW-RANK
/// ADAPTATION OF LARGE LANGUAGE MODELS` has "OF" at 80%).
const MIN_SMALL_CAPS_RATIO: f32 = 0.75;
/// Spans within this many points vertically share a line.
const LINE_TOLERANCE: f32 = 2.0;
/// A gap between spans narrower than this fraction of the font size is inside
/// a word: producers split words into several spans (`Head` + `er`).
const MAX_WORD_GAP_RATIO: f32 = 0.1;
/// More lines of large text than this is a cover page or poster, not a title.
const MAX_TITLE_LINES: usize = 4;

pub struct SpanBox {
    pub text: String,
    pub size: f32,
    pub x: f32,
    pub width: f32,
    /// Bottom edge, in PDF user space (y grows upward).
    pub y: f32,
    pub height: f32,
}

/// Document-info titles that name a file rather than the document.
pub fn is_junk_info_title(title: &str) -> bool {
    let lower = title.to_lowercase();
    lower == "untitled"
        || lower.starts_with("microsoft word - ")
        || [".doc", ".docx", ".pdf", ".tex", ".dvi", ".indd", ".qxd"]
            .iter()
            .any(|ext| lower.ends_with(ext))
}

/// The title from page-one layout. `page_middle` is the y halfway up the page.
pub fn layout_title(spans: &[SpanBox], page_middle: f32) -> Option<String> {
    let spans: Vec<&SpanBox> = spans.iter().filter(|s| !s.text.trim().is_empty()).collect();
    let body_size = most_common_size(&spans)?;
    let top_half: Vec<&SpanBox> = spans
        .iter()
        .copied()
        .filter(|s| s.y + s.height > page_middle)
        .collect();
    let title_size = top_half.iter().map(|s| s.size).fold(0.0, f32::max);
    if title_size < body_size * MIN_TITLE_TO_BODY_RATIO {
        return None;
    }

    let mut line_ys: Vec<f32> = top_half
        .iter()
        .filter(|s| (s.size - title_size).abs() < SIZE_TOLERANCE)
        .map(|s| s.y)
        .collect();
    line_ys.sort_by(|a, b| b.total_cmp(a));
    line_ys.dedup_by(|a, b| (*a - *b).abs() < LINE_TOLERANCE);
    if line_ys.len() > MAX_TITLE_LINES {
        return None;
    }

    let mut title = String::new();
    for line_y in line_ys {
        let mut line: Vec<&SpanBox> = spans
            .iter()
            .copied()
            .filter(|s| (s.y - line_y).abs() < LINE_TOLERANCE)
            .filter(|s| s.size >= title_size * MIN_SMALL_CAPS_RATIO)
            .collect();
        line.sort_by(|a, b| a.x.total_cmp(&b.x));
        let mut text = String::new();
        let mut previous_end: Option<f32> = None;
        for span in line {
            if previous_end.is_some_and(|end| span.x - end > span.size * MAX_WORD_GAP_RATIO) {
                text.push(' ');
            }
            text.push_str(span.text.trim());
            previous_end = Some(span.x + span.width);
        }
        // A word broken across title lines (`LAN-` / `GUAGE`).
        match title.strip_suffix('-') {
            Some(stem) => title = stem.to_string(),
            None if !title.is_empty() => title.push(' '),
            None => {}
        }
        title.push_str(&text);
    }
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    title.chars().any(char::is_alphanumeric).then_some(title)
}

/// The font size covering the most characters.
fn most_common_size(spans: &[&SpanBox]) -> Option<f32> {
    let mut chars_by_size: HashMap<u32, usize> = HashMap::new();
    for span in spans {
        *chars_by_size.entry(span.size.to_bits()).or_default() += span.text.chars().count();
    }
    chars_by_size
        .into_iter()
        .max_by_key(|&(_, chars)| chars)
        .map(|(bits, _)| f32::from_bits(bits))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIDDLE: f32 = 396.0;

    fn span(text: &str, size: f32, x: f32, y: f32) -> SpanBox {
        SpanBox {
            text: text.to_string(),
            size,
            x,
            // Wide enough that test spans never touch.
            width: text.len() as f32 * size * 0.4,
            y,
            height: size,
        }
    }

    fn body(y: f32) -> SpanBox {
        span(&"body text ".repeat(20), 10.0, 72.0, y)
    }

    #[test]
    fn joins_title_lines_top_to_bottom_left_to_right() {
        let spans = [
            span("Language Understanding", 14.3, 220.0, 744.0),
            span("Transformers for", 14.3, 292.0, 760.0),
            span("BERT: Pre-training of Deep", 14.3, 116.0, 760.0),
            span("Jacob Devlin", 12.0, 120.0, 700.0),
            body(500.0),
        ];
        assert_eq!(
            layout_title(&spans, MIDDLE).as_deref(),
            Some("BERT: Pre-training of Deep Transformers for Language Understanding")
        );
    }

    #[test]
    fn joins_a_word_split_across_spans() {
        let mut head = span("Head", 20.0, 72.0, 700.0);
        head.width = 40.0;
        let spans = [head, span("er", 20.0, 112.0, 700.0), body(500.0)];
        assert_eq!(layout_title(&spans, MIDDLE).as_deref(), Some("Header"));
    }

    #[test]
    fn ignores_larger_text_in_the_bottom_half() {
        // arXiv's margin stamp is bigger than the title but low on the page.
        let spans = [
            span("arXiv:1512.03385v1 [cs.CV]", 20.0, 32.0, 232.0),
            span("Deep Residual Learning", 14.3, 153.0, 675.0),
            body(500.0),
        ];
        assert_eq!(
            layout_title(&spans, MIDDLE).as_deref(),
            Some("Deep Residual Learning")
        );
    }

    #[test]
    fn keeps_small_caps_and_rejoins_broken_words() {
        let spans = [
            span("LORA: LOW-RANK ADAPTATION", 17.2, 108.0, 698.0),
            span("OF", 13.8, 373.0, 698.0),
            span("LARGE LAN-", 17.2, 402.0, 698.0),
            span("GUAGE", 13.8, 108.0, 678.0),
            span("MODELS", 17.2, 164.0, 678.0),
            body(500.0),
        ];
        assert_eq!(
            layout_title(&spans, MIDDLE).as_deref(),
            Some("LORA: LOW-RANK ADAPTATION OF LARGE LANGUAGE MODELS")
        );
    }

    #[test]
    fn no_title_without_text_clearly_larger_than_body() {
        let spans = [span("Slightly bigger", 11.0, 72.0, 700.0), body(500.0)];
        assert_eq!(layout_title(&spans, MIDDLE), None);
    }

    #[test]
    fn no_title_from_a_page_of_large_text() {
        let mut spans: Vec<SpanBox> = (0..=MAX_TITLE_LINES)
            .map(|i| span("Poster line", 30.0, 72.0, 750.0 - 40.0 * i as f32))
            .collect();
        spans.push(body(300.0));
        assert_eq!(layout_title(&spans, MIDDLE), None);
    }

    #[test]
    fn junk_info_titles() {
        assert!(is_junk_info_title("Microsoft Word - draft3.docx"));
        assert!(is_junk_info_title("paper.pdf"));
        assert!(is_junk_info_title("Untitled"));
        assert!(!is_junk_info_title("2026 Form W-4"));
    }
}
