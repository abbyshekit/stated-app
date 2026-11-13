//! Strict streaming decoding for committed evidence and price-window objects.

use crate::{EvidenceSpec, PriceWindow, SubmittedSource};
use serde::de::{Error, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

fn set_field<'de, A: MapAccess<'de>, T: Deserialize<'de>>(
    map: &mut A,
    slot: &mut Option<T>,
    name: &'static str,
) -> Result<(), A::Error> {
    if slot.is_some() {
        return Err(A::Error::duplicate_field(name));
    }
    // Decode T directly: null must fail instead of making a field appear absent.
    *slot = Some(map.next_value()?);
    Ok(())
}

fn required<T, E: Error>(slot: Option<T>, name: &'static str) -> Result<T, E> {
    slot.ok_or_else(|| E::missing_field(name))
}

fn reject_extra<E: Error>(seen: u8, allowed: u8, names: &[&str]) -> Result<(), E> {
    for (index, name) in names.iter().enumerate() {
        if seen & !allowed & (1 << index) != 0 {
            return Err(E::custom(format_args!("Unexpected field {name} for kind")));
        }
    }
    Ok(())
}

impl<'de> Deserialize<'de> for EvidenceSpec {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EvidenceVisitor;
        impl<'de> Visitor<'de> for EvidenceVisitor {
            type Value = EvidenceSpec;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an evidence object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                const FIELDS: &[&str] = &[
                    "product",
                    "window",
                    "items",
                    "window_seconds",
                    "max_per_side",
                ];
                let mut kind: Option<String> = None;
                let mut product: Option<String> = None;
                let mut window: Option<PriceWindow> = None;
                let mut items: Option<Vec<SubmittedSource>> = None;
                let mut window_seconds: Option<u32> = None;
                let mut max_per_side: Option<u8> = None;
                let mut seen = 0;
                while let Some(key) = map.next_key::<String>()? {
                    let index = match key.as_str() {
                        "kind" => {
                            set_field(&mut map, &mut kind, "kind")?;
                            continue;
                        }
                        "product" => {
                            set_field(&mut map, &mut product, "product")?;
                            0
                        }
                        "window" => {
                            set_field(&mut map, &mut window, "window")?;
                            1
                        }
                        "items" => {
                            set_field(&mut map, &mut items, "items")?;
                            2
                        }
                        "window_seconds" => {
                            set_field(&mut map, &mut window_seconds, "window_seconds")?;
                            3
                        }
                        "max_per_side" => {
                            set_field(&mut map, &mut max_per_side, "max_per_side")?;
                            4
                        }
                        _ => {
                            return Err(A::Error::unknown_field(
                                &key,
                                &[
                                    "kind",
                                    "product",
                                    "window",
                                    "items",
                                    "window_seconds",
                                    "max_per_side",
                                ],
                            ))
                        }
                    };
                    seen |= 1 << index;
                }
                match required::<_, A::Error>(kind, "kind")?.as_str() {
                    "auto" => {
                        reject_extra::<A::Error>(seen, 0, FIELDS)?;
                        Ok(EvidenceSpec::Auto)
                    }
                    "coinbase" => {
                        reject_extra::<A::Error>(seen, 0b00011, FIELDS)?;
                        Ok(EvidenceSpec::Coinbase {
                            product: required(product, "product")?,
                            window: required(window, "window")?,
                        })
                    }
                    "submitted" => {
                        reject_extra::<A::Error>(seen, 0b00100, FIELDS)?;
                        Ok(EvidenceSpec::Submitted {
                            items: required(items, "items")?,
                        })
                    }
                    "open" => {
                        reject_extra::<A::Error>(seen, 0b11000, FIELDS)?;
                        Ok(EvidenceSpec::Open {
                            window_seconds: required(window_seconds, "window_seconds")?,
                            max_per_side: required(max_per_side, "max_per_side")?,
                        })
                    }
                    kind => Err(A::Error::unknown_variant(
                        kind,
                        &["auto", "coinbase", "submitted", "open"],
                    )),
                }
            }
        }
        deserializer.deserialize_map(EvidenceVisitor)
    }
}

