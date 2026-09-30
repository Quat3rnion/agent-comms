//! TLS acceptor from PEM files.

use crate::config::TlsConfig;
use anyhow::Context;
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;
use tokio_rustls::rustls;

pub fn acceptor(cfg: &TlsConfig) -> anyhow::Result<tokio_rustls::TlsAcceptor> {
    let mut cert_reader = BufReader::new(
        File::open(&cfg.cert).with_context(|| format!("open {}", cfg.cert.display()))?,
    );
    let certs = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("read certificates from {}", cfg.cert.display()))?;
    if certs.is_empty() {
        anyhow::bail!("no certificates in {}", cfg.cert.display());
    }

    let mut key_reader = BufReader::new(
        File::open(&cfg.key).with_context(|| format!("open {}", cfg.key.display()))?,
    );
    let key = rustls_pemfile::private_key(&mut key_reader)
        .with_context(|| format!("read private key from {}", cfg.key.display()))?
        .with_context(|| format!("no private key in {}", cfg.key.display()))?;

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .context("TLS protocol versions")?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("TLS certificate and key")?;
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}
