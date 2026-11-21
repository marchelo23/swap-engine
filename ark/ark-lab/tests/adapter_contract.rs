//! Declared synthetic backend. No SDK, network, Bitcoin transactions or persistent storage.

use ark_lab::adapter::*;
use bitcoin::{hashes::Hash, Address, Amount, BlockHash, OutPoint, Txid};
use std::{collections::HashMap, num::NonZeroU32, time::SystemTime};

#[derive(Default)]
struct DeclaredMock {
    quotes: HashMap<QuoteId, Quote>,
    journal: HashMap<OperationId, (Submission, OperationStatus, Option<Proof>)>,
    reserved_inputs: HashMap<OutPoint, OperationId>,
    original_ark_txids: HashMap<OperationId, Txid>,
    submit_calls: usize,
    lose_reply: bool,
    observed_transfer: Option<ObservedTransfer>,
}

#[derive(Clone)]
struct ObservedTransfer {
    pending: bool,
    consumed: (VtxoId, Txid),
    recipient: ark_core::ArkAddress,
    receipt: VtxoId,
    amount: Amount,
}

impl ArkAdapter for DeclaredMock {
    async fn balance(&self) -> AdapterResult<Balance> {
        Ok(Balance {
            batch_confirmed: Amount::ZERO,
            preconfirmed: Amount::ZERO,
            recoverable: Amount::ZERO,
            pending_recovery: Amount::ZERO,
            total: Amount::ZERO,
        })
    }

    async fn vtxos(&self) -> AdapterResult<Vec<Vtxo>> {
        Ok(Vec::new())
    }

    async fn fee_policy(&self) -> AdapterResult<FeePolicy> {
        Err(AdapterError::UnsupportedCapability)
    }

    async fn quote(&self, intent: Intent, max_user_fee: Amount) -> AdapterResult<Quote> {
        let amount = match &intent {
            Intent::Boarding { credit, .. } => *credit,
            Intent::Transfer { amount, .. } | Intent::Offboarding { amount, .. } => *amount,
        };
        let fees = FeeCaps {
            operator: Amount::from_sat(10),
            bitcoin: Amount::ZERO,
        };
        if amount < Amount::from_sat(330) || fees.total().unwrap() > max_user_fee {
            return Err(AdapterError::LimitsExceeded);
        }
        Ok(Quote {
            id: QuoteId(1),
            intent,
            fee_caps: fees,
            expires_at: SystemTime::now() + MAX_QUOTE_TTL,
        })
    }

    async fn submit(&mut self, request: Submission) -> AdapterResult<OperationStatus> {
        let id = request.id;
        if let Some((original, state, _)) = self.journal.get(&id) {
            if *original != request {
                return Err(AdapterError::IdempotencyConflict);
            }
            return Ok(*state);
        }
        let quote = self
            .quotes
            .get(&request.quote)
            .ok_or(AdapterError::InvalidQuote)?;
        quote.validate_submission(&request, SystemTime::now())?;
        let input = match &request.intent {
            Intent::Boarding { funding, .. } => *funding,
            Intent::Transfer { input, .. } | Intent::Offboarding { input, .. } => input.0,
        };
        if self.reserved_inputs.contains_key(&input) {
            return Err(AdapterError::InputNotSpendable);
        }
        self.reserved_inputs.insert(input, id);
        if matches!(request.intent, Intent::Transfer { .. }) {
            // The synthetic remote records the original TXID even if the
            // caller loses the reply. Recovery must match this reference.
            self.original_ark_txids
                .insert(id, Txid::from_byte_array([self.submit_calls as u8 + 2; 32]));
        }
        self.journal
            .insert(id, (request, OperationStatus::Prepared, None));
        self.submit_calls += 1;
        let entry = self.journal.get_mut(&id).unwrap();
        if self.lose_reply {
            entry.1 = OperationStatus::Uncertain;
            return Err(AdapterError::SubmissionUncertain(id));
        }
        entry.1 = OperationStatus::Submitted;
        Ok(entry.1)
    }

    async fn status(&self, id: OperationId) -> AdapterResult<OperationStatus> {
        self.journal
            .get(&id)
            .map(|entry| entry.1)
            .ok_or(AdapterError::UnknownOperation)
    }

