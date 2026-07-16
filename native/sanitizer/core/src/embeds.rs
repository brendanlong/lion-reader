//! Allow-listed iframe embed providers — direct port of
//! `src/server/html/embed-providers.ts` + `youtube-embed.ts` (issue #922).
//!
//! Iframes are the sanitizer's only cross-origin escape hatch, so the policy
//! is block-by-default, opt-in per provider: parse the src as http(s)
//! (protocol-relative treated as https), match a provider's known embed
//! hosts, validate the path against a strict bounded regex, and rebuild the
//! URL from scratch on the provider's canonical host copying only an
//! allow-list of query params. The sanitizer then forces a per-provider
//! `sandbox`/`allow` regardless of what the feed supplied.

use regex::Regex;
use std::sync::LazyLock;
use url::Url;

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedEmbed {
    pub src: String,
    pub provider: &'static str,
    pub sandbox: &'static str,
    pub allow: &'static str,
}

/// Sandbox shared by the media-player embeds (see embed-providers.ts for the
/// rationale; `allow-same-origin` is safe because the framed content is
/// always cross-origin — a canonical provider host, never our own origin).
pub const STANDARD_EMBED_SANDBOX: &str =
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";

pub const YOUTUBE_IFRAME_ALLOW: &str = "fullscreen; encrypted-media; picture-in-picture";

/// The canonical hostnames every surviving embed src is rewritten to.
/// Mirrored by a unit test against the normalizers' outputs.
pub const EMBED_CANONICAL_HOSTNAMES: &[&str] = &[
    "www.youtube-nocookie.com",
    "player.vimeo.com",
    "open.spotify.com",
    "w.soundcloud.com",
    "bandcamp.com",
    "codepen.io",
];

/// Parses an untrusted iframe src into an http(s) URL, treating
/// protocol-relative `//host/...` as https. None for anything unparseable or
/// non-http(s).
fn parse_http_url(src: &str) -> Option<Url> {
    let trimmed = src.trim();
    if trimmed.is_empty() {
        return None;
    }
    let absolute = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else {
        trimmed.to_string()
    };
    let url = Url::parse(&absolute).ok()?;
    match url.scheme() {
        "http" | "https" => Some(url),
        _ => None,
    }
}

/// Copies only allow-listed query params from `from` onto `to`, with
/// URLSearchParams.set semantics (last value wins, first occurrence's
/// position kept).
fn copy_params(from: &Url, to: &mut Url, allowed: &[&str]) {
    let mut ordered: Vec<(String, String)> = Vec::new();
    for (key, value) in from.query_pairs() {
        if !allowed.contains(&key.as_ref()) {
            continue;
        }
        match ordered.iter_mut().find(|(k, _)| *k == key.as_ref()) {
            Some(entry) => entry.1 = value.into_owned(),
            None => ordered.push((key.into_owned(), value.into_owned())),
        }
    }
    if !ordered.is_empty() {
        to.query_pairs_mut().extend_pairs(ordered);
    }
}

// --- YouTube ----------------------------------------------------------------

const YOUTUBE_EMBED_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
];

static YOUTUBE_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/embed/([A-Za-z0-9_-]{1,64})$").unwrap());

const YOUTUBE_PARAMS: &[&str] = &[
    "start", "end", "list", "listType", "loop", "playlist", "rel", "cc_load_policy",
    "cc_lang_pref", "hl",
];

pub fn normalize_youtube_embed_url(src: &str) -> Option<String> {
    let url = parse_http_url(src)?;
    if !YOUTUBE_EMBED_HOSTS.contains(&url.host_str()?) {
        return None;
    }
    let captures = YOUTUBE_PATH_RE.captures(url.path())?;
    let mut out = Url::parse(&format!(
        "https://www.youtube-nocookie.com/embed/{}",
        &captures[1]
    ))
    .unwrap();
    copy_params(&url, &mut out, YOUTUBE_PARAMS);
    Some(out.to_string())
}

