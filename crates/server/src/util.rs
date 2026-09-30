//! Small helpers: casefolding, name validation, and time.

use std::time::{SystemTime, UNIX_EPOCH};

/// RFC 1459 casefold.
pub fn fold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '[' => '{',
            ']' => '}',
            '\\' => '|',
            '~' => '^',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

pub fn valid_nick(s: &str, max: usize) -> bool {
    let len = s.chars().count();
    if len == 0 || len > max {
        return false;
    }
    let first = s.chars().next().unwrap_or('0');
    if first.is_ascii_digit() || first == '-' {
        return false;
    }
    s.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                '_' | '-' | '[' | ']' | '\\' | '`' | '^' | '{' | '}' | '|'
            )
    })
}

pub fn valid_channel(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('#') else {
        return false;
    };
    let len = rest.chars().count();
    (1..=127).contains(&len)
        && !rest
            .chars()
            .any(|c| matches!(c, ' ' | ',' | '\x07' | '\r' | '\n' | '\0'))
}

/// Format Unix milliseconds as `YYYY-MM-DDThh:mm:ss.sssZ` (UTC).
pub fn format_time_ms(ms: i64) -> String {
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()
        .and_then(|t| t.format(&fmt).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

pub fn new_msgid() -> String {
    ulid::Ulid::new().to_string()
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding() {
        assert_eq!(fold("Nick[A]\\~"), "nick{a}|^");
    }

    #[test]
    fn nicks() {
        assert!(valid_nick("alice", 9));
        assert!(valid_nick("[bot]`^", 9));
        assert!(!valid_nick("1abc", 9));
        assert!(!valid_nick("-abc", 9));
        assert!(!valid_nick("", 9));
        assert!(!valid_nick("abcdefghij", 9));
        assert!(!valid_nick("a b", 9));
    }

    #[test]
    fn channels() {
        assert!(valid_channel("#lobby"));
        assert!(!valid_channel("#"));
        assert!(!valid_channel("lobby"));
        assert!(!valid_channel("#a,b"));
        assert!(!valid_channel(&format!("#{}", "a".repeat(128))));
    }

    #[test]
    fn time_format() {
        assert_eq!(format_time_ms(1_234), "1970-01-01T00:00:01.234Z");
    }
}