    async fn proof(&self, id: OperationId) -> AdapterResult<Option<Proof>> {
        self.journal
            .get(&id)
            .map(|entry| entry.2.clone())
            .ok_or(AdapterError::UnknownOperation)
    }

    async fn recover(&mut self, id: OperationId) -> AdapterResult<OperationStatus> {
        let (request, state, evidence) = self
            .journal
            .get_mut(&id)
            .ok_or(AdapterError::UnknownOperation)?;
        if *state != OperationStatus::Uncertain {
            return Ok(*state);
        }
        let (
            Intent::Transfer {
                input,
                recipient,
                amount,
            },
            Some(observed),
            Some(&txid),
        ) = (
            &request.intent,
            &self.observed_transfer,
            self.original_ark_txids.get(&id),
        )
        else {
            return Ok(*state);
        };
        if !observed.pending
            && observed.consumed == (*input, txid)
            && observed.receipt.0.txid == txid
            && observed.recipient == *recipient
            && observed.amount == *amount
        {
            *state = OperationStatus::Preconfirmed;
            *evidence = Some(Proof::TransferReceipt {
                ark_txid: txid,
                recipient_vtxo: observed.receipt,
                amount: observed.amount,
            });
        }
        Ok(*state)
    }
}

fn sample_intents() -> [Intent; 3] {
    use bitcoin::{key::TweakedPublicKey, XOnlyPublicKey};
    let input = OutPoint::new(Txid::from_byte_array([1; 32]), 0);
    let amount = Amount::from_sat(1_000);
    let key: XOnlyPublicKey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        .parse()
        .unwrap();
    let taproot = TweakedPublicKey::dangerous_assume_tweaked(key);
    [
        Intent::Boarding {
            funding: input,
            credit: amount,
        },
        Intent::Transfer {
            input: VtxoId(input),
            recipient: ark_core::ArkAddress::new(bitcoin::Network::Regtest, key, taproot),
            amount,
        },
        Intent::Offboarding {
            input: VtxoId(input),
            recipient: Address::p2tr_tweaked(taproot, bitcoin::Network::Regtest).into_unchecked(),
            amount,
        },
    ]
}

async fn prepare(mock: &mut DeclaredMock, intent: Intent) -> Submission {
    let quote = mock
        .quote(intent.clone(), Amount::from_sat(10))
        .await
        .unwrap();
    assert_eq!(quote.fee_caps.total(), Some(Amount::from_sat(10)));
    mock.quotes.insert(quote.id, quote.clone());
    Submission {
        id: OperationId(99),
        quote: quote.id,
        intent,
    }
}

#[tokio::test]
async fn mock_quote_rejects_excess_fee_expiry_and_wrong_intent_before_submit() {
    let mut adapter = DeclaredMock::default();
    let [boarding, transfer, _] = sample_intents();
    assert_eq!(adapter.scope(), LAB_SCOPE);
    assert_eq!(adapter.balance().await.unwrap().total, Amount::ZERO);
    assert!(adapter.vtxos().await.unwrap().is_empty());
    assert_eq!(
        adapter.quote(boarding.clone(), Amount::ZERO).await,
        Err(AdapterError::LimitsExceeded)
    );
    assert_eq!(
        adapter
            .quote(
                Intent::Boarding {
                    funding: OutPoint::null(),
                    credit: Amount::from_sat(329),
                },
                Amount::from_sat(10),
            )
            .await,
        Err(AdapterError::LimitsExceeded)
    );
    assert_eq!(
        FeeCaps {
            operator: Amount::from_sat(u64::MAX),
            bitcoin: Amount::from_sat(1)
        }
        .total(),
        None
    );
    let request = prepare(&mut adapter, boarding).await;
    let mut wrong = request.clone();
    wrong.intent = transfer;
    assert_eq!(adapter.submit(wrong).await, Err(AdapterError::InvalidQuote));
    let quote = adapter.quotes.get_mut(&request.quote).unwrap();
    quote.expires_at = SystemTime::now();
    assert_eq!(
        quote.validate_submission(&request, quote.expires_at),
        Err(AdapterError::QuoteExpired)
    );
    assert_eq!(
        adapter.submit(request).await,
        Err(AdapterError::QuoteExpired)
    );
    assert_eq!(adapter.submit_calls, 0);
}