// --- Vimeo ------------------------------------------------------------------

static VIMEO_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/video/(\d{1,20})$").unwrap());

const VIMEO_PARAMS: &[&str] = &[
    "h", "title", "byline", "portrait", "badge", "color", "loop", "muted", "dnt",
];

fn normalize_vimeo_embed_url(src: &str) -> Option<String> {
    let url = parse_http_url(src)?;
    if url.host_str()? != "player.vimeo.com" {
        return None;
    }
    let captures = VIMEO_PATH_RE.captures(url.path())?;
    let mut out = Url::parse(&format!("https://player.vimeo.com/video/{}", &captures[1])).unwrap();
    copy_params(&url, &mut out, VIMEO_PARAMS);
    Some(out.to_string())
}

// --- Spotify ----------------------------------------------------------------

static SPOTIFY_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/embed(?:-podcast)?/(track|album|playlist|episode|show|artist)/([A-Za-z0-9]{1,64})$")
        .unwrap()
});

const SPOTIFY_PARAMS: &[&str] = &["theme", "t"];

fn normalize_spotify_embed_url(src: &str) -> Option<String> {
    let url = parse_http_url(src)?;
    if url.host_str()? != "open.spotify.com" {
        return None;
    }
    if !SPOTIFY_PATH_RE.is_match(url.path()) {
        return None;
    }
    let mut out = Url::parse(&format!("https://open.spotify.com{}", url.path())).unwrap();
    copy_params(&url, &mut out, SPOTIFY_PARAMS);
    Some(out.to_string())
}

// --- SoundCloud ---------------------------------------------------------------

static SOUNDCLOUD_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/player/?$").unwrap());

const SOUNDCLOUD_PARAMS: &[&str] = &[
    "color", "hide_related", "show_comments", "show_user", "show_reposts", "show_teaser",
    "visual", "start_track", "single_active",
];

