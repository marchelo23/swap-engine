pub mod adapter;
mod blockchain;
mod offboard;
mod transfer;
mod wallet_store;

use ark_bdk_wallet::Wallet;
use ark_client::{
    BoltzReferralId, Client, InMemorySwapStorage, OfflineClient, OfflineClientConfig,
};
use ark_core::server::Info;
use bitcoin::{address::NetworkUnchecked, Address, Network, OutPoint, Txid};
use blockchain::{esplora_url, RegtestBlockchain};
use serde_json::{json, Value};
use std::{future::Future, net::Ipv4Addr, path::Path, sync::Arc, time::Duration};
use wallet_store::WalletStore;

const OPERATOR: &str = "http://127.0.0.1:37070";
const DOCKER_OPERATOR: &str = "http://arkd:7070";
const TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const ROUND_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error)]
pub enum LabError {
    #[error("ArkOperatorUnavailable: could not query the local Arkade operator")]
    OperatorUnavailable,
    #[error("ArkNetworkMismatch: expected Bitcoin regtest")]
    NetworkMismatch,
    #[error("ArkUnsupportedAsset: this lab only reports BTC")]
    UnsupportedAsset,
    #[error(
        "ArkWalletStorage: initialize with init-wallets and check wallet files and permissions"
    )]
    WalletStorage,
    #[error("ArkWalletBusy: another process holds the wallet lock")]
    WalletBusy,
    #[error("ArkSdkOperationFailed: {0}")]
    Sdk(&'static str),
    #[error("ArkSubmissionUncertain: reconcile the original input; do not repeat funding or submit a replacement")]
    SubmissionUncertain,
    #[error("ArkInputNotSpendable: missing, consumed, or stale VTXO")]
    InputNotSpendable,
    #[error("ArkInvalidAmount: amount or change outside supported range or insufficient input")]
    InvalidAmount,
    #[error("ArkIndexerUnavailable: local regtest Esplora did not validate")]
    IndexerUnavailable,
}

type Result<T> = std::result::Result<T, LabError>;
type SdkClient = Client<RegtestBlockchain, Wallet, InMemorySwapStorage>;

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum WalletId {
    Alice,
    Bob,
}

impl WalletId {
    fn name(self) -> &'static str {
        match self {
            Self::Alice => "alice",
            Self::Bob => "bob",
        }
    }
}

pub enum Action {
    Initialize,
    Addresses,
    Balance,
    ListVtxos,
    Restore,
    Board(OutPoint),
    TransferSubmit(OutPoint, u64),
    Pending,
    TransferFinalize(Txid),
    VerifySpent(OutPoint),
    SettleVtxo(OutPoint),
    Offboard(OutPoint, Address<NetworkUnchecked>, u64),
}

fn operator_url_for(mode: Option<&str>) -> Result<&'static str> {
    match mode {
        None | Some("loopback") => Ok(OPERATOR),
        Some("docker") => Ok(DOCKER_OPERATOR),
        Some(_) => Err(LabError::NetworkMismatch),
    }
}

fn operator_url() -> Result<&'static str> {
    match std::env::var("ARK_LAB_NETWORK_MODE") {
        Ok(mode) => operator_url_for(Some(mode.as_str())),
        Err(std::env::VarError::NotPresent) => operator_url_for(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(LabError::NetworkMismatch),
    }
}

pub(crate) async fn bounded_submission<T, E>(
    deadline: Duration,
    submission: impl Future<Output = std::result::Result<T, E>>,
) -> Result<T> {
    tokio::time::timeout(deadline, submission)
        .await
        .map_err(|_| LabError::SubmissionUncertain)?
        .map_err(|_| LabError::SubmissionUncertain)
}

fn regtest(info: &Info) -> Result<()> {
    if info.network != Network::Regtest
        || !info
            .forfeit_address
            .as_unchecked()
            .is_valid_for_network(Network::Regtest)
    {
        return Err(LabError::NetworkMismatch);
    }
    Ok(())
}

async fn operator_info(port: u16) -> Result<Info> {
    tokio::time::timeout(TIMEOUT, query_operator_info(port))
        .await
        .map_err(|_| LabError::OperatorUnavailable)?
}

