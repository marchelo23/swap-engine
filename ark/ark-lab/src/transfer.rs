use crate::{bounded_submission, LabError, Result, SdkClient};
use ark_core::{contract::SpendPathKind, send::VtxoInput};
use bitcoin::{Amount, OutPoint, Txid};
use serde_json::{json, Value};
use std::time::Duration;

const TRANSFER_DEADLINE: Duration = Duration::from_secs(30);

fn checked_ark_address(
    address: &ark_core::ArkAddress,
    expected_signer: bitcoin::XOnlyPublicKey,
) -> Result<()> {
    if address.server() != expected_signer || !address.encode().starts_with("tark1") {
        return Err(LabError::NetworkMismatch);
    }
    Ok(())
}

pub(crate) async fn submit(
    alice: &SdkClient,
    bob: &SdkClient,
    input: OutPoint,
    sats: u64,
) -> Result<Value> {
    let pending = alice
        .list_pending_offchain_txs()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    if !pending.is_empty() {
        return Err(LabError::SubmissionUncertain);
    }
    let info = alice
        .server_info()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let list = alice
        .list_vtxos()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let entry = list
        .spendable_offchain()
        .find(|entry| entry.vtxo().outpoint == input)
        .ok_or(LabError::InputNotSpendable)?;
    if !entry.vtxo().assets.is_empty() {
        return Err(LabError::UnsupportedAsset);
    }
    let amount = Amount::from_sat(sats);
    let minimum = info.dust.max(info.vtxo_min_amount.unwrap_or_default());
    let change = entry.vtxo().amount.checked_sub(amount);
    if amount < minimum
        || info.vtxo_max_amount.is_some_and(|max| amount > max)
        || change.is_none_or(|value| value != Amount::ZERO && value < minimum)
    {
        return Err(LabError::InvalidAmount);
    }
    let selection = entry
        .spend_selection(SpendPathKind::Forfeit)
        .map_err(|_| LabError::InputNotSpendable)?;
    let bob_info = bob
        .server_info()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    if bob_info.signer_pk != info.signer_pk {
        return Err(LabError::NetworkMismatch);
    }
    let (address, _) = bob
        .get_offchain_address()
        .await
        .map_err(|_| LabError::Sdk("Bob Ark address"))?;
    checked_ark_address(&address, info.signer_pk.x_only_public_key().0)?;
    let txid = bounded_submission(
        TRANSFER_DEADLINE,
        alice.submit_offchain_tx(
            vec![VtxoInput::new_with_spend_selection(
                selection,
                entry.tapscripts(),
                entry.script_pubkey(),
                entry.vtxo().amount,
                input,
                vec![],
            )],
            address,
            amount,
        ),
    )
    .await?;
    Ok(
        json!({"ark_txid":txid,"input":input.to_string(),"amount_sats":sats,
              "recipient":address.to_string(),"state":"submitted_not_finalized"}),
    )
}

pub(crate) async fn pending(client: &SdkClient) -> Result<Value> {
    let transactions = client
        .list_pending_offchain_txs()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let ids: Vec<_> = transactions.iter().map(|tx| tx.ark_txid).collect();
    Ok(json!({"pending_ark_txids":ids}))
}

pub(crate) async fn finalize(client: &SdkClient, txid: Txid) -> Result<Value> {
    let transactions = client
        .list_pending_offchain_txs()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let is_pending = transactions.iter().any(|tx| tx.ark_txid == txid);
    if is_pending {
        bounded_submission(TRANSFER_DEADLINE, client.finalize_pending_offchain_tx(txid)).await?;
    }
    Ok(json!({"ark_txid":txid,"finalize_attempted":is_pending}))
}

// Check the indexed state without invoking any send API or probing with a replay.
pub(crate) async fn verify_spent(alice: &SdkClient, input: OutPoint) -> Result<Value> {
    let list = alice
        .list_vtxos()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let mut matches = list.all().filter(|entry| entry.vtxo().outpoint == input);
    if !matches.next().is_some_and(|entry| entry.vtxo().is_spent)
        || matches.next().is_some()
        || list
            .spendable_offchain()
            .any(|entry| entry.vtxo().outpoint == input)
    {
        return Err(LabError::Sdk("expected already-consumed replay input"));
    }
    Ok(json!({"input":input.to_string(),"spent":true,"spendable":false,"rejected":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_core::ArkAddress;
    use bitcoin::{key::TweakedPublicKey, Network, XOnlyPublicKey};

    #[test]
    fn ark_address_server_key_detects_operator_mismatch() {
        let k1: XOnlyPublicKey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
            .parse()
            .unwrap();
        let k2: XOnlyPublicKey = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
            .parse()
            .unwrap();
        let tap = TweakedPublicKey::dangerous_assume_tweaked(k1);
        let regtest_addr = ArkAddress::new(Network::Regtest, k1, tap);
        assert!(checked_ark_address(&regtest_addr, k1).is_ok());
        assert!(matches!(
            checked_ark_address(&regtest_addr, k2),
            Err(LabError::NetworkMismatch)
        ));
        let mainnet_addr = ArkAddress::new(Network::Bitcoin, k1, tap);
        assert!(matches!(
            checked_ark_address(&mainnet_addr, k1),
            Err(LabError::NetworkMismatch)
        ));
    }
}