impl<'de> Deserialize<'de> for PriceWindow {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct WindowVisitor;
        impl<'de> Visitor<'de> for WindowVisitor {
            type Value = PriceWindow;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a price-window object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                const FIELDS: &[&str] = &["at", "start", "end"];
                let mut kind: Option<String> = None;
                let mut at: Option<String> = None;
                let mut start: Option<String> = None;
                let mut end: Option<String> = None;
                let mut seen = 0;
                while let Some(key) = map.next_key::<String>()? {
                    let index = match key.as_str() {
                        "kind" => {
                            set_field(&mut map, &mut kind, "kind")?;
                            continue;
                        }
                        "at" => {
                            set_field(&mut map, &mut at, "at")?;
                            0
                        }
                        "start" => {
                            set_field(&mut map, &mut start, "start")?;
                            1
                        }
                        "end" => {
                            set_field(&mut map, &mut end, "end")?;
                            2
                        }
                        _ => {
                            return Err(A::Error::unknown_field(
                                &key,
                                &["kind", "at", "start", "end"],
                            ))
                        }
                    };
                    seen |= 1 << index;
                }
                match required::<_, A::Error>(kind, "kind")?.as_str() {
                    "moment" => {
                        reject_extra::<A::Error>(seen, 0b001, FIELDS)?;
                        Ok(PriceWindow::Moment {
                            at: required(at, "at")?,
                        })
                    }
                    "range" => {
                        reject_extra::<A::Error>(seen, 0b110, FIELDS)?;
                        Ok(PriceWindow::Range {
                            start: required(start, "start")?,
                            end: required(end, "end")?,
                        })
                    }
                    kind => Err(A::Error::unknown_variant(kind, &["moment", "range"])),
                }
            }
        }
        deserializer.deserialize_map(WindowVisitor)
    }
}

#[cfg(test)]
mod tests {
    use crate::{EvidenceSpec, PriceWindow};

