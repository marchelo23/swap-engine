use crate::{
    blockchain::RegtestBlockchain, bounded_submission, LabError, Result, SdkClient, ROUND_DEADLINE,
};
use ark_core::{
    contract::SpendPathKind,
    server::{Info, VirtualTxOutPoint},
};
use bitcoin::{address::NetworkUnchecked, Address, Amount, Network, OutPoint, XOnlyPublicKey};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn check_cooperative_vtxo_eligibility(
    vtxo: &VirtualTxOutPoint,
    server_pk: Option<XOnlyPublicKey>,
    has_forfeit_path: bool,
    info: &Info,
    now_unix_secs: i64,
) -> Result<()> {
    if !vtxo.assets.is_empty() {
        return Err(LabError::UnsupportedAsset);
    }
    // Reject spent, unrolled, swept, expired, or otherwise recoverable VTXOs
    // explicitly before mutation instead of relying on `all_unspent()`, which
    // includes recoverable inputs in the pinned arkade-os/rust-sdk (v0.12.1).
    if vtxo.is_spent
        || vtxo.is_unrolled
        || vtxo.is_swept
        || now_unix_secs > vtxo.expires_at
        || vtxo.is_expired()
        || vtxo.is_recoverable(info.dust)
        || !vtxo.is_spendable_offchain(info.dust)
    {
        return Err(LabError::InputNotSpendable);
    }
    let server_pk = server_pk.ok_or(LabError::InputNotSpendable)?;
    if info.signer_requires_recovery_at(server_pk, now_unix_secs) {
        return Err(LabError::InputNotSpendable);
    }
    if !has_forfeit_path {
        return Err(LabError::InputNotSpendable);
    }
    Ok(())
}

fn check_cooperative_amounts(vtxo_amount: Amount, amount: Amount, info: &Info) -> Result<()> {
    let min_out = info.dust.max(info.utxo_min_amount.unwrap_or_default());
    let min_change = info.dust.max(info.vtxo_min_amount.unwrap_or_default());
    let change = vtxo_amount.checked_sub(amount);
    if amount < min_out
        || info.utxo_max_amount.is_some_and(|max| amount > max)
        || change.is_none_or(|value| value != Amount::ZERO && value < min_change)
    {
        return Err(LabError::InvalidAmount);
    }
    Ok(())
}

pub(crate) fn checked_address(address: Address<NetworkUnchecked>) -> Result<Address> {
    // Base58 testnet and regtest addresses share version bytes. Require
    // an address with a regtest-specific witness HRP.
    let checked = address
        .require_network(Network::Regtest)
        .map_err(|_| LabError::NetworkMismatch)?;
    if !checked.to_string().starts_with("bcrt1") {
        return Err(LabError::NetworkMismatch);
    }
    Ok(checked)
}

