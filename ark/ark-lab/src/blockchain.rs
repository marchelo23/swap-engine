use ark_client::{Blockchain, Error, SpendStatus, TxStatus};
use ark_core::ExplorerUtxo;
use bitcoin::{Address, Amount, Network, OutPoint, Transaction, Txid};
use serde::Deserialize;
use std::time::Duration;

pub const ESPLORA: &str = "http://127.0.0.1:33000/api";
pub const DOCKER_ESPLORA: &str = "http://mempool_api:8999/api";
const GENESIS: &str = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";

pub fn esplora_url_for(mode: Option<&str>) -> Result<&'static str, Error> {
    match mode {
        None | Some("loopback") => Ok(ESPLORA),
        Some("docker") => Ok(DOCKER_ESPLORA),
        Some(_) => Err(network_mismatch()),
    }
}

pub fn esplora_url() -> Result<&'static str, Error> {
    match std::env::var("ARK_LAB_NETWORK_MODE") {
        Ok(mode) => esplora_url_for(Some(mode.as_str())),
        Err(std::env::VarError::NotPresent) => esplora_url_for(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(network_mismatch()),
    }
}

pub struct RegtestBlockchain {
    http: reqwest::Client,
    esplora: &'static str,
}

impl RegtestBlockchain {
    pub fn new() -> Result<Self, Error> {
        let esplora = esplora_url()?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self { http, esplora })
    }

    async fn get(&self, path: &str) -> Result<reqwest::Response, Error> {
        self.http
            .get(format!("{}{path}", self.esplora))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| unavailable())
    }

    pub async fn require_regtest(&self) -> Result<(), Error> {
        let genesis = self
            .get("/block-height/0")
            .await?
            .text()
            .await
            .map_err(|_| unavailable())?;
        if genesis.trim() != GENESIS {
            return Err(network_mismatch());
        }
        Ok(())
    }
}

fn network_mismatch() -> Error {
    Error::consumer(std::io::Error::other("RegtestNetworkMismatch"))
}

fn unavailable() -> Error {
    Error::consumer(std::io::Error::other("RegtestIndexerUnavailable"))
}

fn unsupported() -> Error {
    Error::consumer(std::io::Error::other(
        "On-chain broadcasting and unilateral exit are not implemented in this lab",
    ))
}

#[derive(Deserialize)]
struct Utxo {
    txid: Txid,
    vout: u32,
    value: u64,
    status: Status,
}

#[derive(Deserialize)]
struct Status {
    confirmed: bool,
    block_height: Option<u64>,
    block_time: Option<u64>,
}

impl Blockchain for RegtestBlockchain {
    async fn find_outpoints(&self, address: &Address) -> Result<Vec<ExplorerUtxo>, Error> {
        if !address
            .as_unchecked()
            .is_valid_for_network(Network::Regtest)
        {
            return Err(network_mismatch());
        }
        self.require_regtest().await?;
        let tip: u64 = self
            .get("/blocks/tip/height")
            .await?
            .text()
            .await
            .map_err(|_| unavailable())?
            .trim()
            .parse()
            .map_err(|_| unavailable())?;
        let entries: Vec<Utxo> = self
            .get(&format!("/address/{address}/utxo"))
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        entries
            .into_iter()
            .map(|entry| {
                let confirmations = if entry.status.confirmed {
                    tip.checked_sub(entry.status.block_height.ok_or_else(unavailable)?)
                        .and_then(|n| n.checked_add(1))
                        .ok_or_else(unavailable)?
                } else {
                    0
                };
                Ok(ExplorerUtxo {
                    outpoint: OutPoint::new(entry.txid, entry.vout),
                    amount: Amount::from_sat(entry.value),
                    confirmation_blocktime: entry.status.block_time,
                    confirmations,
                    is_spent: false,
                })
            })
            .collect()
    }

    async fn find_tx(&self, _: &Txid) -> Result<Option<Transaction>, Error> {
        Err(unsupported())
    }
    async fn get_tx_status(&self, _: &Txid) -> Result<TxStatus, Error> {
        Err(unsupported())
    }
    async fn get_output_status(&self, _: &Txid, _: u32) -> Result<SpendStatus, Error> {
        Err(unsupported())
    }
    async fn broadcast(&self, _: &Transaction) -> Result<(), Error> {
        Err(unsupported())
    }
    async fn get_fee_rate(&self) -> Result<f64, Error> {
        Err(unsupported())
    }
    async fn broadcast_package(&self, _: &[&Transaction]) -> Result<(), Error> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn esplora_endpoint_allowlists_loopback_and_docker_only() {
        assert_eq!(esplora_url_for(None).unwrap(), ESPLORA);
        assert_eq!(esplora_url_for(Some("loopback")).unwrap(), ESPLORA);
        assert_eq!(esplora_url_for(Some("docker")).unwrap(), DOCKER_ESPLORA);
        for bad in ["", "mainnet", "http://mempool.space/api", "DOCKER"] {
            assert!(esplora_url_for(Some(bad)).is_err());
        }
    }
}