async fn query_operator_info(port: u16) -> Result<Info> {
    let url = if port == 37070 {
        operator_url()?.to_string()
    } else {
        format!("http://{}:{port}", Ipv4Addr::LOCALHOST)
    };
    let mut probe = ark_grpc::Client::new(url);
    let info = async {
        probe.connect().await?;
        probe.get_info().await
    }
    .await
    .map_err(|_| LabError::OperatorUnavailable)?;
    regtest(&info)?;
    Ok(info)
}

async fn connect(store: &WalletStore, create: bool) -> Result<SdkClient> {
    let identity = store.identity(create)?;
    let operator = operator_url()?;
    let esplora = esplora_url().map_err(|_| LabError::NetworkMismatch)?;
    let config = OfflineClientConfig {
        ark_server_url: operator.into(),
        // No swap commands; do not inherit an upstream mainnet default.
        boltz_url: String::new(),
        boltz_referral_id: BoltzReferralId::Disabled,
        // Round events can be more than one session tick apart.
        timeout: Duration::from_secs(30),
        server_info_ttl: Duration::MAX,
        delegator_pk: None,
        historical_delegator_pks: vec![],
    };
    let blockchain =
        RegtestBlockchain::new().map_err(|_| LabError::Sdk("indexer configuration"))?;
    let wallet = Wallet::new_from_xpriv(identity, Network::Regtest, esplora)
        .map_err(|_| LabError::Sdk("on-chain wallet configuration"))?;
    let client = OfflineClient::with_bip32(
        config,
        identity,
        None,
        Arc::new(blockchain),
        Arc::new(wallet),
        Arc::new(InMemorySwapStorage::default()),
    )
    .with_contract_store(Box::new(store.contracts()?))
    .connect()
    .await
    .map_err(|_| LabError::OperatorUnavailable)?;
    regtest(
        &client
            .server_info()
            .await
            .map_err(|_| LabError::OperatorUnavailable)?,
    )?;
    Ok(client)
}

async fn addresses(client: &SdkClient) -> Result<Value> {
    let info = client
        .server_info()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let expected_signer = info.signer_pk.x_only_public_key().0;
    let raw_ark = client
        .get_offchain_addresses()
        .await
        .map_err(|_| LabError::Sdk("Ark addresses"))?;
    if raw_ark.is_empty()
        || !raw_ark
            .iter()
            .all(|(address, _)| address.server() == expected_signer)
    {
        return Err(LabError::NetworkMismatch);
    }
    let mut ark = raw_ark
        .into_iter()
        .map(|(address, _)| address.to_string())
        .collect::<Vec<_>>();
    let mut boarding = client
        .get_boarding_addresses()
        .await
        .map_err(|_| LabError::Sdk("boarding addresses"))?
        .into_iter()
        .map(|address| address.to_string())
        .collect::<Vec<_>>();
    let bitcoin = client
        .get_onchain_address()
        .map_err(|_| LabError::Sdk("on-chain address"))?
        .to_string();
    if boarding.is_empty()
        || !bitcoin.starts_with("bcrt1p")
        || !ark.iter().all(|address| address.starts_with("tark1"))
        || !boarding.iter().all(|address| address.starts_with("bcrt1p"))
    {
        return Err(LabError::NetworkMismatch);
    }
    ark.sort_unstable();
    ark.dedup();
    boarding.sort_unstable();
    boarding.dedup();
    Ok(json!({"ark":ark, "boarding":boarding, "onchain":bitcoin}))
}

async fn balance(client: &SdkClient) -> Result<Value> {
    let b = client
        .offchain_balance()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    if !b.asset_balances().is_empty() {
        return Err(LabError::UnsupportedAsset);
    }
    Ok(json!({
        "confirmed_sats": b.confirmed().to_sat(),
        "pre_confirmed_sats": b.pre_confirmed().to_sat(),
        "recoverable_sats": b.recoverable().to_sat(),
        "pending_recovery_sats": b.pending_recovery().to_sat(),
        "total_sats": b.total().to_sat()
    }))
}

