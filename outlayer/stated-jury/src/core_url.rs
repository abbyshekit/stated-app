//! Conservative ASCII admission policy for the contract. The runner also applies URL/IDNA parsing.
//! Keeping the contract independent of URL/HTML tables avoids permanently deploying those tables.

pub fn validate_ascii_url(raw: &str) -> Result<(), String> {
    let invalid = || "Evidence requires a public ASCII HTTPS URL, at most 600 bytes".to_owned();
    if raw.len() > 600
        || !raw.is_ascii()
        || raw
            .bytes()
            .any(|c| c <= 32 || c == 127 || b"\\#\"'<>`{}".contains(&c))
        || raw
            .get(..8)
            .is_none_or(|s| !s.eq_ignore_ascii_case("https://"))
    {
        return Err(invalid());
    }
    let authority = raw[8..].split(['/', '?']).next().unwrap_or_default();
    let host = authority.trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<_> = host.split('.').collect();
    let suffix = labels.last().copied().unwrap_or_default();
    if authority.ends_with("..")
        || host.len() > 253
        || labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
                || !label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                || label.strip_prefix("xn--").is_some_and(|ace| !safe_punycode(ace))
        })
        || suffix.len() < 2
        || suffix.bytes().all(|c| c.is_ascii_digit())
        || suffix.strip_prefix("0x").is_some_and(|n| n.bytes().all(|c| c.is_ascii_hexdigit()))
        || ["localhost", "local", "internal", "intranet", "lan", "home", "onion", "test", "invalid", "arpa"].contains(&suffix)
        || ["x.com", "twitter.com"].iter().any(|blocked| host == *blocked || host.ends_with(&format!(".{blocked}")))
        // URL parsing inserts a slash before a query or after a bare authority.
        || (raw[8 + authority.len()..].starts_with('?') || raw.len() == 8 + authority.len()) && raw.len() == 600
    {
        return Err(invalid());
    }
    Ok(())
}

// RFC 3492 decoding with checked arithmetic. Admission deliberately accepts only
// LDH, lowercase Latin-1 letters and CJK unified ideographs. Other IDNA scripts
// remain available to runner-only callers; contract users can choose an ASCII host.
fn safe_punycode(ace: &str) -> bool {
    let mut points: Vec<u32> = Vec::new();
    let mut encoded = ace;
    if let Some((basic, tail)) = ace.rsplit_once('-') {
        if basic.is_empty() || !basic.bytes().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
        points.extend(basic.bytes().map(u32::from));
        encoded = tail;
    }
    let mut digits = encoded.bytes();
    let (mut n, mut i, mut bias) = (128u32, 0u32, 72u32);
    while digits.len() > 0 {
        let old = i;
        let mut weight = 1u32;
        let mut k = 36u32;
        loop {
            let Some(digit) = digits.next().and_then(|c| match c {
                b'a'..=b'z' => Some(u32::from(c - b'a')),
                b'0'..=b'9' => Some(u32::from(c - b'0') + 26),
                _ => None,
            }) else {
                return false;
            };
            let Some(next) = digit.checked_mul(weight).and_then(|v| i.checked_add(v)) else {
                return false;
            };
            i = next;
            let threshold = k.saturating_sub(bias).clamp(1, 26);
            if digit < threshold {
                break;
            }
            let Some(next) = weight.checked_mul(36 - threshold) else {
                return false;
            };
            weight = next;
            k += 36;
        }
        let count = points.len() as u32 + 1;
        let mut delta = (i - old) / if old == 0 { 700 } else { 2 };
        delta += delta / count;
        let mut adjustment = 0;
        while delta > 455 {
            delta /= 35;
            adjustment += 36;
        }
        bias = adjustment + 36 * delta / (delta + 38);
        let Some(next) = n.checked_add(i / count) else {
            return false;
        };
        n = next;
        i %= count;
        if !matches!(n, 0x00e0..=0x00f6 | 0x00f8..=0x00ff | 0x4e00..=0x9fff) {
            return false;
        }
        points.insert(i as usize, n);
        i += 1;
    }
    points.iter().any(|c| *c >= 128)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lean_url_policy_rejects_idna_and_numeric_host_evasions() {
        for url in [
            "https://bücher.de/a",
            "https://news.123/a",
            "https://news.0xff/a",
            "https://xn--a.com/",
            "https://xn--.com/",
            "https://x.com./a",
            "https://%78.com/a",
            "https://news.com:443/a",
            "https://127.0.0.1/a",
            "https://a.local/a",
            "https://news.com/a#fragment",
        ] {
            assert!(validate_ascii_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn every_core_accepted_url_is_accepted_by_runner() {
        for url in [
            "HTTPS://WWW.NASA.GOV",
            "https://news.com./a",
            "https://news.com/a%20b?q=x@y",
            "https://xn--bcher-kva.de/a",
            "https://xn--fsqu00a.xn--fiqs8s/a",
            "https://reuters.com/world?story=1",
            "https://news.com/path/../a",
        ] {
            assert!(validate_ascii_url(url).is_ok(), "{url}");
            #[cfg(feature = "runner")]
            assert!(crate::evidence::validate_evidence_url(url).is_ok(), "{url}");
        }
    }
    #[test]
    #[cfg(feature = "runner")]
    fn punycode_mutations_preserve_core_runner_subset() {
        let mut accepted = 0;
        let mut check = |ace: &str| {
            let url = format!("https://xn--{ace}.com/a");
            if validate_ascii_url(&url).is_ok() {
                accepted += 1;
                assert!(
                    crate::evidence::validate_evidence_url(&url).is_ok(),
                    "{url}"
                );
            }
        };
        for seed in ["bcher-kva", "fsqu00a", "fiqs8s", "zca", "e1afmkfd", "a", ""] {
            check(seed);
            for i in 0..=seed.len() {
                for c in "abcdefghijklmnopqrstuvwxyz0123456789-".chars() {
                    let mut ace = seed.to_owned();
                    ace.insert(i, c);
                    check(&ace);
                    if i < seed.len() {
                        let mut ace = seed.to_owned();
                        ace.replace_range(i..=i, &c.to_string());
                        check(&ace);
                    }
                }
            }
        }
        assert!(accepted > 0);
    }
    #[test]
    #[cfg(feature = "runner")]
    fn core_acceptance_implies_runner_acceptance_for_ascii_boundary_corpus() {
        for byte in 0..=127u8 {
            for prefix in ["https://news.com/", "https://news.com/?q=", "https://"] {
                for length in [1, 580, 581, 582, 583, 584, 585] {
                    let raw = format!("{prefix}{}{}", "a".repeat(length), char::from(byte));
                    if validate_ascii_url(&raw).is_ok() {
                        assert!(
                            crate::evidence::validate_evidence_url(&raw).is_ok(),
                            "{raw:?}"
                        );
                    }
                }
            }
        }
    }
}
