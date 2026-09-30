//! IRC message type, parser, and serializer.

use crate::TAG_VENDOR;

/// Ordered list of message tags. A value of `None` means the tag has no value.
pub type Tags = Vec<(String, Option<String>)>;

/// Maximum number of parameters in one message.
const MAX_PARAMS: usize = 15;

/// One parsed IRC message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub tags: Tags,
    pub source: Option<String>,
    pub command: String,
    pub params: Vec<String>,
}

/// Size limits for a parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Maximum size of the body (without tags), including the 2 bytes of CRLF.
    pub body: usize,
    /// Maximum size of the tags section, including the leading `@`.
    pub tags: usize,
}

impl Limits {
    pub const CLIENT: Limits = Limits {
        body: 512,
        tags: 8191,
    };
    pub const LINK: Limits = Limits {
        body: 65536,
        tags: 8191,
    };
}

/// Errors that the parser can return.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("empty line")]
    Empty,
    #[error("tags section too long")]
    TagsTooLong,
    #[error("message body too long")]
    BodyTooLong,
    #[error("missing command")]
    MissingCommand,
    #[error("invalid command")]
    InvalidCommand,
    #[error("too many parameters")]
    TooManyParams,
    #[error("invalid tag")]
    InvalidTag,
    #[error("line contains CR, LF, or NUL")]
    ContainsNewline,
}

/// Build the name of a vendor tag, for example `agent-comms.local/hop`.
pub fn vendor_tag(name: &str) -> String {
    format!("{TAG_VENDOR}/{name}")
}

