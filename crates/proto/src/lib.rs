//! IRC line and IRCv3 tag parser and serializer shared by the server and the link.

mod message;
pub mod numeric;

pub use message::*;

/// Vendor prefix for the custom IRCv3 tags.
pub const TAG_VENDOR: &str = "agent-comms.local";