    #[test]
    fn evidence_wire_variants_allow_any_key_order() {
        for raw in [
            r#"{"kind":"auto"}"#,
            r#"{"kind":"coinbase","product":"NEAR-USD","window":{"kind":"moment","at":"2026-01-01T00:00Z"}}"#,
            r#"{"window":{"end":"end","kind":"range","start":"start"},"product":"NEAR-USD","kind":"coinbase"}"#,
            r#"{"items":[],"kind":"submitted"}"#,
            r#"{"items":[{"url":"https://news.com/a","side":"yes"}],"kind":"submitted"}"#,
            r#"{"max_per_side":4,"window_seconds":3600,"kind":"open"}"#,
            r#"{"kind":"open","window_seconds":4294967295,"max_per_side":255}"#,
            r#"{"kind":"open","window_seconds":0,"max_per_side":0}"#,
        ] {
            let value: EvidenceSpec = serde_json::from_str(raw).expect(raw);
            let encoded = serde_json::to_string(&value).expect("serialize evidence");
            assert_eq!(
                serde_json::from_str::<EvidenceSpec>(&encoded).unwrap(),
                value
            );
        }
        assert_eq!(
            serde_json::from_str::<EvidenceSpec>(r#"{"kind":"auto"}"#).unwrap(),
            EvidenceSpec::Auto
        );
        assert_eq!(
            serde_json::from_str::<EvidenceSpec>(
                r#"{"max_per_side":4,"window_seconds":3600,"kind":"open"}"#
            )
            .unwrap(),
            EvidenceSpec::Open {
                window_seconds: 3600,
                max_per_side: 4
            }
        );
    }

    #[test]
    fn evidence_wire_rejects_duplicate_unknown_missing_and_mistyped_fields() {
        for raw in [
            "null",
            "true",
            "4",
            "[]",
            "{}",
            r#"{"kind":null}"#,
            r#"{"kind":true}"#,
            r#"{"kind":2}"#,
            r#"{"kind":"other"}"#,
            r#"{"kind":"Auto"}"#,
            r#"{"kind":"auto","kind":"auto"}"#,
            r#"{"kind":null,"kind":"auto"}"#,
            r#"{"kind":"auto","kind":null}"#,
            r#"{"kind":"auto","extra":null}"#,
            r#"{"kind":"auto","product":null}"#,
            r#"{"kind":"auto","window":null}"#,
            r#"{"kind":"auto","product":"NEAR-USD"}"#,
            r#"{"kind":"auto","items":[]}"#,
            r#"{"kind":"auto","window_seconds":1}"#,
            r#"{"kind":"coinbase","product":"NEAR-USD"}"#,
            r#"{"kind":"coinbase","window":{"kind":"moment","at":"at"}}"#,
            r#"{"kind":"coinbase","product":null,"window":{"kind":"moment","at":"at"}}"#,
            r#"{"kind":"coinbase","product":7,"window":{"kind":"moment","at":"at"}}"#,
            r#"{"kind":"coinbase","product":"NEAR-USD","window":null}"#,
            r#"{"kind":"coinbase","product":"NEAR-USD","product":"BTC-USD","window":{"kind":"moment","at":"at"}}"#,
            r#"{"kind":"coinbase","product":"NEAR-USD","window":{"kind":"moment","at":"at"},"items":null}"#,
            r#"{"kind":"coinbase","product":"NEAR-USD","window":{"kind":"moment","at":"at"},"items":[]}"#,
            r#"{"kind":"submitted"}"#,
            r#"{"kind":"submitted","items":null}"#,
            r#"{"kind":"submitted","items":false}"#,
            r#"{"kind":"submitted","items":[],"items":[]}"#,
            r#"{"kind":"submitted","items":[{"side":"yes","url":"u","extra":null}]}"#,
            r#"{"kind":"submitted","items":[],"max_per_side":null}"#,
            r#"{"kind":"submitted","items":[],"max_per_side":1}"#,
            r#"{"kind":"open","max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":3600}"#,
            r#"{"kind":"open","window_seconds":null,"max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":true,"max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":"3600","max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":1.0,"max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":4294967296,"max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":-1,"max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":256}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":1.0}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":false}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":null,"max_per_side":4}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":4,"window_seconds":3600}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":4,"window":null}"#,
            r#"{"kind":"open","window_seconds":3600,"max_per_side":4,"product":"NEAR-USD"}"#,
        ] {
            assert!(
                serde_json::from_str::<EvidenceSpec>(raw).is_err(),
                "accepted {raw}"
            );
        }
    }

    #[test]
    fn price_window_wire_preserves_variants_and_rejects_invalid_shapes() {
        assert_eq!(
            serde_json::from_str::<PriceWindow>(r#"{"at":"at","kind":"moment"}"#).unwrap(),
            PriceWindow::Moment { at: "at".into() }
        );
        assert_eq!(
            serde_json::from_str::<PriceWindow>(r#"{"end":"end","start":"start","kind":"range"}"#)
                .unwrap(),
            PriceWindow::Range {
                start: "start".into(),
                end: "end".into()
            }
        );
        for raw in [
            "null",
            "false",
            "[]",
            "{}",
            r#"{"kind":null}"#,
            r#"{"kind":1}"#,
            r#"{"kind":"other"}"#,
            r#"{"kind":"moment","kind":"moment","at":"at"}"#,
            r#"{"kind":null,"kind":"moment","at":"at"}"#,
            r#"{"kind":"moment"}"#,
            r#"{"kind":"moment","at":null}"#,
            r#"{"kind":"moment","at":12}"#,
            r#"{"kind":"moment","at":true}"#,
            r#"{"kind":"moment","at":"at","at":"again"}"#,
            r#"{"kind":"moment","at":null,"at":"at"}"#,
            r#"{"kind":"moment","at":"at","start":null}"#,
            r#"{"kind":"moment","at":"at","start":"start"}"#,
            r#"{"kind":"moment","at":"at","extra":null}"#,
            r#"{"kind":"range","start":"start"}"#,
            r#"{"kind":"range","end":"end"}"#,
            r#"{"kind":"range","start":null,"end":"end"}"#,
            r#"{"kind":"range","start":"start","end":null}"#,
            r#"{"kind":"range","start":"start","end":false}"#,
            r#"{"kind":"range","start":"start","end":"end","at":null}"#,
            r#"{"kind":"range","start":"start","end":"end","at":"at"}"#,
            r#"{"kind":"range","start":"start","end":"end","end":"again"}"#,
        ] {
            assert!(
                serde_json::from_str::<PriceWindow>(raw).is_err(),
                "accepted {raw}"
            );
        }
    }
}