/// Escape a tag value for the wire.
pub fn escape_tag_value(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            ';' => out.push_str("\\:"),
            ' ' => out.push_str("\\s"),
            '\\' => out.push_str("\\\\"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

/// Unescape a tag value from the wire.
pub fn unescape_tag_value(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn valid_tag_key(key: &str) -> bool {
    let name = key.strip_prefix('+').unwrap_or(key);
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '/'))
}

fn valid_command(cmd: &str) -> bool {
    if cmd.is_empty() {
        return false;
    }
    if cmd.chars().all(|c| c.is_ascii_alphabetic()) {
        return true;
    }
    cmd.len() == 3 && cmd.chars().all(|c| c.is_ascii_digit())
}

fn parse_tags(section: &str) -> Result<Tags, ParseError> {
    let mut tags: Tags = Vec::new();
    for part in section.split(';') {
        let (key, raw) = match part.split_once('=') {
            Some((k, v)) => (k, Some(v)),
            None => (part, None),
        };
        if !valid_tag_key(key) {
            return Err(ParseError::InvalidTag);
        }
        let value = raw.map(unescape_tag_value).filter(|v| !v.is_empty());
        match tags.iter_mut().find(|(k, _)| k == key) {
            Some(existing) => existing.1 = value,
            None => tags.push((key.to_string(), value)),
        }
    }
    Ok(tags)
}

impl Message {
    pub fn new(command: impl Into<String>, params: Vec<String>) -> Self {
        Message {
            tags: Vec::new(),
            source: None,
            command: command.into(),
            params,
        }
    }

    /// Parse one line with the client limits.
    pub fn parse(line: &str) -> Result<Message, ParseError> {
        Self::parse_with(line, Limits::CLIENT)
    }

    /// Parse one line with explicit limits.
    pub fn parse_with(line: &str, limits: Limits) -> Result<Message, ParseError> {
        let line = line
            .strip_suffix("\r\n")
            .or_else(|| line.strip_suffix('\n'))
            .unwrap_or(line);
        if line.contains(['\r', '\n', '\0']) {
            return Err(ParseError::ContainsNewline);
        }
        if line.is_empty() {
            return Err(ParseError::Empty);
        }

        let mut rest = line;
        let mut tags = Tags::new();
        if rest.starts_with('@') {
            let end = rest.find(' ').unwrap_or(rest.len());
            let (section, after) = rest.split_at(end);
            if section.len() > limits.tags {
                return Err(ParseError::TagsTooLong);
            }
            tags = parse_tags(&section[1..])?;
            rest = after.trim_start_matches(' ');
        }

        if rest.len() + 2 > limits.body {
            return Err(ParseError::BodyTooLong);
        }

        let mut source = None;
        if let Some(after_colon) = rest.strip_prefix(':') {
            let end = after_colon.find(' ').unwrap_or(after_colon.len());
            let (src, after) = after_colon.split_at(end);
            if src.is_empty() {
                return Err(ParseError::MissingCommand);
            }
            source = Some(src.to_string());
            rest = after.trim_start_matches(' ');
        }

        if rest.is_empty() {
            return Err(ParseError::MissingCommand);
        }
        let end = rest.find(' ').unwrap_or(rest.len());
        let (command, mut remaining) = rest.split_at(end);
        if !valid_command(command) {
            return Err(ParseError::InvalidCommand);
        }

        let mut params: Vec<String> = Vec::new();
        loop {
            remaining = remaining.trim_start_matches(' ');
            if remaining.is_empty() {
                break;
            }
            if params.len() >= MAX_PARAMS {
                return Err(ParseError::TooManyParams);
            }
            if let Some(trailing) = remaining.strip_prefix(':') {
                params.push(trailing.to_string());
                break;
            }
            let end = remaining.find(' ').unwrap_or(remaining.len());
            params.push(remaining[..end].to_string());
            remaining = &remaining[end..];
        }

        Ok(Message {
            tags,
            source,
            command: command.to_string(),
            params,
        })
    }

    /// Serialize to the canonical wire form, without CRLF.
    pub fn to_line(&self) -> String {
        let mut out = String::new();
        if !self.tags.is_empty() {
            out.push('@');
            for (i, (key, value)) in self.tags.iter().enumerate() {
                if i > 0 {
                    out.push(';');
                }
                out.push_str(key);
                if let Some(v) = value.as_deref().filter(|v| !v.is_empty()) {
                    out.push('=');
                    out.push_str(&escape_tag_value(v));
                }
            }
            out.push(' ');
        }
        if let Some(source) = &self.source {
            out.push(':');
            out.push_str(source);
            out.push(' ');
        }
        out.push_str(&self.command);
        let last = self.params.len().wrapping_sub(1);
        for (i, param) in self.params.iter().enumerate() {
            out.push(' ');
            if i == last && (param.is_empty() || param.contains(' ') || param.starts_with(':')) {
                out.push(':');
            }
            out.push_str(param);
        }
        out
    }

    pub fn with_source(mut self, s: impl Into<String>) -> Self {
        self.source = Some(s.into());
        self
    }

    /// Set a tag. An existing key keeps its position and gets the new value.
    pub fn with_tag(mut self, key: impl Into<String>, value: Option<String>) -> Self {
        let key = key.into();
        self.set_tag(&key, value);
        self
    }

    pub fn set_tag(&mut self, key: &str, value: Option<String>) {
        match self.tags.iter_mut().find(|(k, _)| k == key) {
            Some(existing) => existing.1 = value,
            None => self.tags.push((key.to_string(), value)),
        }
    }

    pub fn remove_tag(&mut self, key: &str) {
        self.tags.retain(|(k, _)| k != key);
    }

    /// Value of a tag. A tag that is present without a value gives `Some("")`.
    pub fn tag(&self, key: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_deref().unwrap_or(""))
    }

    pub fn has_tag(&self, key: &str) -> bool {
        self.tags.iter().any(|(k, _)| k == key)
    }

    pub fn param(&self, i: usize) -> Option<&str> {
        self.params.get(i).map(String::as_str)
    }

    pub fn command_upper(&self) -> String {
        self.command.to_ascii_uppercase()
    }

    /// The part of the source before `!`.
    pub fn source_nick(&self) -> Option<&str> {
        self.source
            .as_deref()
            .map(|s| s.split('!').next().unwrap_or(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_of(len: usize) -> String {
        // "PING " is 5 bytes; the rest is one param.
        format!("PING {}", "a".repeat(len - 5))
    }

    #[test]
    fn parses_full_message() {
        let m = Message::parse("@a=b\\sc;+d :n!u@h PRIVMSG #c :hello world\r\n").unwrap();
        assert_eq!(m.tag("a"), Some("b c"));
        assert_eq!(m.tag("+d"), Some(""));
        assert!(m.has_tag("+d"));
        assert_eq!(m.source_nick(), Some("n"));
        assert_eq!(m.command, "PRIVMSG");
        assert_eq!(m.params, vec!["#c", "hello world"]);
    }

    #[test]
    fn err_empty() {
        assert_eq!(Message::parse(""), Err(ParseError::Empty));
        assert_eq!(Message::parse("\r\n"), Err(ParseError::Empty));
        assert_eq!(Message::parse("\n"), Err(ParseError::Empty));
    }

    #[test]
    fn err_tags_too_long() {
        let line = format!("@{} PING", "a".repeat(8191));
        assert_eq!(Message::parse(&line), Err(ParseError::TagsTooLong));
        let ok = format!("@{} PING", "a".repeat(8190));
        assert!(Message::parse(&ok).is_ok());
        let small = Limits { body: 512, tags: 5 };
        assert_eq!(
            Message::parse_with("@abcdef PING", small),
            Err(ParseError::TagsTooLong)
        );
    }

    #[test]
    fn err_body_too_long() {
        assert_eq!(Message::parse(&body_of(511)), Err(ParseError::BodyTooLong));
        assert!(Message::parse(&body_of(510)).is_ok());
        assert!(Message::parse_with(&body_of(511), Limits::LINK).is_ok());
    }

    #[test]
    fn body_limit_excludes_tags() {
        let line = format!("@a=b {}", body_of(510));
        assert!(Message::parse(&line).is_ok());
    }

    #[test]
    fn err_missing_command() {
        assert_eq!(Message::parse("@a=b"), Err(ParseError::MissingCommand));
        assert_eq!(Message::parse(":src"), Err(ParseError::MissingCommand));
        assert_eq!(Message::parse(":src   "), Err(ParseError::MissingCommand));
    }

    #[test]
    fn err_invalid_command() {
        assert_eq!(Message::parse("PING1"), Err(ParseError::InvalidCommand));
        assert_eq!(Message::parse("12"), Err(ParseError::InvalidCommand));
        assert_eq!(Message::parse("1234"), Err(ParseError::InvalidCommand));
        assert_eq!(Message::parse("PI-NG"), Err(ParseError::InvalidCommand));
        assert_eq!(Message::parse("001").unwrap().command, "001");
    }

    #[test]
    fn err_too_many_params() {
        let ok = format!("CMD {}", vec!["a"; 15].join(" "));
        assert_eq!(Message::parse(&ok).unwrap().params.len(), 15);
        let bad = format!("CMD {}", vec!["a"; 16].join(" "));
        assert_eq!(Message::parse(&bad), Err(ParseError::TooManyParams));
        let bad_trailing = format!("CMD {} :x", vec!["a"; 15].join(" "));
        assert_eq!(
            Message::parse(&bad_trailing),
            Err(ParseError::TooManyParams)
        );
    }

    #[test]
    fn err_invalid_tag() {
        assert_eq!(Message::parse("@=x PING"), Err(ParseError::InvalidTag));
        assert_eq!(Message::parse("@ PING"), Err(ParseError::InvalidTag));
        assert_eq!(Message::parse("@a;;b PING"), Err(ParseError::InvalidTag));
        assert_eq!(Message::parse("@+ PING"), Err(ParseError::InvalidTag));
        assert_eq!(Message::parse("@a_b=1 PING"), Err(ParseError::InvalidTag));
    }

    #[test]
    fn err_contains_newline() {
        assert_eq!(
            Message::parse("PING a\rb"),
            Err(ParseError::ContainsNewline)
        );
        assert_eq!(
            Message::parse("PING a\nb"),
            Err(ParseError::ContainsNewline)
        );
        assert_eq!(Message::parse("PING\0"), Err(ParseError::ContainsNewline));
        assert_eq!(
            Message::parse("PING a\r\n\r\n"),
            Err(ParseError::ContainsNewline)
        );
    }

    #[test]
    fn duplicate_tags_later_wins_first_position() {
        let m = Message::parse("@a=1;b=2;a=3 PING").unwrap();
        assert_eq!(
            m.tags,
            vec![
                ("a".to_string(), Some("3".to_string())),
                ("b".to_string(), Some("2".to_string())),
            ]
        );
    }

    #[test]
    fn empty_tag_value_is_none() {
        let m = Message::parse("@a= PING").unwrap();
        assert_eq!(m.tags, vec![("a".to_string(), None)]);
        assert_eq!(m.tag("a"), Some(""));
    }

    #[test]
    fn unescape_rules() {
        assert_eq!(
            unescape_tag_value("a\\:b\\sc\\\\d\\re\\nf"),
            "a;b c\\d\re\nf"
        );
        assert_eq!(unescape_tag_value("abc\\"), "abc");
        assert_eq!(unescape_tag_value("a\\xb"), "axb");
    }

    #[test]
    fn escape_roundtrip() {
        let v = "a;b c\\d\re\nf";
        assert_eq!(escape_tag_value(v), "a\\:b\\sc\\\\d\\re\\nf");
        assert_eq!(unescape_tag_value(&escape_tag_value(v)), v);
    }

    #[test]
    fn multiple_spaces_collapse() {
        let m = Message::parse("PRIVMSG   #c    :a  b").unwrap();
        assert_eq!(m.params, vec!["#c", "a  b"]);
    }

    #[test]
    fn command_case_preserved() {
        let m = Message::parse("privmsg #c :x").unwrap();
        assert_eq!(m.command, "privmsg");
        assert_eq!(m.command_upper(), "PRIVMSG");
    }

    #[test]
    fn serialize_trailing_rules() {
        let m = Message::new("PRIVMSG", vec!["#c".into(), "".into()]);
        assert_eq!(m.to_line(), "PRIVMSG #c :");
        let m = Message::new("PRIVMSG", vec!["#c".into(), ":)".into()]);
        assert_eq!(m.to_line(), "PRIVMSG #c ::)");
        let m = Message::new("JOIN", vec!["#lobby".into()]);
        assert_eq!(m.to_line(), "JOIN #lobby");
        let m = Message::new("QUIT", vec![]);
        assert_eq!(m.to_line(), "QUIT");
    }

    #[test]
    fn builders_and_accessors() {
        let mut m = Message::new("PING", vec!["x".into()])
            .with_source("srv")
            .with_tag("a", Some("1".into()))
            .with_tag("b", None)
            .with_tag("a", Some("2".into()));
        assert_eq!(m.to_line(), "@a=2;b :srv PING x");
        assert_eq!(m.param(0), Some("x"));
        assert_eq!(m.param(1), None);
        m.remove_tag("a");
        assert!(!m.has_tag("a"));
        m.set_tag("c", Some("v".into()));
        assert_eq!(m.tag("c"), Some("v"));
        assert_eq!(m.source_nick(), Some("srv"));
    }

    #[test]
    fn vendor_tag_name() {
        assert_eq!(vendor_tag("hop"), "agent-comms.local/hop");
    }
}
