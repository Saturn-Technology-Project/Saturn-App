//! Connections that only reach the public internet.
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use saturn_domain::skills::public_address::is_private_host;
use saturn_telemetry::network::{SendNoted, client_builder};
use url::Url;

const NOT_ALLOWED: &str = "That address is not allowed";

/// What a name lookup returns.
pub type LookupFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;

/// Looks up the addresses of a name.
pub trait Lookup: Send + Sync {
    /// Every address the name has.
    fn lookup<'a>(&'a self, host: &'a str) -> LookupFuture<'a>;
}

/// The computer's own name lookup.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup<'a>(&'a self, host: &'a str) -> LookupFuture<'a> {
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host, 0)).await?;
            Ok(addresses.map(|address| address.ip()).collect())
        })
    }
}

/// A connection refused because of where it would go; its message is the one the tool returns.
#[derive(Debug)]
struct Refused(String);

impl fmt::Display for Refused {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Refused {}

/// The addresses of a host, refused when any of them is loopback, link-local or private. The name check alone lets a
/// public domain that resolves to 127.0.0.1 or 192.168.x.x through; this looks up every address the name has and checks
/// each one.
async fn public_addresses(hostname: &str, lookup: &dyn Lookup) -> Result<Vec<IpAddr>, String> {
    let host = hostname.trim_start_matches('[').trim_end_matches(']');
    if is_private_host(host) {
        return Err(NOT_ALLOWED.to_owned());
    }
    let addresses = lookup
        .lookup(host)
        .await
        .map_err(|_| format!("Could not resolve {host}"))?;
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| is_private_host(&address.to_string()))
    {
        return Err(NOT_ALLOWED.to_owned());
    }
    Ok(addresses)
}

/// Refuses a URL whose host resolves to a private address, for a program that will make the connection itself.
pub async fn assert_public_host(url: &Url, lookup: &dyn Lookup) -> Result<(), String> {
    public_addresses(url.host_str().unwrap_or_default(), lookup)
        .await
        .map(|_| ())
}

/// A connection's name lookup that only answers with public addresses.
struct PublicResolver {
    lookup: Arc<dyn Lookup>,
}

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let lookup = Arc::clone(&self.lookup);
        Box::pin(async move {
            let addresses = public_addresses(name.as_str(), lookup.as_ref())
                .await
                .map_err(|message| Box::new(Refused(message)) as Box<dyn Error + Send + Sync>)?;
            let sockets: Addrs = Box::new(
                addresses
                    .into_iter()
                    .map(|address| SocketAddr::new(address, 0))
                    .collect::<Vec<_>>()
                    .into_iter(),
            );
            Ok(sockets)
        })
    }
}

/// Fetches a public URL with no redirects followed. The check happens in the connection's own lookup, so the address that
/// was checked is the one connected to: a name cannot answer with a public address for a check and then a private one for
/// the connection (DNS rebinding).
pub async fn fetch_public(
    url: &Url,
    headers: &[(&str, &str)],
    lookup: Arc<dyn Lookup>,
) -> Result<reqwest::Response, String> {
    // An address needs no lookup, so nothing above would see it.
    if is_private_host(url.host_str().unwrap_or_default()) {
        return Err(NOT_ALLOWED.to_owned());
    }
    request_through(url, headers, Arc::new(PublicResolver { lookup })).await
}

/// One GET over a connection that resolves its host with `resolver`.
pub async fn request_through<R: Resolve + 'static>(
    url: &Url,
    headers: &[(&str, &str)],
    resolver: Arc<R>,
) -> Result<reqwest::Response, String> {
    let client = client_builder()
        .redirect(Policy::none())
        .no_proxy()
        // Its own connection: a kept one would skip the lookup.
        .pool_max_idle_per_host(0)
        .dns_resolver(resolver)
        .build()
        .map_err(|error| error.without_url().to_string())?;
    let mut request = client.get(url.clone());
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.send_noted().await.map_err(|error| reason(&error))
}

/// What went wrong with a request: the refusal when there was one, deep inside the connection's error.
fn reason(error: &reqwest::Error) -> String {
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    let mut deepest = String::new();
    while let Some(current) = source {
        if let Some(refused) = current.downcast_ref::<Refused>() {
            return refused.0.clone();
        }
        deepest = current.to_string();
        source = current.source();
    }
    deepest
}
