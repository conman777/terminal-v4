use sha2::{Digest, Sha256};

pub(crate) struct Credentials<'a> {
    pub(crate) access_key: &'a str,
    pub(crate) secret_key: &'a str,
    pub(crate) session_token: Option<&'a str>,
}

pub(crate) struct Request<'a> {
    pub(crate) method: &'a str,
    pub(crate) host: &'a str,
    pub(crate) path: &'a str,
    pub(crate) query: &'a str,
    pub(crate) headers: &'a [(&'a str, &'a str)],
    pub(crate) body: &'a [u8],
}

pub(crate) struct Signed {
    pub(crate) authorization: String,
    pub(crate) amz_date: String,
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(data);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

pub(crate) fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> [u8; 32] {
    let date_key = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let region_key = hmac(&date_key, region.as_bytes());
    let service_key = hmac(&region_key, service.as_bytes());
    hmac(&service_key, b"aws4_request")
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn canonical_uri(path: &str) -> String {
    if path.is_empty() {
        return "/".into();
    }
    path.split('/').map(encode).collect::<Vec<_>>().join("/")
}

pub(crate) fn amz_date(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let rest = unix_seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

pub(crate) fn sign(
    request: &Request<'_>,
    credentials: &Credentials<'_>,
    region: &str,
    service: &str,
    unix_seconds: u64,
) -> Signed {
    let amz_date = amz_date(unix_seconds);
    let date = &amz_date[..8];
    let mut headers: Vec<(String, String)> = vec![
        ("host".into(), request.host.into()),
        ("x-amz-date".into(), amz_date.clone()),
    ];
    if let Some(token) = credentials.session_token {
        headers.push(("x-amz-security-token".into(), token.into()));
    }
    for (name, value) in request.headers {
        headers.push((name.to_ascii_lowercase(), (*value).into()));
    }
    for (_, value) in &mut headers {
        *value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    headers.sort();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        request.method,
        canonical_uri(request.path),
        request.query,
        canonical_headers,
        signed_headers,
        sha256_hex(request.body)
    );
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let key = signing_key(credentials.secret_key, date, region, service);
    let signature = hex::encode(hmac(&key, string_to_sign.as_bytes()));
    Signed {
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            credentials.access_key
        ),
        amz_date,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const SUITE_TIME: u64 = 1_440_938_160;

    fn suite_credentials() -> Credentials<'static> {
        Credentials {
            access_key: "AKIDEXAMPLE",
            secret_key: SECRET,
            session_token: None,
        }
    }

    fn suite_signature(method: &str) -> String {
        sign(
            &Request {
                method,
                host: "example.amazonaws.com",
                path: "/",
                query: "",
                headers: &[],
                body: b"",
            },
            &suite_credentials(),
            "us-east-1",
            "service",
            SUITE_TIME,
        )
        .authorization
    }

    #[test]
    fn aws_documented_signing_key_example() {
        assert_eq!(
            hex::encode(signing_key(SECRET, "20150830", "us-east-1", "iam")),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    #[test]
    fn aws_sigv4_suite_get_vanilla() {
        assert_eq!(
            suite_signature("GET"),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn aws_sigv4_suite_post_vanilla() {
        assert_eq!(
            suite_signature("POST"),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
        );
    }

    #[test]
    fn hmac_matches_rfc4231_case_2_and_long_key_case_6() {
        assert_eq!(
            hex::encode(hmac(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex::encode(hmac(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn session_token_and_extra_headers_are_signed_and_values_normalised() {
        let credentials = Credentials {
            session_token: Some("tok"),
            ..suite_credentials()
        };
        let signed = sign(
            &Request {
                method: "POST",
                host: "h.example.com",
                path: "/model/a%3Ab/converse",
                query: "",
                headers: &[("Content-Type", "  application/json ")],
                body: b"{}",
            },
            &credentials,
            "us-east-1",
            "bedrock",
            SUITE_TIME,
        );
        assert!(signed.authorization.contains(
            "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature="
        ));
        assert_eq!(signed.amz_date, "20150830T123600Z");
    }

    #[test]
    fn canonical_uri_double_encodes_percent_sequences_and_defaults_to_root() {
        assert_eq!(
            canonical_uri("/model/anthropic.claude-v2%3A1/converse"),
            "/model/anthropic.claude-v2%253A1/converse"
        );
        assert_eq!(canonical_uri(""), "/");
    }

    #[test]
    fn amz_date_formats_known_instants_including_leap_day() {
        for (seconds, expected) in [
            (0, "19700101T000000Z"),
            (SUITE_TIME, "20150830T123600Z"),
            (1_709_210_096, "20240229T123456Z"),
            (4_102_444_799, "20991231T235959Z"),
        ] {
            assert_eq!(amz_date(seconds), expected);
        }
    }
}
