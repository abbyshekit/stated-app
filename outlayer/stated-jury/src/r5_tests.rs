//! Regression coverage for readable-evidence gating and bounded HTML extraction.
use super::*;

struct Sources {
    pages: Vec<EvidencePage>,
    calls: Vec<String>,
    limit: usize,
}
impl Transport for Sources {
    fn get(&mut self, _: &str, _: usize) -> Result<String, String> {
        panic!("Evidence must use the batch transport")
    }
    fn evidence_pages(&mut self, _: &[&str], limit: usize) -> Result<Vec<EvidencePage>, String> {
        self.limit = limit;
        Ok(std::mem::take(&mut self.pages))
    }
    fn complete(&mut self, _: &str, _: &str, input: &str) -> Result<String, String> {
        self.calls.push(input.into());
        Ok(
            r#"{"outcome":"yes","confidence":0.9,"reason":"The official record confirms it."}"#
                .into(),
        )
    }
}
fn input(open: bool, count: usize, attempt: u64) -> ExecutionInput {
    let items: Vec<_> = (0..count)
        .map(|i| SubmittedSource {
            side: if i % 2 == 0 { "yes" } else { "no" }.into(),
            url: format!("https://agency.gov/record/{i}"),
        })
        .collect();
    ExecutionInput {
        attempt,
        material: BetMaterial {
            bet_id: "r5-evidence".into(),
            claim: "The agency approved the rule".into(),
            made_at: "2026-01-01T10:00:00.000Z".into(),
            deadline: "2026-01-01T12:00:00.000Z".into(),
            post_url: "https://agency.gov/context".into(),
            evidence: if open {
                EvidenceSpec::Open {
                    window_seconds: 1,
                    max_per_side: 4,
                }
            } else {
                EvidenceSpec::Submitted {
                    items: items.clone(),
                }
            },
        },
        terms_hash: "b".repeat(64),
        now: "2026-01-01T12:02:00.000Z".into(),
        submitted_evidence: if open { items } else { vec![] },
    }
}
fn transport(pages: Vec<EvidencePage>) -> Sources {
    Sources {
        pages,
        calls: vec![],
        limit: 0,
    }
}
fn html(body: &str) -> EvidencePage {
    EvidencePage::read(body.into(), "text/html".into(), None)
}

#[test]
fn r5_no_readable_evidence_aborts_on_every_attempt() {
    for attempt in [1, 2, 3, 4, u64::MAX] {
        for open in [false, true] {
            for empty_body in [false, true] {
                let pages = (0..2)
                    .map(|_| {
                        if empty_body {
                            html("<script>only script</script>")
                        } else {
                            EvidencePage::unreadable("status 404".into())
                        }
                    })
                    .collect();
                let mut io = transport(pages);
                assert_eq!(
                    run(input(open, 2, attempt), &mut io).unwrap_err(),
                    "No readable evidence"
                );
                assert!(io.calls.is_empty());
            }
        }
        let mut io = transport(vec![]);
        assert_eq!(
            run(input(true, 0, attempt), &mut io).unwrap_err(),
            "No readable evidence"
        );
        assert!(io.calls.is_empty());
    }
}

#[test]
fn r5_mixed_evidence_preserves_retry_policy() {
    for open in [false, true] {
        for attempt in [1, 2, 3, u64::MAX] {
            // Exercise unreadable sources both before and after a readable source.
            for bad_first in [false, true] {
                let mut pages = vec![
                    html("<p>The agency approved the rule.</p>"),
                    EvidencePage::unreadable("status 404".into()),
                ];
                if bad_first {
                    pages.reverse();
                }
                let mut io = transport(pages);
                let result = run(input(open, 2, attempt), &mut io);
                if attempt < 3 {
                    assert!(result
                        .unwrap_err()
                        .starts_with("Unreadable evidence before attempt 3:"));
                    assert!(io.calls.is_empty());
                } else {
                    assert_eq!(result.unwrap().outcome, "yes");
                    assert_eq!(io.calls.len(), MODELS.len());
                    let prompt: Value = serde_json::from_str(&io.calls[0]).unwrap();
                    assert_eq!(
                        prompt["evidenceNote"],
                        "An unreadable link is not evidence for either side."
                    );
                    let bad = usize::from(!bad_first);
                    assert_eq!(prompt["evidence"]["items"][bad]["unreadable"], "status 404");
                    assert_eq!(prompt["evidence"]["items"][bad]["text"], "");
                }
            }
        }
    }
}

