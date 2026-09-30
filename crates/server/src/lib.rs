//! agent-comms IRC server: core and modules.

pub mod channel;
pub mod config;
pub mod conn;
pub mod flood;
pub mod handlers;
pub mod module;
pub mod ops;
pub mod server;
pub mod state;
pub mod store;
pub mod tls;
pub mod user;
pub mod util;

pub use conn::LineConn;
pub use module::{CapSpec, Cx, Flow, MessageEvent, Module, MsgTarget};
pub use server::{default_modules, run, start, start_with, Running};
pub use state::{ServerState, SharedState, World};
pub use user::{LinkHandle, Outbound, Role, Sink, User, UserId};