#[tokio::test]
async fn mock_replays_same_request_without_submitting_even_when_quote_has_expired() {
    for intent in sample_intents() {
        let mut adapter = DeclaredMock::default();
        let request = prepare(&mut adapter, intent).await;
        assert_eq!(
            adapter.submit(request.clone()).await,
            Ok(OperationStatus::Submitted)
        );
        adapter.quotes.get_mut(&request.quote).unwrap().expires_at = SystemTime::UNIX_EPOCH;
        assert_eq!(
            adapter.submit(request.clone()).await,
            Ok(OperationStatus::Submitted)
        );
        let wrong = Submission {
            quote: QuoteId(2),
            ..request
        };
        assert_eq!(
            adapter.submit(wrong).await,
            Err(AdapterError::IdempotencyConflict)
        );
        assert_eq!(adapter.submit_calls, 1);
    }
}

#[tokio::test]
async fn mock_uncertain_transfer_recovers_original_with_preconfirmation_not_chain_proof() {
    let mut adapter = DeclaredMock {
        lose_reply: true,
        ..Default::default()
    };
    let [_, transfer, _] = sample_intents();
    let Intent::Transfer {
        input,
        recipient,
        amount,
    } = transfer.clone()
    else {
        unreachable!()
    };
    let request = prepare(&mut adapter, transfer).await;
    let id = request.id;
    assert_eq!(
        adapter.status(id).await,
        Err(AdapterError::UnknownOperation)
    );
    assert_eq!(adapter.proof(id).await, Err(AdapterError::UnknownOperation));
    assert_eq!(
        adapter.submit(request.clone()).await,
        Err(AdapterError::SubmissionUncertain(id))
    );
    assert_eq!(
        adapter.submit(request.clone()).await,
        Ok(OperationStatus::Uncertain)
    );
    let second_id = Submission {
        id: OperationId(100),
        ..request
    };
    assert_eq!(
        adapter.submit(second_id.clone()).await,
        Err(AdapterError::InputNotSpendable)
    );
    assert_eq!(
        adapter.status(second_id.id).await,
        Err(AdapterError::UnknownOperation)
    );
    assert_eq!(adapter.recover(id).await, Ok(OperationStatus::Uncertain));
    assert_eq!(adapter.proof(id).await, Ok(None));
    let txid = Txid::from_byte_array([2; 32]);
    let recipient_vtxo = VtxoId(OutPoint::new(txid, 0));
    let observed = ObservedTransfer {
        pending: false,
        consumed: (input, txid),
        recipient,
        receipt: recipient_vtxo,
        amount,
    };
    let unrelated = Txid::from_byte_array([3; 32]);
    let wrong_destination = ark_core::ArkAddress::new(
        bitcoin::Network::Regtest,
        bitcoin::secp256k1::Keypair::from_seckey_slice(
            &bitcoin::secp256k1::Secp256k1::new(),
            &[2; 32],
        )
        .unwrap()
        .x_only_public_key()
        .0,
        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
                .parse()
                .unwrap(),
        ),
    );
    for bad in [
        ObservedTransfer {
            pending: true,
            ..observed.clone()
        },
        ObservedTransfer {
            consumed: (VtxoId(OutPoint::null()), txid),
            ..observed.clone()
        },
        ObservedTransfer {
            consumed: (input, unrelated),
            ..observed.clone()
        },
        ObservedTransfer {
            receipt: VtxoId(OutPoint::new(unrelated, 0)),
            ..observed.clone()
        },
        ObservedTransfer {
            recipient: wrong_destination,
            ..observed.clone()
        },
        ObservedTransfer {
            amount: Amount::from_sat(999),
            ..observed.clone()
        },
    ] {
        adapter.observed_transfer = Some(bad);
        assert_eq!(adapter.recover(id).await, Ok(OperationStatus::Uncertain));
        assert_eq!(adapter.proof(id).await, Ok(None));
    }
    adapter.observed_transfer = Some(observed);
    assert_eq!(adapter.recover(id).await, Ok(OperationStatus::Preconfirmed));
    assert_eq!(
        adapter.proof(id).await,
        Ok(Some(Proof::TransferReceipt {
            ark_txid: txid,
            recipient_vtxo,
            amount: Amount::from_sat(1_000),
        }))
    );
    assert_eq!(adapter.submit_calls, 1);
}