async fn vtxos(client: &SdkClient) -> Result<Value> {
    let list = client
        .list_vtxos()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let mut rows = Vec::new();
    for item in list.all() {
        let v = item.vtxo();
        if !v.assets.is_empty() {
            return Err(LabError::UnsupportedAsset);
        }
        let id = v.outpoint.to_string();
        rows.push((
            id.clone(),
            json!({
                "outpoint": id,
                "amount_sats": v.amount.to_sat(),
                "origin": if v.is_preconfirmed { "ark_transfer" } else { "batch_leaf" },
                "commitment_txids": v.commitment_txids,
                "is_spent": v.is_spent,
                "is_unrolled": v.is_unrolled,
                "is_swept": v.is_swept,
                "is_expired": v.is_expired(),
                "created_at": v.created_at,
                "expires_at": v.expires_at,
                "spent_by": v.spent_by,
                "ark_txid": v.ark_txid,
                "settled_by": v.settled_by
            }),
        ));
    }
    rows.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    Ok(Value::Array(
        rows.into_iter().map(|(_, value)| value).collect(),
    ))
}

pub async fn run(repo: &Path, action: Action, wallets: &[WalletId]) -> Result<Value> {
    // Check the operator before generating, deriving, or opening local wallet files.
    operator_info(37070).await?;
    let mut result = serde_json::Map::new();
    for &id in wallets {
        let create = matches!(action, Action::Initialize);
        let store = WalletStore::open(repo, id.name(), create)?;
        let client = connect(&store, create).await?;
        let data = match &action {
            Action::Initialize | Action::Addresses => addresses(&client).await?,
            Action::Balance => balance(&client).await?,
            Action::ListVtxos => vtxos(&client).await?,
            Action::Board(input) | Action::SettleVtxo(input) => {
                let mut rng = bitcoin::secp256k1::rand::thread_rng();
                let (vtxos, boarding) = if matches!(action, Action::Board(_)) {
                    (&[][..], std::slice::from_ref(input))
                } else {
                    (std::slice::from_ref(input), &[][..])
                };
                let commitment = bounded_submission(
                    ROUND_DEADLINE,
                    client.settle_vtxos(&mut rng, vtxos, boarding),
                )
                .await?;
                json!({"input": input.to_string(), "commitment_txid": commitment})
            }
            Action::TransferSubmit(input, sats) => {
                let bob_store = WalletStore::open(repo, WalletId::Bob.name(), false)?;
                let bob = connect(&bob_store, false).await?;
                transfer::submit(&client, &bob, *input, *sats).await?
            }
            Action::VerifySpent(input) => transfer::verify_spent(&client, *input).await?,
            Action::Pending => transfer::pending(&client).await?,
            Action::TransferFinalize(txid) => transfer::finalize(&client, *txid).await?,
            Action::Offboard(input, address, sats) => {
                offboard::cooperative(&client, *input, address.clone(), *sats).await?
            }
            Action::Restore => {
                let report = client
                    .restore_contracts(ark_client::DEFAULT_GAP_LIMIT)
                    .await
                    .map_err(|_| {
                        LabError::Sdk("contract restoration requires operator and Esplora")
                    })?;
                json!({"entries_found": report.entries.len(), "addresses": addresses(&client).await?})
            }
        };
        result.insert(id.name().to_string(), data);
    }
    Ok(json!({"network":"regtest","asset":"BTC","wallets":result}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unreachable_operator_returns_sanitized_error() {
        // Reserve an ephemeral local TCP port without listening. No mock server.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind((Ipv4Addr::LOCALHOST, 0).into()).unwrap();
        let error = operator_info(socket.local_addr().unwrap().port())
            .await
            .unwrap_err();
        assert!(matches!(error, LabError::OperatorUnavailable));
        assert_eq!(
            error.to_string(),
            "ArkOperatorUnavailable: could not query the local Arkade operator"
        );
    }

    #[tokio::test]
    async fn bounded_submission_timeout_is_uncertain() {
        let error = bounded_submission(
            Duration::ZERO,
            std::future::pending::<std::result::Result<(), ()>>(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, LabError::SubmissionUncertain));
    }

    #[test]
    fn operator_endpoint_allowlists_loopback_and_docker_only() {
        assert_eq!(operator_url_for(None).unwrap(), OPERATOR);
        assert_eq!(operator_url_for(Some("loopback")).unwrap(), OPERATOR);
        assert_eq!(operator_url_for(Some("docker")).unwrap(), DOCKER_OPERATOR);
        for bad in ["", "mainnet", "https://arkade.example", "DOCKER"] {
            assert!(matches!(
                operator_url_for(Some(bad)),
                Err(LabError::NetworkMismatch)
            ));
        }
    }
}
