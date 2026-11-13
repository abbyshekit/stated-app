// INTEGRATION: Bounded public-source policy and conservative streaming HTML extraction.
use html5ever::tendril::StrTendril;
use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer};
use std::cell::RefCell;
use url::{Host, Url};

const TEXT_CHARS: usize = 6000;
const TITLE_CHARS: usize = 1000;
const MAX_TAGS: usize = 25_000;
const MAX_DEPTH: usize = 512;

#[derive(Debug)]
pub struct EvidencePage {
    pub body: String,
    pub content_type: String,
    pub final_url: Option<String>,
    pub unreadable: Option<String>,
    pub redirected: bool,
}

impl EvidencePage {
    pub fn read(body: String, content_type: String, final_url: Option<String>) -> Self {
        Self {
            body,
            content_type,
            final_url,
            unreadable: None,
            redirected: false,
        }
    }
    pub fn unreadable(reason: String) -> Self {
        Self {
            body: String::new(),
            content_type: String::new(),
            final_url: None,
            unreadable: Some(reason),
            redirected: false,
        }
    }
}

pub fn decode_evidence_body(bytes: &[u8]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

/// Retain only the raw-byte prefix. A full buffer completes evidence intake;
/// planner, jury and Coinbase response reads do not use this truncating policy.
pub fn append_evidence_bytes(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> bool {
    let take = limit.saturating_sub(bytes.len()).min(chunk.len());
    bytes.extend_from_slice(&chunk[..take]);
    bytes.len() >= limit
}

pub fn redirect_target(
    current: &str,
    location: Option<&str>,
    followed: usize,
) -> Result<String, String> {
    if followed >= 5 {
        return Err("redirect limit".into());
    }
    let location = location
        .filter(|s| !s.is_empty())
        .ok_or("missing Location")?;
    // Check an absolute URL before parsing can erase forbidden explicit :443 ports.
    if location
        .split(['/', '?', '#'])
        .next()
        .is_some_and(|first| first.contains(':'))
    {
        validate_evidence_url(location)?;
    } else if location.starts_with("//") {
        validate_evidence_url(&format!("https:{location}"))?;
    }
    if location
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || crate::js_whitespace(c) || c == '\\')
    {
        return Err("invalid Location".into());
    }
    let final_url = Url::parse(current)
        .map_err(|_| "invalid redirect base")?
        .join(location)
        .map_err(|_| "invalid Location")?
        .to_string();
    validate_evidence_url(&final_url)?;
    Ok(final_url)
}

#[cfg(test)]
mod regressions {
    use super::*;

    #[test]
    fn r7_header_foreign_self_closing_children_preserve_article() {
        for (root, child) in [
            ("svg", "<path aria-hidden='true' d='M0 0'/>"),
            ("svg", "<rect style='display:none' width='8'/>"),
            ("svg", "<title/>"),
            ("math", "<mspace hidden/>"),
            ("math", "<mi aria-hidden='true'/>"),
        ] {
            let body = format!(
                "<body><header><{root}>{child}</{root}></header><article><p>The official decision remains visible.</p></article></body>"
            );
            assert_eq!(
                extract_evidence(
                    &EvidencePage::read(body, "text/html".into(), None),
                    2_000_000
                ),
                Ok((
                    String::new(),
                    "The official decision remains visible.".into()
                )),
                "{root}: {child}"
            );
        }
    }

    #[test]
    fn r7_discarded_end_tags_close_unclosed_descendants() {
        for subtree in [
            "<nav><aside>secret</nav>",
            "<nav><span hidden>secret</nav>",
            "<nav><svg><g hidden>secret</nav>",
            "<header><nav><a>secret</a></header>",
            "<div hidden><aside>secret</div>",
            "<div hidden><span aria-hidden=true>secret</div>",
        ] {
            let body = format!(
                "<body>{subtree}<main><p>The official decision remains visible.</p></main></body>"
            );
            assert_eq!(
                extract_evidence(
                    &EvidencePage::read(body, "text/html".into(), None),
                    2_000_000
                ),
                Ok((
                    String::new(),
                    "The official decision remains visible.".into()
                )),
                "{subtree}"
            );
        }
    }

    #[test]
    fn r7_inline_svg_chart_with_2000_self_closing_paths_stays_readable() {
        for child in ["<path d='M0 0'/>", "<path aria-hidden='true' d='M0 0'/>"] {
            let body = format!(
                "<main><svg>{}</svg><p>The official decision remains visible.</p></main>",
                child.repeat(2000)
            );
            assert_eq!(
                extract_evidence(
                    &EvidencePage::read(body, "text/html".into(), None),
                    2_000_000
                ),
                Ok((
                    String::new(),
                    "The official decision remains visible.".into()
                )),
                "{child}"
            );
        }
    }

    #[test]
    fn r7_discarded_content_stays_excluded_after_implied_descendant_closes() {
        for wrapper in [
            "nav",
            "script",
            "style",
            "template",
            "div hidden",
            "div aria-hidden=true",
            "div style='display:none'",
            "div style='visibility:hidden'",
        ] {
            let tag = wrapper.split_whitespace().next().unwrap();
            let body = format!(
                "<main><p>Visible before.</p><{wrapper}><aside>secret</main>still secret</{tag}><p>Visible after.</p></main>"
            );
            assert_eq!(
                extract_evidence(
                    &EvidencePage::read(body, "text/html".into(), None),
                    2_000_000
                ),
                Ok((String::new(), "Visible before. Visible after.".into())),
                "{wrapper}"
            );
        }
    }

    #[test]
    fn evidence_raw_prefix_stops_at_cap_and_decodes_split_utf8() {
        for size in [1_999_999, 2_000_000, 2_000_001] {
            let mut bytes = Vec::new();
            for chunk in vec![b'x'; size].chunks(4096) {
                if append_evidence_bytes(&mut bytes, chunk, 2_000_000) {
                    break;
                }
            }
            assert_eq!(bytes.len(), size.min(2_000_000));
            assert!(append_evidence_bytes(
                &mut bytes,
                b"ignored suffix",
                2_000_000
            ));
            assert_eq!(bytes.len(), 2_000_000);
        }
        let mut bytes = Vec::new();
        assert!(append_evidence_bytes(&mut bytes, "A😀suffix".as_bytes(), 3));
        assert_eq!(decode_evidence_body(&bytes).unwrap(), "A\u{fffd}");
    }

    #[test]
    fn html_retained_text_is_bounded_per_scope() {
        let source = format!(
            "<body><main><article><div role=main>{}</div></article></main></body>",
            "x ".repeat(999_900)
        );
        let input = BufferQueue::default();
        input.push_back(StrTendril::from_slice(&source));
        let parser = Tokenizer::new(Sink(RefCell::new(Extractor::default())), Default::default());
        let _ = parser.feed(&input);
        parser.end();
        let out = parser.sink.0.into_inner();
        assert!(!out.failed);
        assert_eq!(out.text.units, TEXT_CHARS);
        assert!(out.scoped.iter().all(|text| text.units == TEXT_CHARS));
        assert!(out.text.value.len() <= TEXT_CHARS * 3);
        assert!(out
            .scoped
            .iter()
            .all(|text| text.value.len() <= TEXT_CHARS * 3));
    }

    #[test]
    fn implied_closes_do_not_escape_hidden_or_unclosed_nav_subtrees() {
        for wrapper in [
            "nav",
            "script",
            "style",
            "noscript",
            "template",
            "div hidden",
            "div aria-hidden=true",
        ] {
            let tag = wrapper.split_whitespace().next().unwrap();
            let body = format!(
                "<body><p>Visible record</p><{wrapper}>{}</{tag}></body>",
                "<p>secret".repeat(600)
            );
            assert_eq!(
                extract_evidence(
                    &EvidencePage::read(body, "text/html".into(), None),
                    2_000_000
                )
                .unwrap()
                .1,
                "Visible record"
            );
        }
        let page = EvidencePage::read(
            "<body>Visible record<nav><p>secret".into(),
            "text/html".into(),
            None,
        );
        assert_eq!(
            extract_evidence(&page, 2_000_000).unwrap().1,
            "Visible record"
        );
        let page = EvidencePage::read(
            format!("{}<div hidden>secret", "<div>".repeat(MAX_DEPTH)),
            "text/html".into(),
            None,
        );
        assert!(extract_evidence(&page, 2_000_000).is_err());
    }
    #[test]
    fn evidence_decodes_stray_9d_lossily() {
        assert_eq!(
            decode_evidence_body(b"Official \x9d record").unwrap(),
            "Official \u{fffd} record"
        );
    }
    #[test]
    fn redirects_resolve_chain_and_reject_unsafe_missing_and_sixth_hops() {
        let mut current = "https://news.com/start".to_owned();
        for followed in 0..5 {
            current =
                redirect_target(&current, Some(&format!("/step{followed}")), followed).unwrap();
        }
        assert_eq!(current, "https://news.com/step4");
        assert_eq!(
            redirect_target(&current, Some("/sixth"), 5).unwrap_err(),
            "redirect limit"
        );
        assert_eq!(
            redirect_target(&current, None, 0).unwrap_err(),
            "missing Location"
        );
        for target in [
            "https://x.com/post",
            "https://a.twitter.com/post",
            "http://news.com/path",
            "https://localhost/path",
            "https://news.com:443/path",
        ] {
            assert!(
                redirect_target(&current, Some(target), 0).is_err(),
                "{target}"
            );
        }
        assert_eq!(
            redirect_target(&current, Some("//WWW.NASA.GOV/a"), 0).unwrap(),
            "https://www.nasa.gov/a"
        );
    }
}

/// Monotonic nanoseconds; covers body consumption as well as connection/header waits.
pub struct EvidenceBudget {
    total_deadline: u64,
}
impl EvidenceBudget {
    pub fn new(now: u64) -> Self {
        Self {
            total_deadline: now.saturating_add(20_000_000_000),
        }
    }
    pub fn deadline(&self, started: u64) -> u64 {
        self.total_deadline
            .min(started.saturating_add(10_000_000_000))
    }
    pub fn check(&self, now: u64, started: u64) -> Result<(), String> {
        if now >= self.deadline(started) {
            Err("Evidence fetch deadline exceeded".into())
        } else {
            Ok(())
        }
    }
}

/// A deliberately narrower spelling policy than WHATWG URL normalization: no ports,
/// encoded hosts, credentials, fragments or IP literals. IDNA hosts and ordinary
/// trailing-dot DNS names are supported; blocked hosts are checked without final dots.
/// DNS resolution remains the host's responsibility; this guest cannot pin resolved IPs.
pub fn validate_evidence_url(raw: &str) -> Result<(), String> {
    let invalid =
        || "Evidence requires a public HTTPS URL outside X, at most 600 UTF-16 units".to_owned();
    if raw.encode_utf16().count() > 600
        || raw
            .chars()
            .any(|c| c.is_whitespace() || crate::js_whitespace(c) || c.is_control() || c == '\\')
    {
        return Err(invalid());
    }
    if raw
        .get(..8)
        .is_none_or(|s| !s.eq_ignore_ascii_case("https://"))
    {
        return Err(invalid());
    }
    let authority = raw[8..].split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['@', ':', '%']) {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return Err(invalid());
    }
    let Some(Host::Domain(host)) = url.host() else {
        return Err(invalid());
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<_> = host.split('.').collect();
    let suffix = labels.last().copied().unwrap_or_default();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
        || suffix.len() < 2
        || [
            "localhost",
            "local",
            "internal",
            "intranet",
            "lan",
            "home",
            "onion",
            "test",
            "invalid",
            "arpa",
        ]
        .contains(&suffix)
        || ["x.com", "twitter.com"]
            .iter()
            .any(|blocked| host == *blocked || host.ends_with(&format!(".{blocked}")))
    {
        return Err(invalid());
    }
    if !url.as_str().is_ascii() || url.as_str().len() > 600 {
        return Err(invalid());
    }
    Ok(())
}

/// Shared with the WASI adapter so status/header policy can be tested without a host.
pub fn validate_evidence_response(status: u16, content_types: &[String]) -> Result<String, String> {
    if !(200..300).contains(&status) {
        return Err(format!("status {status}"));
    }
    if content_types.len() != 1 {
        return Err("Evidence requires one content type".into());
    }
    let kind = content_types[0]
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        kind.as_str(),
        "text/html" | "text/plain" | "application/json" | "application/xhtml+xml"
    ) {
        return Err("unsupported content type".into());
    }
    Ok(kind)
}