#[tokio::test]
async fn mock_offboarding_reorg_removes_confirmation_evidence_without_resubmission() {
    let mut adapter = DeclaredMock::default();
    let [_, _, offboarding] = sample_intents();
    let request = prepare(&mut adapter, offboarding).await;
    let id = request.id;
    assert_eq!(
        adapter.submit(request).await,
        Ok(OperationStatus::Submitted)
    );
    let txid = Txid::from_byte_array([3; 32]);
    let proof = Proof::OffboardingConfirmation {
        payout: OutPoint::new(txid, 2),
        amount: Amount::from_sat(1_000),
        commitment: ChainAnchor {
            txid,
            block_hash: BlockHash::from_byte_array([4; 32]),
            height: 101,
            confirmations: NonZeroU32::MIN,
        },
    };
    let entry = adapter.journal.get_mut(&id).unwrap();
    entry.1 = OperationStatus::Confirmed;
    entry.2 = Some(proof.clone());
    assert_eq!(adapter.status(id).await, Ok(OperationStatus::Confirmed));
    assert_eq!(adapter.proof(id).await, Ok(Some(proof)));
    let entry = adapter.journal.get_mut(&id).unwrap();
    entry.1 = OperationStatus::AwaitingConfirmations;
    entry.2 = None;
    assert_eq!(
        adapter.status(id).await,
        Ok(OperationStatus::AwaitingConfirmations)
    );
    assert_eq!(adapter.proof(id).await, Ok(None));
    assert_eq!(adapter.submit_calls, 1);
}

#[tokio::test]
async fn quote_validation_rejects_zero_amounts_and_non_regtest_destinations() {
    use bitcoin::{key::TweakedPublicKey, XOnlyPublicKey};

    let key: XOnlyPublicKey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        .parse()
        .unwrap();
    let tap = TweakedPublicKey::dangerous_assume_tweaked(key);
    let input = VtxoId(OutPoint::new(Txid::from_byte_array([9; 32]), 0));
    let expires_at = SystemTime::now() + MAX_QUOTE_TTL;
    let fee_caps = FeeCaps {
        operator: Amount::ZERO,
        bitcoin: Amount::ZERO,
    };

    for bad_zero in [
        Intent::Boarding {
            funding: input.0,
            credit: Amount::ZERO,
        },
        Intent::Transfer {
            input,
            recipient: ark_core::ArkAddress::new(bitcoin::Network::Regtest, key, tap),
            amount: Amount::ZERO,
        },
        Intent::Offboarding {
            input,
            recipient: Address::p2tr_tweaked(tap, bitcoin::Network::Regtest).into_unchecked(),
            amount: Amount::ZERO,
        },
    ] {
        let quote = Quote {
            id: QuoteId(7),
            intent: bad_zero.clone(),
            fee_caps,
            expires_at,
        };
        let req = Submission {
            id: OperationId(7),
            quote: QuoteId(7),
            intent: bad_zero,
        };
        assert_eq!(
            quote.validate_submission(&req, SystemTime::now()),
            Err(AdapterError::LimitsExceeded)
        );
    }

    for bad_net in [
        Intent::Transfer {
            input,
            recipient: ark_core::ArkAddress::new(bitcoin::Network::Bitcoin, key, tap),
            amount: Amount::from_sat(1_000),
        },
        Intent::Offboarding {
            input,
            recipient: Address::p2tr_tweaked(tap, bitcoin::Network::Bitcoin).into_unchecked(),
            amount: Amount::from_sat(1_000),
        },
        Intent::Offboarding {
            input,
            recipient: "1BitcoinEaterAddressDontSendf59kuE"
                .parse::<Address<bitcoin::address::NetworkUnchecked>>()
                .unwrap(),
            amount: Amount::from_sat(1_000),
        },
    ] {
        let quote = Quote {
            id: QuoteId(8),
            intent: bad_net.clone(),
            fee_caps,
            expires_at,
        };
        let req = Submission {
            id: OperationId(8),
            quote: QuoteId(8),
            intent: bad_net,
        };
        assert_eq!(
            quote.validate_submission(&req, SystemTime::now()),
            Err(AdapterError::NetworkMismatch)
        );
    }
}
