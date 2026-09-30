//! Listener, accept loop, tick task, and shutdown.

use crate::config::{Config, Secrets};
use crate::conn::{run_client, LineConn};
use crate::module::Module;
use crate::state::{ServerState, SharedState};
use crate::user::Sink;
use anyhow::Context;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Modules that `run` registers, in hook order. Opens the SQLite store when a
/// module needs it.
pub fn default_modules(config: &Config) -> anyhow::Result<Vec<Arc<dyn Module>>> {
    use crate::modules::{
        authority::AuthorityModule, broadcast::BroadcastModule, history::HistoryModule,
    };
    use crate::store::Store;

    use crate::modules::{
        agent::AgentModule, claims::ClaimsModule, hub::LinkHub, link::LinkModule,
    };

    let m = &config.modules;
    let store = if m.history || m.link || m.claims {
        Some(Arc::new(Store::open(&config.db_path()).with_context(
            || format!("open database {}", config.db_path().display()),
        )?))
    } else {
        None
    };
    let hub = Arc::new(LinkHub::new(store.clone()));
    let mut out: Vec<Arc<dyn Module>> = Vec::new();
    if m.broadcast {
        out.push(Arc::new(BroadcastModule));
    }
    if m.authority {
        out.push(Arc::new(AuthorityModule));
    }
    if m.history {
        if let Some(store) = &store {
            out.push(Arc::new(HistoryModule::new(store.clone(), config)));
        }
    }
    if m.link {
        out.push(Arc::new(LinkModule::new(hub.clone(), config)));
    }
    if m.claims {
        let claims = ClaimsModule::new(hub.clone(), config);
        hub.register_extension(claims.clone());
        out.push(claims);
    }
    if m.agent {
        let agent = AgentModule::new(hub.clone(), config);
        hub.register_extension(agent.clone());
        out.push(agent);
    }
    Ok(out)
}

pub struct Running {
    pub local_addr: SocketAddr,
    state: SharedState,
    shutdown_tx: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl Running {
    pub fn state(&self) -> SharedState {
        self.state.clone()
    }

    /// Stop the accept loop and the tick task, and close all connections.
    pub async fn shutdown(self) -> anyhow::Result<()> {
        let _ = self.shutdown_tx.send(true);
        for task in self.tasks {
            let _ = task.await;
        }
        let w = self.state.world.lock();
        for u in w.users.values() {
            match &u.sink {
                Sink::Socket(o) => o.close_with("Server shutting down"),
                Sink::Virtual { link: Some(l), .. } => l.tx.close_with("Server shutting down"),
                Sink::Virtual { link: None, .. } => {}
            }
        }
        Ok(())
    }
}

pub async fn start(config: Config, secrets: Secrets) -> anyhow::Result<Running> {
    start_with(config, secrets, vec![]).await
}

pub async fn start_with(
    config: Config,
    secrets: Secrets,
    modules: Vec<Arc<dyn Module>>,
) -> anyhow::Result<Running> {
    config.validate().map_err(anyhow::Error::msg)?;
    let acceptor = match &config.tls {
        Some(tls) => Some(crate::tls::acceptor(tls)?),
        None => None,
    };
    let listener = TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("bind {}", config.bind))?;
    let local_addr = listener.local_addr()?;
    let state: SharedState = Arc::new(ServerState::new(config, secrets, modules));
    // One tick before the first connection, so that modules can restore
    // persisted state (for example dormant link accounts).
    {
        let now = SystemTime::now();
        for module in &state.modules {
            module.on_tick(&state, now);
        }
    }
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let accept_task = {
        let state = state.clone();
        let mut rx = shutdown_rx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = rx.changed() => break,
                    res = listener.accept() => {
                        let (stream, peer) = match res {
                            Ok(x) => x,
                            Err(e) => {
                                tracing::warn!("accept failed: {e}");
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                continue;
                            }
                        };
                        let _ = stream.set_nodelay(true);
                        let state = state.clone();
                        let acceptor = acceptor.clone();
                        tokio::spawn(async move {
                            let conn = match acceptor {
                                Some(acc) => {
                                    match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acc.accept(stream)).await {
                                        Ok(Ok(tls)) => LineConn::new(tls, peer, true),
                                        Ok(Err(e)) => {
                                            tracing::debug!("TLS handshake with {peer} failed: {e}");
                                            return;
                                        }
                                        Err(_) => return,
                                    }
                                }
                                None => LineConn::new(stream, peer, false),
                            };
                            run_client(state, conn).await;
                        });
                    }
                }
            }
        })
    };

    let tick_task = {
        let state = state.clone();
        let mut rx = shutdown_rx;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = rx.changed() => break,
                    _ = interval.tick() => {
                        let now = SystemTime::now();
                        for module in &state.modules {
                            module.on_tick(&state, now);
                        }
                    }
                }
            }
        })
    };

    tracing::info!("listening on {local_addr}");
    Ok(Running {
        local_addr,
        state,
        shutdown_tx,
        tasks: vec![accept_task, tick_task],
    })
}

/// Run the server with the default modules until `shutdown` completes.
pub async fn run(
    config: Config,
    secrets: Secrets,
    shutdown: impl Future<Output = ()> + Send,
) -> anyhow::Result<()> {
    let modules = default_modules(&config)?;
    let running = start_with(config, secrets, modules).await?;
    shutdown.await;
    running.shutdown().await
}
