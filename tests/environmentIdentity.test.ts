import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyArkIdentity, verifyBitcoinIdentity, verifyLiquidIdentity, verifyLndIdentity } from '../src/environment/Identity.js';

const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const chain = (name: string) => ({ chain: name, blocks: 100, bestblockhash: 'ab'.repeat(32), initialblockdownload: false });

test('Bitcoin identity binds chain/genesis and requires a reviewed signet challenge', () => {
  assert.deepEqual(verifyBitcoinIdentity(chain('regtest'), genesis, { name: 'regtest', genesisHash: genesis }),
    { name: 'regtest', genesisHash: genesis });
  assert.throws(() => verifyBitcoinIdentity(chain('main'), genesis, { name: 'regtest', genesisHash: genesis }), /GENESIS_MISMATCH|CHAIN_IDENTITY_MISMATCH|CHAIN_MAINNET_REJECTED/);
  const signetGenesis = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
  assert.throws(() => verifyBitcoinIdentity(chain('signet'), signetGenesis,
    { name: 'signet', genesisHash: signetGenesis }), /SIGNET_CHALLENGE_MISSING/);
  assert.throws(() => verifyBitcoinIdentity(chain('signet'), signetGenesis,
    { name: 'signet', genesisHash: signetGenesis, signetChallenge: '51' }, { signet_challenge: '52' }), /SIGNET_CHALLENGE_MISMATCH/);
  assert.deepEqual(verifyBitcoinIdentity(chain('signet'), signetGenesis,
    { name: 'signet', genesisHash: signetGenesis, signetChallenge: '51' }, { signet_challenge: '51' }),
  { name: 'signet', genesisHash: signetGenesis });
});

test('LND, Ark and Liquid read-only identity checks fail closed', () => {
  assert.deepEqual(verifyLndIdentity({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }, 'regtest'),
    { chain: 'bitcoin', network: 'regtest' });
  assert.throws(() => verifyLndIdentity({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: false }, 'regtest'), /LND_NOT_SYNCED/);
  assert.throws(() => verifyLndIdentity({ chains: [{ chain: 'bitcoin', network: 'mainnet' }], synced_to_chain: true }, 'regtest'), /LND_IDENTITY_MISMATCH/);

  const signer = '02' + '11'.repeat(32);
  assert.equal(verifyArkIdentity({ network: 'regtest', signerPubkey: signer,
    forfeitAddress: 'bcrt1qexample000000000000000000000000000000', dust: '330' }, signer).signerPubkey, signer);
  assert.throws(() => verifyArkIdentity({ network: 'regtest', signerPubkey: '03' + '22'.repeat(32),
    forfeitAddress: 'bcrt1qexample000000000000000000000000000000', dust: '330' }, signer), /ARK_IDENTITY_MISMATCH/);

  const policy = 'ab'.repeat(32); const pegged = 'cd'.repeat(32); const parent = 'ef'.repeat(32);
  const expected = { chainName: 'elementsregtest', policyAsset: policy, parentGenesisHash: parent };
  const result = verifyLiquidIdentity({ chain: 'elementsregtest' },
    { fee_asset: policy, pegged_asset: pegged, parent_blockhash: parent }, expected);
  assert.equal(result.policyAsset, policy); // policy and pegged may differ
  assert.throws(() => verifyLiquidIdentity({ chain: 'elementsregtest' },
    { pegged_asset: pegged, parent_blockhash: parent }, expected), /LIQUID_FEE_ASSET_UNAVAILABLE/);
  assert.throws(() => verifyLiquidIdentity({ chain: 'elementsregtest' },
    { fee_asset: pegged, pegged_asset: policy, parent_blockhash: parent }, expected), /LIQUID_POLICY_ASSET_MISMATCH/);
  assert.throws(() => verifyLiquidIdentity({ chain: 'liquidv1' },
    { fee_asset: policy, parent_blockhash: parent }, expected), /LIQUID_MAINNET_REJECTED/);
});
