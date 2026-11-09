//! Partner unlock tokens: ECDSA P-256 / SHA-256 over the exact payload bytes.
//! Wire formats are shared with src/modules/focus/unlock.js:
//!   publicKey = base64url(65-byte uncompressed SEC1 point), no padding
//!   code      = base64url(UTF-8 JSON {"n":nonce,"w":windowId})
//!   token     = base64url(payload JSON bytes) + "." + base64url(r||s, 64 bytes)
//!   payload   = UTF-8 JSON {"n":nonce,"w":windowId,"exp":ms}

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const CHALLENGE_TTL_MS: i64 = 3_600_000;
pub const DEFAULT_TOKEN_TTL_MS: i64 = 600_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub nonce: String,
    pub window_id: String,
    pub issued: i64,
    pub used: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockError {
    BadFormat,
    BadSignature,
    WrongChallenge,
    WrongLock,
    Used,
    ChallengeExpired,
    Expired,
}

impl UnlockError {
    /// Same kebab-case strings as the JS reasons.
    pub fn reason(&self) -> &'static str {
        match self {
            UnlockError::BadFormat => "bad-format",
            UnlockError::BadSignature => "bad-signature",
            UnlockError::WrongChallenge => "wrong-challenge",
            UnlockError::WrongLock => "wrong-lock",
            UnlockError::Used => "used",
            UnlockError::ChallengeExpired => "challenge-expired",
            UnlockError::Expired => "expired",
        }
    }
}

impl std::fmt::Display for UnlockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason())
    }
}

impl std::error::Error for UnlockError {}

/// Strict base64url: no padding, no other alphabet, no non-zero trailing bits.
pub fn b64u_decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn b64u_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Parses a partner public key: strict base64url of a 65-byte uncompressed P-256 point.
pub fn parse_public_key(public_key_b64: &str) -> Option<VerifyingKey> {
    let raw = b64u_decode(public_key_b64)?;
    if raw.len() != 65 || raw[0] != 0x04 {
        return None;
    }
    VerifyingKey::from_sec1_bytes(&raw).ok()
}

/// A token split into its strictly decoded parts, shape-checked like the JS.
pub(crate) struct ParsedToken {
    pub payload: Vec<u8>,
    pub sig: Vec<u8>,
    pub nonce: String,
    pub window_id: String,
    pub exp: f64,
}

pub(crate) fn parse_token(token: &str) -> Result<ParsedToken, UnlockError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 2 {
        return Err(UnlockError::BadFormat);
    }
    let payload = b64u_decode(parts[0]).ok_or(UnlockError::BadFormat)?;
    let sig = b64u_decode(parts[1]).ok_or(UnlockError::BadFormat)?;
    if sig.len() != 64 {
        return Err(UnlockError::BadFormat);
    }
    let v: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| UnlockError::BadFormat)?;
    let nonce = v.get("n").and_then(|x| x.as_str()).ok_or(UnlockError::BadFormat)?.to_string();
    let window_id = v.get("w").and_then(|x| x.as_str()).ok_or(UnlockError::BadFormat)?.to_string();
    let exp = match v.get("exp") {
        Some(serde_json::Value::Number(n)) => n.as_f64().ok_or(UnlockError::BadFormat)?,
        _ => return Err(UnlockError::BadFormat),
    };
    Ok(ParsedToken { payload, sig, nonce, window_id, exp })
}

/// Checks run in the same order as the JS: bad-format, bad-signature, wrong-challenge,
/// wrong-lock, used, challenge-expired, expired.
pub fn verify(
    public_key_b64: &str,
    token: &str,
    challenge: &Challenge,
    now_ms: i64,
) -> Result<(), UnlockError> {
    let t = parse_token(token)?;

    let valid = (|| {
        let key = parse_public_key(public_key_b64)?;
        let sig = Signature::from_slice(&t.sig).ok()?;
        key.verify(&t.payload, &sig).ok()
    })()
    .is_some();
    if !valid {
        return Err(UnlockError::BadSignature);
    }

    if t.nonce != challenge.nonce {
        return Err(UnlockError::WrongChallenge);
    }
    if t.window_id != challenge.window_id {
        return Err(UnlockError::WrongLock);
    }
    if challenge.used {
        return Err(UnlockError::Used);
    }
    if now_ms - challenge.issued > CHALLENGE_TTL_MS {
        return Err(UnlockError::ChallengeExpired);
    }
    if (now_ms as f64) >= t.exp {
        return Err(UnlockError::Expired);
    }
    Ok(())
}