#[test]
fn r5_evidence_body_cap_matches_server() {
    for open in [false, true] {
        let mut body = " ".repeat(1_999_940);
        body.push_str("<article><p>The agency approved the rule.</p></article>");
        assert!(body.len() <= 2_000_000 && body.len() > 200_000);
        let mut io = transport(vec![html(&body)]);
        assert_eq!(run(input(open, 1, 1), &mut io).unwrap().outcome, "yes");
        assert_eq!(io.limit, 2_000_000);
        let prompt: Value = serde_json::from_str(&io.calls[0]).unwrap();
        assert_eq!(
            prompt["evidence"]["items"][0]["text"],
            "The agency approved the rule."
        );
    }
}

#[test]
fn r5_lossy_body_expansion_is_not_an_oversize_source() {
    let decoded = decode_evidence_body(&vec![0x9d; 2_000_000]).unwrap();
    assert_eq!(decoded.len(), 6_000_000);
    let page = EvidencePage::read(decoded, "text/plain".into(), None);
    let (_, text) = extract_evidence(&page, 2_000_000).unwrap();
    assert_eq!(text.encode_utf16().count(), 6000);
}

#[test]
fn r5_maximum_evidence_batch_stays_bounded() {
    let pages = (0..8)
        .map(|_| {
            EvidencePage::read(
                decode_evidence_body(&vec![0x9d; 2_000_000]).unwrap(),
                "text/html".into(),
                None,
            )
        })
        .collect();
    let mut io = transport(pages);
    let result = run(input(true, 8, 3), &mut io).unwrap();
    assert_eq!(io.limit, 2_000_000);
    assert_eq!(
        result.evidence_summary["items"].as_array().unwrap().len(),
        8
    );
    assert_eq!(io.calls.len(), MODELS.len());
    let prompt: Value = serde_json::from_str(&io.calls[0]).unwrap();
    for item in prompt["evidence"]["items"].as_array().unwrap() {
        assert_eq!(item["text"].as_str().unwrap().encode_utf16().count(), 6000);
        assert!(item.get("unreadable").is_none());
    }
}

#[test]
fn r5_form_keeps_visible_text_and_excludes_controls() {
    let page = html("<body><form id=aspnetForm><div><h1>Agency record</h1><p>The agency approved the rule.</p><input value=secret><button>secret</button><select><option>secret</option></select><textarea>secret</textarea><div hidden>secret</div><script>secret</script><style>secret</style><noscript>secret</noscript><template>secret</template><nav>secret</nav></div></form></body>");
    assert_eq!(
        extract_evidence(&page, 2_000_000).unwrap().1,
        "Agency record The agency approved the rule."
    );
}

#[test]
fn r5_implied_closes_keep_long_documents_readable() {
    for (prefix, tags, suffix) in [
        ("<body>", vec!["p"], "</body>"),
        ("<ul>", vec!["li"], "</ul>"),
        ("<dl>", vec!["dt", "dd"], "</dl>"),
        ("<table>", vec!["tr", "td"], "</table>"),
        ("<table><tr>", vec!["td", "th"], "</table>"),
        ("<body>", vec!["h1", "h2"], "</body>"),
    ] {
        let mut body = prefix.to_owned();
        for i in 0..600 {
            body.push_str(&format!("<{}><b>Row{i}", tags[i % tags.len()]));
        }
        body.push_str(suffix);
        let (_, text) = extract_evidence(&html(&body), 2_000_000).unwrap();
        assert!(text.starts_with("Row0 Row1"));
        assert!(text.contains("Row599"));
    }
}

#[test]
fn r5_main_content_precedes_leading_chrome() {
    let chrome = "<div>Trending story headline.</div>".repeat(400);
    for scope in ["article", "main", "div role=' MAIN '"] {
        let tag = scope.split_whitespace().next().unwrap();
        let body =
            format!("<body>{chrome}<{scope}><p>The agency approved the rule.</p></{tag}></body>");
        assert_eq!(
            extract_evidence(&html(&body), 2_000_000).unwrap().1,
            "The agency approved the rule."
        );
    }
    for body in [
        "<body>Body text<article>Article text</article><main>Main text</main></body>",
        "<body>Body text<div role=main>Role text</div><main>Main text</main></body>",
    ] {
        assert_eq!(
            extract_evidence(&html(body), 2_000_000).unwrap().1,
            "Main text"
        );
    }
    assert_eq!(
        extract_evidence(
            &html("<body>Body text<main hidden>Secret</main><article> </article></body>"),
            2_000_000
        )
        .unwrap()
        .1,
        "Body text"
    );
}
