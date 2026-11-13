//! Local WASM regression probe. No network, secrets or state mutations.
use stated_jury::{material_hash, BetMaterial, EvidenceSpec, ExecutionInput, PriceWindow};

fn hash() -> String {
    material_hash(&ExecutionInput {
        attempt: 1,
        material: BetMaterial {
            bet_id: "bet-1".into(),
            claim: "BTC above 100 at noon".into(),
            made_at: "2026-01-01T11:00:00.000Z".into(),
            deadline: "2026-01-01T12:00:00.000Z".into(),
            post_url: "https://example.com/post".into(),
            evidence: EvidenceSpec::Coinbase {
                product: "BTC-USD".into(),
                window: PriceWindow::Moment {
                    at: "2026-01-01T12:00:00.000Z".into(),
                },
            },
        },
        terms_hash: "terms-1".into(),
        now: "2026-01-01T12:02:00.000Z".into(),
        submitted_evidence: vec![],
    })
    .expect("Fixed valid probe input")
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn core_hash_probe() -> u32 {
    // The one-shot local harness reads 64 ASCII bytes from the exported memory.
    Box::leak(hash().into_boxed_str()).as_ptr() as u32
}

fn main() {
    assert_eq!(
        hash(),
        "018f2d26dc2fda19fd81ffcc199c81b98d1744d70db1a414862e539f93328a32"
    );
}
