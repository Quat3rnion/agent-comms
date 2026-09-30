//! Capabilities that the core server advertises.

use crate::module::Cx;

/// Names of the core capabilities. `draft/multiline` and `sasl` have values;
/// see `core_caps`.
pub const CORE_CAPS: &[&str] = &[
    "message-tags",
    "server-time",
    "account-tag",
    "away-notify",
    "echo-message",
    "batch",
    "labeled-response",
    "draft/multiline",
    "sasl",
    "cap-notify",
];

/// Value of the `draft/multiline` capability.
pub fn multiline_value(max_message_bytes: usize) -> String {
    format!("max-bytes={max_message_bytes},max-lines=200")
}

/// Core capabilities with their values.
pub fn core_caps(cx: &Cx<'_>) -> Vec<(String, Option<String>)> {
    CORE_CAPS
        .iter()
        .map(|&name| {
            let value = match name {
                "draft/multiline" => Some(multiline_value(cx.config().limits.max_message_bytes)),
                "sasl" => Some("PLAIN".to_string()),
                _ => None,
            };
            (name.to_string(), value)
        })
        .collect()
}

/// Core capabilities and the capabilities of all modules. The first
/// occurrence of a name wins.
pub fn all_caps(cx: &Cx<'_>) -> Vec<(String, Option<String>)> {
    let mut out = core_caps(cx);
    for module in &cx.state.modules {
        for spec in module.caps() {
            if !out.iter().any(|(n, _)| n == spec.name) {
                out.push((spec.name.to_string(), spec.value));
            }
        }
    }
    out
}

/// True when the server advertises a capability with this name.
pub fn is_known(cx: &Cx<'_>, name: &str) -> bool {
    all_caps(cx).iter().any(|(n, _)| n == name)
}
