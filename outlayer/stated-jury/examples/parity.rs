//! Native-only mock harness for scripts/verify-outlayer-parity.mjs. No network or secrets.
use serde::Deserialize;
use serde_json::json;
use stated_jury::{
    decide, run, EvidencePage, ExecutionInput, Transport, Verdict, MODELS, PLAN_PROMPT,
    VERDICT_PROMPT,
};
use std::collections::VecDeque;
use std::io::{self, Read};

#[derive(Deserialize)]
struct Fixture {
    input: ExecutionInput,
    candles: Vec<String>,
    decisions: Vec<Vec<Verdict>>,
    pages: Option<Vec<Page>>,
}
#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    body: String,
    content_type: String,
    bytes: Option<Vec<u8>>,
    final_url: Option<String>,
    unreadable: Option<String>,
}
struct Mock {
    candles: VecDeque<String>,
    calls: Vec<serde_json::Value>,
    pages: Option<Vec<Page>>,
}
impl Transport for Mock {
    fn evidence_pages(&mut self, urls: &[&str], limit: usize) -> Result<Vec<EvidencePage>, String> {
        if let Some(pages) = self.pages.take() {
            if pages.len() != urls.len() {
                return Err("Fixture page count differs from requested sources".into());
            }
            Ok(pages
                .into_iter()
                .map(|page| EvidencePage {
                    body: page
                        .bytes
                        .map(|bytes| {
                            stated_jury::decode_evidence_body(&bytes)
                                .expect("Lossy evidence decode")
                        })
                        .unwrap_or(page.body),
                    content_type: page.content_type,
                    final_url: page.final_url,
                    unreadable: page.unreadable,
                    redirected: false,
                })
                .collect())
        } else {
            urls.iter()
                .map(|url| {
                    self.get(url, limit).map(|body| EvidencePage {
                        body,
                        content_type: "text/plain".into(),
                        final_url: None,
                        unreadable: None,
                        redirected: false,
                    })
                })
                .collect()
        }
    }
    fn get(&mut self, _url: &str, _limit: usize) -> Result<String, String> {
        self.candles
            .pop_front()
            .ok_or("Missing fixture candle".into())
    }
    fn complete(&mut self, model: &str, system: &str, input: &str) -> Result<String, String> {
        self.calls
            .push(json!({"model":model,"system":system,"input":input}));
        Ok(
            r#"{"outcome":"yes","confidence":0.8,"reason":"The primary feed supplies the price."}"#
                .into(),
        )
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut text = String::new();
    io::stdin().take(1_000_001).read_to_string(&mut text)?;
    if text.len() > 1_000_000 {
        return Err("Fixture exceeds limit".into());
    }
    let fixture: Fixture = serde_json::from_str(&text)?;
    let mut mock = Mock {
        candles: fixture.candles.into(),
        calls: Vec::new(),
        pages: fixture.pages,
    };
    let result = run(fixture.input, &mut mock)?;
    println!(
        "{}",
        json!({"plan_prompt":PLAN_PROMPT,"verdict_prompt":VERDICT_PROMPT,"models":MODELS,"result":result,"calls":mock.calls,
        "decisions":fixture.decisions.iter().map(|v|decide(v)).collect::<Vec<_>>()})
    );
    Ok(())
}