/// The challenge code the partner pastes into their page (same as JS createChallenge).
pub fn challenge_code(nonce: &str, window_id: &str) -> String {
    let json = serde_json::json!({ "n": nonce, "w": window_id }).to_string();
    b64u_encode(json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;

    fn key() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
        let pk = b64u_encode(sk.verifying_key().to_encoded_point(false).as_bytes());
        (sk, pk)
    }

    fn sign_raw(sk: &SigningKey, payload: &[u8]) -> String {
        let sig: Signature = sk.sign(payload);
        format!("{}.{}", b64u_encode(payload), b64u_encode(&sig.to_bytes()))
    }

    fn ch() -> Challenge {
        Challenge { nonce: "nn".into(), window_id: "ww".into(), issued: 1_000, used: false }
    }

    fn good_payload() -> Vec<u8> {
        br#"{"n":"nn","w":"ww","exp":5000}"#.to_vec()
    }

    #[test]
    fn accepts_self_signed_token() {
        let (sk, pk) = key();
        assert_eq!(verify(&pk, &sign_raw(&sk, &good_payload()), &ch(), 2_000), Ok(()));
    }

    #[test]
    fn exp_boundary_is_expired() {
        let (sk, pk) = key();
        let t = sign_raw(&sk, &good_payload());
        assert_eq!(verify(&pk, &t, &ch(), 4_999), Ok(()));
        assert_eq!(verify(&pk, &t, &ch(), 5_000), Err(UnlockError::Expired));
    }

    #[test]
    fn missing_or_mistyped_fields_are_bad_format() {
        let (sk, pk) = key();
        for p in [
            &br#"{"w":"ww","exp":5000}"#[..],
            br#"{"n":"nn","exp":5000}"#,
            br#"{"n":"nn","w":"ww"}"#,
            br#"{"n":1,"w":"ww","exp":5000}"#,
            br#"{"n":"nn","w":2,"exp":5000}"#,
            br#"{"n":"nn","w":"ww","exp":"5000"}"#,
            br#"{"n":"nn","w":"ww","exp":null}"#,
            br#"[]"#,
            br#"null"#,
            b"not json",
            &[0xff, 0xfe, 0x7b],
        ] {
            assert_eq!(verify(&pk, &sign_raw(&sk, p), &ch(), 2_000), Err(UnlockError::BadFormat), "{p:?}");
        }
    }

    #[test]
    fn non_canonical_base64url_is_bad_format() {
        let (sk, pk) = key();
        let t = sign_raw(&sk, &good_payload());
        let (p, s) = t.split_once('.').unwrap();
        // padding
        assert_eq!(verify(&pk, &format!("{p}=.{s}"), &ch(), 2_000), Err(UnlockError::BadFormat));
        // standard alphabet characters
        assert_eq!(verify(&pk, &format!("{}+.{s}", &p[..p.len() - 1]), &ch(), 2_000), Err(UnlockError::BadFormat));
        // non-zero trailing bits: change last char of the signature (64 bytes -> 86 chars, last has 4 spare bits)
        let mut sb: Vec<char> = s.chars().collect();
        let last = sb.len() - 1;
        sb[last] = if sb[last] == 'B' { 'C' } else { 'B' };
        let bad: String = sb.into_iter().collect();
        assert_eq!(verify(&pk, &format!("{p}.{bad}"), &ch(), 2_000), Err(UnlockError::BadFormat));
        // length % 4 == 1
        assert_eq!(b64u_decode("AAAAA"), None);
        assert_eq!(b64u_decode("AA=="), None);
    }

    #[test]
    fn wrong_length_signature_is_bad_format() {
        let (sk, pk) = key();
        let payload = good_payload();
        let sig: Signature = sk.sign(&payload);
        let bytes = sig.to_bytes();
        for n in [0usize, 32, 63] {
            let t = format!("{}.{}", b64u_encode(&payload), b64u_encode(&bytes[..n]));
            assert_eq!(verify(&pk, &t, &ch(), 2_000), Err(UnlockError::BadFormat));
        }
        let mut long = bytes.to_vec();
        long.push(0);
        let t = format!("{}.{}", b64u_encode(&payload), b64u_encode(&long));
        assert_eq!(verify(&pk, &t, &ch(), 2_000), Err(UnlockError::BadFormat));
    }

    #[test]
    fn extra_or_missing_dots_are_bad_format() {
        let (sk, pk) = key();
        let t = sign_raw(&sk, &good_payload());
        for bad in [format!("{t}."), format!("{t}.AA"), t.replace('.', ""), String::new(), format!(".{t}")] {
            assert_eq!(verify(&pk, &bad, &ch(), 2_000), Err(UnlockError::BadFormat), "{bad}");
        }
    }

    #[test]
    fn bad_public_keys_are_bad_signature() {
        let (sk, pk) = key();
        let t = sign_raw(&sk, &good_payload());
        let raw = b64u_decode(&pk).unwrap();
        let compressed = b64u_encode(sk.verifying_key().to_encoded_point(true).as_bytes());
        let mut off_curve = raw.clone();
        off_curve[64] ^= 1;
        let cases = [
            String::new(),
            "AAAA".to_string(),
            b64u_encode(&raw[..64]),
            b64u_encode(&[raw.clone(), vec![0]].concat()),
            compressed,
            b64u_encode(&[0u8; 65]),
            b64u_encode(&off_curve),
            format!("{pk}="),
        ];
        for c in cases {
            assert_eq!(verify(&c, &t, &ch(), 2_000), Err(UnlockError::BadSignature), "{c}");
        }
    }

    #[test]
    fn signature_over_other_bytes_is_rejected() {
        let (sk, pk) = key();
        let t = sign_raw(&sk, &good_payload());
        let other = sign_raw(&sk, br#"{"n":"nn","w":"ww","exp":9999999}"#);
        let forged = format!("{}.{}", other.split_once('.').unwrap().0, t.split_once('.').unwrap().1);
        assert_eq!(verify(&pk, &forged, &ch(), 2_000), Err(UnlockError::BadSignature));
    }

    #[test]
    fn check_order_matches_js() {
        let (sk, pk) = key();
        let t = sign_raw(&sk, &good_payload());
        let mut c = ch();
        c.nonce = "other".into();
        c.window_id = "other".into();
        c.used = true;
        assert_eq!(verify(&pk, &t, &c, 99_999_999), Err(UnlockError::WrongChallenge));
        c.nonce = "nn".into();
        assert_eq!(verify(&pk, &t, &c, 99_999_999), Err(UnlockError::WrongLock));
        c.window_id = "ww".into();
        assert_eq!(verify(&pk, &t, &c, 99_999_999), Err(UnlockError::Used));
        c.used = false;
        assert_eq!(verify(&pk, &t, &c, 99_999_999), Err(UnlockError::ChallengeExpired));
        c.issued = 99_999_000;
        assert_eq!(verify(&pk, &t, &c, 99_999_999), Err(UnlockError::Expired));
    }

    #[test]
    fn challenge_code_matches_js_format() {
        let code = challenge_code("AAECAwQFBgcICQoLDA0ODw", "win-1");
        let bytes = b64u_decode(&code).unwrap();
        assert_eq!(bytes, br#"{"n":"AAECAwQFBgcICQoLDA0ODw","w":"win-1"}"#.to_vec());
    }
}