fn collapse(text: &str, limit: usize) -> String {
    let mut out = Text::default();
    out.append(text, limit);
    out.value
}

/// Collapse incrementally, retaining at most `limit` UTF-16 units, even when
/// the tokenizer emits one character token containing the entire document.
#[derive(Default)]
struct Text {
    value: String,
    units: usize,
    space: bool,
    full: bool,
}
impl Text {
    fn append(&mut self, text: &str, limit: usize) {
        if self.full {
            return;
        }
        for c in text.chars() {
            if crate::js_whitespace(c) {
                self.space = !self.value.is_empty();
                continue;
            }
            if self.space {
                if self.units == limit {
                    self.full = true;
                    return;
                }
                self.value.push(' ');
                self.units += 1;
                self.space = false;
            }
            if self.units + c.len_utf16() > limit {
                self.full = true;
                return;
            }
            self.value.push(c);
            self.units += c.len_utf16();
        }
    }
}

fn drop_tag(tag: &str) -> bool {
    matches!(
        tag,
        "script"
            | "style"
            | "noscript"
            | "template"
            | "svg"
            | "math"
            | "iframe"
            | "object"
            | "head"
            | "title"
            | "textarea"
            | "select"
            | "button"
            | "nav"
            | "header"
            | "footer"
            | "aside"
    )
}
fn void_tag(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}
fn break_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "li"
            | "dt"
            | "dd"
            | "blockquote"
            | "pre"
            | "figcaption"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "br"
            | "hr"
            | "div"
            | "section"
            | "main"
            | "article"
            | "ul"
            | "ol"
            | "dl"
            | "table"
            | "tr"
            | "td"
            | "th"
    )
}
fn hidden_style(style: &str) -> bool {
    let mut clean = String::new();
    let mut rest = style;
    while let Some((before, after)) = rest.split_once("/*") {
        clean.push_str(before);
        let Some((_, tail)) = after.split_once("*/") else {
            return true;
        };
        rest = tail;
    }
    clean.push_str(rest);
    clean.split(';').any(|part| {
        part.split_once(':').is_some_and(|(name, value)| {
            let name = name.trim().to_ascii_lowercase();
            let value: String = value
                .chars()
                .filter(|c| !c.is_whitespace())
                .flat_map(char::to_lowercase)
                .collect();
            (name == "display" && matches!(value.as_str(), "none" | "none!important"))
                || (name == "visibility"
                    && matches!(
                        value.as_str(),
                        "hidden" | "hidden!important" | "collapse" | "collapse!important"
                    ))
        })
    })
}