pub(crate) async fn cooperative(
    client: &SdkClient,
    input: OutPoint,
    address: Address<NetworkUnchecked>,
    sats: u64,
) -> Result<Value> {
    let address = checked_address(address)?;
    RegtestBlockchain::new()
        .map_err(|_| LabError::IndexerUnavailable)?
        .require_regtest()
        .await
        .map_err(|_| LabError::IndexerUnavailable)?;
    let info = client
        .server_info()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let list = client
        .list_vtxos()
        .await
        .map_err(|_| LabError::OperatorUnavailable)?;
    let entry = list
        .all()
        .find(|entry| entry.vtxo().outpoint == input)
        .ok_or(LabError::InputNotSpendable)?;
    let now_unix_secs = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| LabError::Sdk("system clock before UNIX_EPOCH"))?
            .as_secs(),
    )
    .map_err(|_| LabError::Sdk("system clock timestamp overflow"))?;
    check_cooperative_vtxo_eligibility(
        entry.vtxo(),
        entry.server_pk().ok(),
        entry.spend_selection(SpendPathKind::Forfeit).is_ok(),
        &info,
        now_unix_secs,
    )?;
    let amount = Amount::from_sat(sats);
    check_cooperative_amounts(entry.vtxo().amount, amount, &info)?;
    let mut rng = bitcoin::secp256k1::rand::thread_rng();
    let commitment = bounded_submission(
        ROUND_DEADLINE,
        client.collaborative_redeem_vtxo_selection(
            &mut rng,
            [input].into_iter(),
            address.clone(),
            amount,
        ),
    )
    .await?;
    Ok(
        json!({"input":input.to_string(),"address":address.to_string(),"amount_sats":sats,
              "commitment_txid":commitment,"method":"cooperative"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_core::{
        asset::AssetId,
        server::{Asset, DeprecatedSigner},
    };
    use bitcoin::{hashes::Hash, secp256k1::Secp256k1, ScriptBuf, Txid};
    use std::time::Duration;

    fn sample_info() -> (Info, XOnlyPublicKey) {
        let secp = Secp256k1::verification_only();
        let key: XOnlyPublicKey =
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
                .parse()
                .unwrap();
        let pk = key.public_key(bitcoin::secp256k1::Parity::Even);
        let forfeit = Address::p2tr(&secp, key, None, Network::Regtest);
        let info = Info {
            version: "v0.9.25".into(),
            signer_pk: pk,
            forfeit_pk: pk,
            forfeit_address: forfeit,
            checkpoint_tapscript: ScriptBuf::new(),
            network: Network::Regtest,
            session_duration: 10,
            unilateral_exit_delay: bitcoin::Sequence(20),
            boarding_exit_delay: bitcoin::Sequence(30),
            utxo_min_amount: None,
            utxo_max_amount: None,
            vtxo_min_amount: Some(Amount::from_sat(330)),
            vtxo_max_amount: None,
            dust: Amount::from_sat(330),
            fees: None,
            scheduled_session: None,
            deprecated_signers: vec![],
            service_status: std::collections::HashMap::new(),
            digest: String::new(),
            max_tx_weight: 0,
            max_op_return_outputs: 0,
        };
        (info, key)
    }

    fn current_unix_secs() -> i64 {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        )
        .unwrap()
    }

    fn sample_vtxo(now: i64) -> VirtualTxOutPoint {
        VirtualTxOutPoint {
            outpoint: OutPoint::new(Txid::from_byte_array([7; 32]), 0),
            created_at: now - 10,
            expires_at: now + 3_600,
            amount: Amount::from_sat(75_000),
            script: ScriptBuf::new(),
            is_preconfirmed: false,
            is_swept: false,
            is_unrolled: false,
            is_spent: false,
            spent_by: None,
            commitment_txids: vec![Txid::from_byte_array([8; 32])],
            settled_by: None,
            ark_txid: None,
            assets: vec![],
            depth: 0,
        }
    }

    #[test]
    fn cooperative_exit_requires_regtest_witness_address() {
        let secp = Secp256k1::verification_only();
        let key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
            .parse::<XOnlyPublicKey>()
            .unwrap();
        for net in [Network::Regtest, Network::Bitcoin, Network::Testnet] {
            let addr = Address::p2tr(&secp, key, None, net);
            assert_eq!(
                checked_address(addr.into_unchecked()).is_ok(),
                net == Network::Regtest
            );
        }
    }

    #[tokio::test]
    async fn simulated_offboard_submission_timeout_is_uncertain() {
        // Simulated stalled SDK response; no Bitcoin or Ark services.
        let error = bounded_submission(
            Duration::ZERO,
            std::future::pending::<std::result::Result<(), ()>>(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, LabError::SubmissionUncertain));
    }

    #[test]
    fn cooperative_exit_rejects_sub_dust_change_and_allows_full_drain() {
        let (info, _) = sample_info();
        let input = Amount::from_sat(75_000);
        assert!(check_cooperative_amounts(input, Amount::from_sat(30_000), &info).is_ok());
        assert!(check_cooperative_amounts(input, input, &info).is_ok());
        assert!(matches!(
            check_cooperative_amounts(input, Amount::from_sat(74_800), &info),
            Err(LabError::InvalidAmount)
        ));
        assert!(matches!(
            check_cooperative_amounts(input, Amount::from_sat(329), &info),
            Err(LabError::InvalidAmount)
        ));
        assert!(matches!(
            check_cooperative_amounts(input, Amount::from_sat(75_001), &info),
            Err(LabError::InvalidAmount)
        ));
    }

    #[test]
    fn cooperative_exit_eligibility_accepts_confirmed_and_preconfirmed_spendable_vtxos() {
        let (mut info, signer_xonly) = sample_info();
        let now = current_unix_secs();
        let confirmed = sample_vtxo(now);
        assert!(confirmed.is_spendable_offchain(info.dust));
        assert!(check_cooperative_vtxo_eligibility(
            &confirmed,
            Some(signer_xonly),
            true,
            &info,
            now
        )
        .is_ok());

        let preconfirmed = VirtualTxOutPoint {
            is_preconfirmed: true,
            ..confirmed.clone()
        };
        assert!(preconfirmed.is_spendable_offchain(info.dust));
        assert!(check_cooperative_vtxo_eligibility(
            &preconfirmed,
            Some(signer_xonly),
            true,
            &info,
            now
        )
        .is_ok());

        // Deprecated signer before cutoff (or cutoff_date == 0) remains co-signable per SDK.
        let old_xonly: XOnlyPublicKey =
            "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
                .parse()
                .unwrap();
        let old_pk = old_xonly.public_key(bitcoin::secp256k1::Parity::Even);
        for cutoff_date in [0, now + 3_600] {
            info.deprecated_signers = vec![DeprecatedSigner {
                pk: old_pk,
                cutoff_date,
            }];
            assert!(check_cooperative_vtxo_eligibility(
                &confirmed,
                Some(old_xonly),
                true,
                &info,
                now
            )
            .is_ok());
        }
    }

    #[test]
    fn cooperative_exit_eligibility_rejects_expired_vtxo() {
        let (info, signer_xonly) = sample_info();
        let now = current_unix_secs();
        let expired = VirtualTxOutPoint {
            created_at: 1,
            expires_at: 2,
            ..sample_vtxo(now)
        };
        // `all_unspent()` would include this expired VTXO because `is_unspent` includes recoverable.
        assert!(expired.is_unspent(info.dust));
        assert!(expired.is_expired());
        assert!(expired.is_recoverable(info.dust));
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&expired, Some(signer_xonly), true, &info, now),
            Err(LabError::InputNotSpendable)
        ));
    }

    #[test]
    fn cooperative_exit_eligibility_rejects_spent_vtxo() {
        let (info, signer_xonly) = sample_info();
        let now = current_unix_secs();
        let spent = VirtualTxOutPoint {
            is_spent: true,
            spent_by: Some(Txid::from_byte_array([9; 32])),
            ..sample_vtxo(now)
        };
        assert!(!spent.is_unspent(info.dust));
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&spent, Some(signer_xonly), true, &info, now),
            Err(LabError::InputNotSpendable)
        ));
    }

    #[test]
    fn cooperative_exit_eligibility_rejects_recoverable_and_ineligible_vtxos() {
        let (mut info, signer_xonly) = sample_info();
        let now = current_unix_secs();
        let base = sample_vtxo(now);

        let swept = VirtualTxOutPoint {
            is_swept: true,
            ..base.clone()
        };
        assert!(swept.is_unspent(info.dust));
        assert!(swept.is_recoverable(info.dust));
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&swept, Some(signer_xonly), true, &info, now),
            Err(LabError::InputNotSpendable)
        ));

        let sub_dust = VirtualTxOutPoint {
            amount: Amount::from_sat(329),
            ..base.clone()
        };
        assert!(sub_dust.is_unspent(info.dust));
        assert!(sub_dust.is_recoverable(info.dust));
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&sub_dust, Some(signer_xonly), true, &info, now),
            Err(LabError::InputNotSpendable)
        ));

        let unrolled = VirtualTxOutPoint {
            is_unrolled: true,
            ..base.clone()
        };
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&unrolled, Some(signer_xonly), true, &info, now),
            Err(LabError::InputNotSpendable)
        ));

        // Deprecated signer past its cooperative-sign cutoff requires recovery, not cooperative exit.
        let old_xonly: XOnlyPublicKey =
            "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
                .parse()
                .unwrap();
        info.deprecated_signers = vec![DeprecatedSigner {
            pk: old_xonly.public_key(bitcoin::secp256k1::Parity::Even),
            cutoff_date: now - 1,
        }];
        assert!(info.signer_requires_recovery_at(old_xonly, now));
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&base, Some(old_xonly), true, &info, now),
            Err(LabError::InputNotSpendable)
        ));

        // Missing contract signer or missing cooperative forfeit spend path fails closed.
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&base, None, true, &info, now),
            Err(LabError::InputNotSpendable)
        ));
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&base, Some(signer_xonly), false, &info, now),
            Err(LabError::InputNotSpendable)
        ));

        // VTXO carrying non-BTC assets fails closed with UnsupportedAsset.
        let with_asset = VirtualTxOutPoint {
            assets: vec![Asset {
                asset_id: AssetId {
                    txid: Txid::from_byte_array([5; 32]),
                    group_index: 0,
                },
                amount: 1,
            }],
            ..base
        };
        assert!(matches!(
            check_cooperative_vtxo_eligibility(&with_asset, Some(signer_xonly), true, &info, now),
            Err(LabError::UnsupportedAsset)
        ));
    }
}