fn is_soundcloud_resource_url(value: &str) -> bool {
    let Some(url) = parse_http_url(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host == "soundcloud.com" || host == "api.soundcloud.com" || host.ends_with(".soundcloud.com")
}

fn normalize_soundcloud_embed_url(src: &str) -> Option<String> {
    let url = parse_http_url(src)?;
    if url.host_str()? != "w.soundcloud.com" {
        return None;
    }
    if !SOUNDCLOUD_PATH_RE.is_match(url.path()) {
        return None;
    }
    // The `url` param carries the actual track/playlist — required, and it
    // must point at SoundCloud.
    let resource = url
        .query_pairs()
        .find(|(k, _)| k == "url")
        .map(|(_, v)| v.into_owned())?;
    if !is_soundcloud_resource_url(&resource) {
        return None;
    }
    let mut out = Url::parse("https://w.soundcloud.com/player/").unwrap();
    out.query_pairs_mut().append_pair("url", &resource);
    copy_params(&url, &mut out, SOUNDCLOUD_PARAMS);
    Some(out.to_string())
}

// --- Bandcamp -----------------------------------------------------------------

static BANDCAMP_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/EmbeddedPlayer(?:/[a-z_]+=[A-Za-z0-9]+)+/?$").unwrap());

fn normalize_bandcamp_embed_url(src: &str) -> Option<String> {
    let url = parse_http_url(src)?;
    if url.host_str()? != "bandcamp.com" {
        return None;
    }
    if !BANDCAMP_PATH_RE.is_match(url.path()) {
        return None;
    }
    Some(format!("https://bandcamp.com{}", url.path()))
}

// --- CodePen ------------------------------------------------------------------

static CODEPEN_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/[A-Za-z0-9_-]+/embed/(?:preview/)?[A-Za-z0-9]+/?$").unwrap());

const CODEPEN_PARAMS: &[&str] = &["default-tab", "theme-id", "height", "editable"];

fn normalize_codepen_embed_url(src: &str) -> Option<String> {
    let url = parse_http_url(src)?;
    if url.host_str()? != "codepen.io" {
        return None;
    }
    if !CODEPEN_PATH_RE.is_match(url.path()) {
        return None;
    }
    let mut out = Url::parse(&format!("https://codepen.io{}", url.path())).unwrap();
    copy_params(&url, &mut out, CODEPEN_PARAMS);
    Some(out.to_string())
}

/// Validates an untrusted iframe src against the allow-listed providers and
/// returns the normalized embed (canonical src + forced sandbox/allow), or
/// None if the iframe should be dropped.
pub fn normalize_embed(src: &str) -> Option<NormalizedEmbed> {
    type Provider = (
        &'static str,
        fn(&str) -> Option<String>,
        &'static str, // allow
    );
    const PROVIDERS: &[Provider] = &[
        ("YouTube", normalize_youtube_embed_url, YOUTUBE_IFRAME_ALLOW),
        (
            "Vimeo",
            normalize_vimeo_embed_url,
            "fullscreen; encrypted-media; picture-in-picture",
        ),
        (
            "Spotify",
            normalize_spotify_embed_url,
            "encrypted-media; clipboard-write; fullscreen; picture-in-picture",
        ),
        (
            "SoundCloud",
            normalize_soundcloud_embed_url,
            "encrypted-media; fullscreen",
        ),
        ("Bandcamp", normalize_bandcamp_embed_url, "encrypted-media"),
        ("CodePen", normalize_codepen_embed_url, ""),
    ];
    for (name, normalize, allow) in PROVIDERS {
        if let Some(normalized) = normalize(src) {
            return Some(NormalizedEmbed {
                src: normalized,
                provider: name,
                sandbox: STANDARD_EMBED_SANDBOX,
                allow,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_normalizes_to_nocookie() {
        let embed = normalize_embed("https://www.youtube.com/embed/dQw4w9WgXcQ?start=10&autoplay=1").unwrap();
        assert_eq!(embed.provider, "YouTube");
        assert_eq!(embed.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10");
    }

    #[test]
    fn protocol_relative_is_https() {
        let embed = normalize_embed("//player.vimeo.com/video/12345").unwrap();
        assert_eq!(embed.src, "https://player.vimeo.com/video/12345");
    }

    #[test]
    fn rejects_unknown_hosts_and_paths() {
        assert!(normalize_embed("https://evil.com/embed/x").is_none());
        assert!(normalize_embed("https://www.youtube.com/watch?v=abc").is_none());
        assert!(normalize_embed("javascript:alert(1)").is_none());
    }

    #[test]
    fn soundcloud_requires_soundcloud_resource() {
        assert!(normalize_embed("https://w.soundcloud.com/player/?url=https://evil.com/x").is_none());
        let ok = normalize_embed(
            "https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/123&visual=true",
        )
        .unwrap();
        assert!(ok.src.starts_with("https://w.soundcloud.com/player/?url="));
        assert!(ok.src.contains("visual=true"));
    }

    #[test]
    fn every_canonical_host_is_listed() {
        let outputs = [
            normalize_embed("https://www.youtube.com/embed/abc").unwrap().src,
            normalize_embed("https://player.vimeo.com/video/1").unwrap().src,
            normalize_embed("https://open.spotify.com/embed/track/abc123").unwrap().src,
            normalize_embed("https://w.soundcloud.com/player/?url=https://soundcloud.com/x").unwrap().src,
            normalize_embed("https://bandcamp.com/EmbeddedPlayer/album=123/size=large/").unwrap().src,
            normalize_embed("https://codepen.io/user/embed/abcDEF").unwrap().src,
        ];
        for src in outputs {
            let url = Url::parse(&src).unwrap();
            assert!(EMBED_CANONICAL_HOSTNAMES.contains(&url.host_str().unwrap()), "{src}");
        }
    }
}