struct Frame {
    tag: String,
    discard: bool,
    metadata_discard: bool,
    title: bool,
    protected: bool,
    scopes: u8,
}
#[derive(Default)]
struct Extractor {
    stack: Vec<Frame>,
    text: Text,
    scoped: [Text; 4],
    title: String,
    og_title: String,
    tags: usize,
    failed: bool,
}
impl Extractor {
    fn append(&mut self, text: &str, scopes: u8) {
        self.text.append(text, TEXT_CHARS);
        for (rank, out) in self.scoped.iter_mut().enumerate() {
            if scopes & (1 << rank) != 0 {
                out.append(text, TEXT_CHARS);
            }
        }
    }
    fn close_implicit(&mut self, tags: &[&str], barriers: &[&str]) {
        if let Some(index) = self
            .stack
            .iter()
            .rposition(|f| tags.contains(&f.tag.as_str()))
        {
            // Keep list/table nesting and protected subtrees intact. In particular,
            // an implied close must never pop the hidden element itself.
            if !self.stack[index..].iter().any(|f| f.protected)
                && !self.stack[index + 1..]
                    .iter()
                    .any(|f| barriers.contains(&f.tag.as_str()))
            {
                self.stack.truncate(index);
            }
        }
    }
    fn implied_start(&mut self, name: &str) {
        if break_tag(name) && name != "br"
            || matches!(
                name,
                "address" | "aside" | "footer" | "form" | "header" | "nav"
            )
        {
            self.close_implicit(&["p"], &["body", "main", "article", "td", "th", "table"]);
        }
        match name {
            "li" => self.close_implicit(&["li"], &["ul", "ol"]),
            "dt" | "dd" => self.close_implicit(&["dt", "dd"], &["dl"]),
            "tr" => self.close_implicit(&["tr"], &["table", "thead", "tbody", "tfoot"]),
            "td" | "th" => self.close_implicit(&["td", "th"], &["tr", "table"]),
            "option" => self.close_implicit(&["option"], &["select", "datalist"]),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.close_implicit(&["h1", "h2", "h3", "h4", "h5", "h6"], &[])
            }
            _ => {}
        }
    }
}
struct Sink(RefCell<Extractor>);
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let mut out = self.0.borrow_mut();
        if out.failed {
            return TokenSinkResult::Continue;
        }
        match token {
            Token::CharacterTokens(text) => {
                if out.stack.last().is_some_and(|f| f.title) {
                    if out.title.len() + text.len() > 8192 {
                        out.failed = true;
                    } else {
                        out.title.push_str(&text);
                    }
                } else if !out.stack.last().is_some_and(|f| f.discard) {
                    let scopes = out.stack.last().map_or(0, |f| f.scopes);
                    out.append(&text, scopes);
                }
            }
            Token::TagToken(tag) => {
                out.tags += 1;
                if out.tags > MAX_TAGS {
                    out.failed = true;
                    return TokenSinkResult::Continue;
                }
                let name = tag.name.as_ref();
                if tag.kind == TagKind::EndTag {
                    if break_tag(name) && !out.stack.last().is_some_and(|f| f.discard) {
                        let scopes = out.stack.last().map_or(0, |f| f.scopes);
                        out.append(" ", scopes);
                    }
                    if let Some(index) = out.stack.iter().rposition(|f| f.tag == name) {
                        // A discarded root closes its unclosed descendants, but a
                        // visible ancestor cannot jump out of a protected subtree.
                        if !out.stack[index + 1..].iter().any(|f| f.protected) {
                            out.stack.truncate(index);
                        }
                    }
                    return TokenSinkResult::Continue;
                }
                out.implied_start(name);
                // HTML frequently omits </head>; body is its one safe implicit closure.
                if name == "body"
                    && out
                        .stack
                        .iter()
                        .all(|f| matches!(f.tag.as_str(), "html" | "head"))
                {
                    if let Some(index) = out.stack.iter().position(|f| f.tag == "head") {
                        out.stack.truncate(index);
                    }
                }
                let hidden = tag.attrs.iter().any(|a| match a.name.local.as_ref() {
                    "hidden" => true,
                    "aria-hidden" => a.value.trim().eq_ignore_ascii_case("true"),
                    "style" => hidden_style(&a.value),
                    _ => false,
                });
                let parent_discard = out.stack.last().is_some_and(|f| f.discard);
                let mut scopes = out.stack.last().map_or(0, |f| f.scopes);
                if !parent_discard && !hidden && !drop_tag(name) {
                    let rank = match name {
                        "main" => Some(0),
                        "article" => Some(1),
                        _ if tag.attrs.iter().any(|a| {
                            a.name.local.as_ref() == "role"
                                && a.value.trim().eq_ignore_ascii_case("main")
                        }) =>
                        {
                            Some(2)
                        }
                        "body" => Some(3),
                        _ => None,
                    };
                    if let Some(rank) = rank {
                        scopes |= 1 << rank;
                    }
                }
                let metadata_discard = hidden
                    || out.stack.last().is_some_and(|f| f.metadata_discard)
                    || (drop_tag(name) && !matches!(name, "head" | "title"));
                if name == "meta" && !metadata_discard && out.og_title.is_empty() {
                    let is_title = tag.attrs.iter().any(|a| {
                        matches!(a.name.local.as_ref(), "name" | "property")
                            && a.value.eq_ignore_ascii_case("og:title")
                    });
                    if is_title {
                        if let Some(value) = tag
                            .attrs
                            .iter()
                            .find(|a| a.name.local.as_ref() == "content")
                        {
                            out.og_title = collapse(&value.value, TITLE_CHARS);
                        }
                    }
                }
                if break_tag(name) && !parent_discard && !hidden {
                    out.append(" ", scopes);
                }
                let self_closing_foreign = tag.self_closing
                    && (matches!(name, "svg" | "math")
                        || out
                            .stack
                            .iter()
                            .any(|f| matches!(f.tag.as_str(), "svg" | "math")));
                if self_closing_foreign {
                    // Foreign empty elements have no frame or raw-text body,
                    // including <title/> inside SVG.
                    return TokenSinkResult::Continue;
                }
                if !void_tag(name) {
                    if out.stack.len() >= MAX_DEPTH {
                        out.failed = true;
                        return TokenSinkResult::Continue;
                    }
                    let title = name == "title" && !metadata_discard && out.title.is_empty();
                    out.stack.push(Frame {
                        tag: name.to_owned(),
                        discard: parent_discard || hidden || drop_tag(name),
                        metadata_discard,
                        title,
                        protected: !parent_discard && (hidden || drop_tag(name)),
                        scopes,
                    });
                }
                return match name {
                    "script" => TokenSinkResult::RawData(RawKind::ScriptData),
                    "style" | "noscript" | "iframe" | "xmp" | "noembed" | "noframes" => {
                        TokenSinkResult::RawData(RawKind::Rawtext)
                    }
                    "title" | "textarea" => TokenSinkResult::RawData(RawKind::Rcdata),
                    _ => TokenSinkResult::Continue,
                };
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

/// Uses HTML5 tokenization and conservative nesting, with no recursive tree walks.
/// Prefer nonempty main, article, role-main, then body scopes. Unlike server
/// evidenceText, keep document order within that scope rather than ranking blocks,
/// preserve visible form content, and drop header. Genuine depth >512 fails closed.
/// Output is at most 6000 UTF-16 units; retained visible text is bounded per scope.
pub fn extract_evidence(page: &EvidencePage, limit: usize) -> Result<(String, String), String> {
    // Lossy UTF-8 decoding can expand each retained raw byte into three bytes.
    if page.body.is_empty()
        || page.body.len() > limit.saturating_mul(3)
        || page.body.len() > limit
            && page
                .body
                .chars()
                .map(|c| if c == '\u{fffd}' { 1 } else { c.len_utf8() })
                .sum::<usize>()
                > limit
    {
        return Err("Evidence body is empty or exceeds the limit".into());
    }
    let kind = validate_evidence_response(200, std::slice::from_ref(&page.content_type))?;
    let (title, text) = if matches!(kind.as_str(), "text/html" | "application/xhtml+xml") {
        let input = BufferQueue::default();
        input.push_back(StrTendril::from_slice(&page.body));
        let parser = Tokenizer::new(Sink(RefCell::new(Extractor::default())), Default::default());
        let _ = parser.feed(&input);
        parser.end();
        let out = parser.sink.0.into_inner();
        if out.failed {
            return Err("Evidence HTML exceeds its parsing budget".into());
        }
        let title = collapse(&out.title, TITLE_CHARS);
        (
            if title.is_empty() {
                out.og_title
            } else {
                title
            },
            out.scoped
                .into_iter()
                .find(|text| !text.value.is_empty())
                .unwrap_or(out.text)
                .value,
        )
    } else {
        (String::new(), collapse(&page.body, TEXT_CHARS))
    };
    if text.is_empty() {
        return Err("Evidence contains no visible text".into());
    }
    Ok((title, text))
}
