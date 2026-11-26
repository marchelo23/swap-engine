#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runExecFile = promisify(execFile);

const OUTPOINT_RE = /^[a-f0-9]{64}:(0|[1-9][0-9]{0,8})$/;
const TXID_RE = /^[a-f0-9]{64}$/;
const WALLETS = ['alice', 'bob'];

function fail(code, detail) {
  const suffix = detail ? `: ${detail}` : '';
  process.stderr.write(`${code}${suffix}\n`);
  process.exit(1);
}

export function resolveRuntimeDir(env = process.env) {
  if (env.ISO_RT_RUNTIME_DIR && env.ISO_RT_RUNTIME_DIR.trim()) {
    return resolve(env.ISO_RT_RUNTIME_DIR.trim());
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  if (scriptDir.endsWith('/swap-engine-iso-regtest/ark')) {
    return resolve(scriptDir, '..');
  }
  const home = env.HOME || homedir();
  return resolve(home, '.local/share/swap-engine-iso-regtest');
}

export function readArkCliPassword(runtimeDir = resolveRuntimeDir()) {
  const candidates = [
    join(runtimeDir, 'secrets', 'ark-cli-password'),
    join(runtimeDir, 'compose.env'),
  ];
  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate, 'utf8');
      if (candidate.endsWith('compose.env')) {
        const match = /^ISO_RT_ARKD_WALLET_PASS=([a-f0-9]{16,128})$/m.exec(content);
        if (match?.[1]) return match[1];
      } else {
        const trimmed = content.trim();
        if (trimmed.length >= 8) return trimmed;
      }
    } catch {
      // Try next candidate
    }
  }
  fail('ArkWalletStorage', 'missing ark-cli wallet password in runtime secrets');
}

export function parseUnixTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.trunc(n);
    }
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 0;
}

export function normalizeVtxoRow(raw, nowSec = Math.floor(Date.now() / 1000)) {
  let outpoint = '';
  if (typeof raw?.outpoint === 'string') {
    outpoint = raw.outpoint;
  } else if (raw?.outpoint && typeof raw.outpoint === 'object' && typeof raw.outpoint.txid === 'string') {
    outpoint = `${raw.outpoint.txid}:${raw.outpoint.vout ?? 0}`;
  } else if (typeof raw?.txid === 'string' && raw?.vout !== undefined) {
    outpoint = `${raw.txid}:${raw.vout}`;
  } else if (typeof raw?.Txid === 'string' && (raw?.VOut ?? raw?.Vout) !== undefined) {
    outpoint = `${raw.Txid}:${raw.VOut ?? raw.Vout}`;
  }
  if (!OUTPOINT_RE.test(outpoint)) {
    throw new Error(`Invalid VTXO outpoint: ${outpoint}`);
  }
  const amountSats = Number(raw?.amount_sats ?? raw?.amount ?? raw?.Amount ?? 0);
  if (!Number.isSafeInteger(amountSats) || amountSats < 0) {
    throw new Error('Invalid VTXO amount');
  }
  const isPreconfirmed = Boolean(raw?.is_preconfirmed ?? raw?.preconfirmed ?? raw?.Preconfirmed);
  const origin = raw?.origin === 'ark_transfer' || raw?.origin === 'batch_leaf'
    ? raw.origin
    : (isPreconfirmed ? 'ark_transfer' : 'batch_leaf');
  const commitmentTxids = Array.isArray(raw?.commitment_txids ?? raw?.CommitmentTxids)
    ? (raw.commitment_txids ?? raw.CommitmentTxids).filter(txid => typeof txid === 'string' && TXID_RE.test(txid))
    : [];
  const isSpent = Boolean(raw?.is_spent ?? raw?.spent ?? raw?.Spent);
  const isUnrolled = Boolean(raw?.is_unrolled ?? raw?.unrolled ?? raw?.Unrolled);
  const isSwept = Boolean(raw?.is_swept ?? raw?.swept ?? raw?.Swept);
  const createdAt = parseUnixTimestamp(raw?.created_at ?? raw?.createdAt ?? raw?.CreatedAt);
  const expiresAt = parseUnixTimestamp(raw?.expires_at ?? raw?.expiresAt ?? raw?.ExpiresAt);
  const isExpired = typeof raw?.is_expired === 'boolean'
    ? raw.is_expired
    : (expiresAt > 0 && expiresAt <= nowSec);
  const normalizeOptionalTxid = candidate =>
    (typeof candidate === 'string' && TXID_RE.test(candidate)) ? candidate : null;

  return {
    outpoint,
    amount_sats: amountSats,
    origin,
    commitment_txids: commitmentTxids,
    is_spent: isSpent,
    is_unrolled: isUnrolled,
    is_swept: isSwept,
    is_expired: isExpired,
    created_at: createdAt,
    expires_at: expiresAt,
    spent_by: normalizeOptionalTxid(raw?.spent_by ?? raw?.spentBy ?? raw?.SpentBy),
    ark_txid: normalizeOptionalTxid(raw?.ark_txid ?? raw?.arkTxid ?? raw?.ArkTxid),
    settled_by: normalizeOptionalTxid(raw?.settled_by ?? raw?.settledBy ?? raw?.SettledBy),
  };
}

export function computeWalletBalance(rawBalance, vtxoRows, nowSec = Math.floor(Date.now() / 1000)) {
  if (
    rawBalance &&
    typeof rawBalance.confirmed_sats === 'number' &&
    typeof rawBalance.total_sats === 'number'
  ) {
    return {
      confirmed_sats: rawBalance.confirmed_sats,
      pre_confirmed_sats: Number(rawBalance.pre_confirmed_sats ?? 0),
      recoverable_sats: Number(rawBalance.recoverable_sats ?? 0),
      pending_recovery_sats: Number(rawBalance.pending_recovery_sats ?? 0),
      total_sats: rawBalance.total_sats,
    };
  }
  let confirmedSats = 0;
  let preConfirmedSats = 0;
  let recoverableSats = 0;
  const pendingRecoverySats = 0;
  const unspentRows = Array.isArray(vtxoRows) ? vtxoRows.filter(row => !row.is_spent) : [];
  for (const row of unspentRows) {
    const expired = row.is_expired || (row.expires_at > 0 && row.expires_at <= nowSec);
    if (row.is_swept || expired) {
      recoverableSats += row.amount_sats;
    } else if (row.origin === 'ark_transfer') {
      preConfirmedSats += row.amount_sats;
    } else {
      confirmedSats += row.amount_sats;
    }
  }
  const reportedTotal = Number(rawBalance?.offchain_balance?.total ?? 0);
  if (unspentRows.length === 0 && Number.isSafeInteger(reportedTotal) && reportedTotal > 0) {
    confirmedSats = reportedTotal;
  }
  const totalSats = confirmedSats + preConfirmedSats + recoverableSats + pendingRecoverySats;
  return {
    confirmed_sats: confirmedSats,
    pre_confirmed_sats: preConfirmedSats,
    recoverable_sats: recoverableSats,
    pending_recovery_sats: pendingRecoverySats,
    total_sats: totalSats,
  };
}

async function queryOperatorInfo(operatorUrl = process.env.ISO_RT_ARK_OPERATOR_URL || 'http://127.0.0.1:47070/v1/info') {
  let response;
  try {
    response = await fetch(operatorUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    });
  } catch {
    fail('ArkOperatorUnavailable', 'could not query the local Arkade operator');
  }
  if (!response.ok) {
    fail('ArkOperatorUnavailable', `operator HTTP ${response.status}`);
  }
  const info = await response.json();
  if (info?.network !== 'regtest' || typeof info?.forfeitAddress !== 'string' || !info.forfeitAddress.startsWith('bcrt1')) {
    fail('ArkNetworkMismatch', 'expected Bitcoin regtest operator');
  }
  return info;
}

async function execArkInContainer(wallet, arkArgs, options = {}) {
  const container = options.container || process.env.ISO_RT_ARKD_CONTAINER || 'iso_rt_arkd';
  const datadir = `/data/${wallet}`;
  const execFn = options.execFn || runExecFile;
  const env = {
    ...process.env,
    PATH: `${process.env.PATH || '/usr/bin:/bin'}:/usr/local/bin:${join(homedir(), '.local/bin')}`,
  };
  const { stdout } = await execFn(
    'podman',
    ['exec', container, '/app/ark', '--datadir', datadir, ...arkArgs],
    {
      timeout: options.timeoutMs ?? 90_000,
      maxBuffer: 1024 * 1024,
      env,
    },
  );
  const text = String(stdout).trim();
  if (!text) return null;
  const jsonStart = text.search(/[\[{]/);
  if (jsonStart < 0) return null;
  return JSON.parse(text.slice(jsonStart));
}

async function fetchWalletVtxos(wallet, options = {}) {
  const spendableRaw = await execArkInContainer(wallet, ['vtxos'], options).catch(() => []);
  const spentRaw = await execArkInContainer(wallet, ['vtxos', '--spent'], options).catch(() => []);
  const combined = [
    ...(Array.isArray(spendableRaw) ? spendableRaw : []),
    ...(Array.isArray(spentRaw) ? spentRaw : []),
  ];
  const byOutpoint = new Map();
  for (const item of combined) {
    const normalized = normalizeVtxoRow(item);
    byOutpoint.set(normalized.outpoint, normalized);
  }
  return [...byOutpoint.values()].sort((a, b) => a.outpoint.localeCompare(b.outpoint));
}

function selectWallets(walletArg) {
  if (!walletArg) return WALLETS;
  if (!WALLETS.includes(walletArg)) {
    fail('ArkInvalidWallet', `expected alice or bob, got ${walletArg}`);
  }
  return [walletArg];
}

export async function runArkLabCli(rawArgs, options = {}) {
  const args = [...rawArgs];
  if (args[0] === '--e2e-fixture') {
    args.shift();
  }
  const [command, ...rest] = args;
  if (!command) {
    fail('ArkCliUsage', 'command required');
  }
  for (const arg of rest) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 160 || arg.startsWith('-')) {
      fail('ArkCliArgumentRejected', 'disallowed argument');
    }
  }

  const runtimeDir = options.runtimeDir || resolveRuntimeDir();
  const info = await (options.queryOperatorInfo ? options.queryOperatorInfo() : queryOperatorInfo());
  const dustSats = Math.max(330, Number(info?.dust ?? 330));

  if (command === 'init-wallets') {
    const password = options.password || readArkCliPassword(runtimeDir);
    const wallets = {};
    for (const wallet of selectWallets(rest[0])) {
      await execArkInContainer(
        wallet,
        [
          'init',
          '--server-url',
          'http://127.0.0.1:7070',
          '--explorer',
          'http://iso_rt_mempool_api:8999/api',
          '--password',
          password,
        ],
        options,
      ).catch(() => null);
      const recv = await execArkInContainer(wallet, ['receive'], options);
      const offchain = recv?.offchain_address ?? recv?.ark?.[0];
      const boarding = recv?.boarding_address ?? recv?.boarding?.[0];
      const onchain = recv?.onchain_address ?? recv?.onchain ?? boarding;
      if (typeof offchain !== 'string' || !offchain.startsWith('tark1') ||
          typeof boarding !== 'string' || !boarding.startsWith('bcrt1')) {
        fail('ArkNetworkMismatch', `invalid regtest addresses for ${wallet}`);
      }
      wallets[wallet] = {
        ark: [offchain],
        boarding: [boarding],
        onchain,
        offchain_address: offchain,
        boarding_address: boarding,
        onchain_address: onchain,
      };
    }
    return { network: 'regtest', asset: 'BTC', wallets };
  }

  if (command === 'addresses') {
    if (rest.length > 1) fail('ArkCliUsage', 'usage: addresses [alice|bob]');
    const wallets = {};
    for (const wallet of selectWallets(rest[0])) {
      const recv = await execArkInContainer(wallet, ['receive'], options);
      const offchain = recv?.offchain_address ?? recv?.ark?.[0];
      const boarding = recv?.boarding_address ?? recv?.boarding?.[0];
      const onchain = recv?.onchain_address ?? recv?.onchain ?? boarding;
      if (typeof offchain !== 'string' || !offchain.startsWith('tark1') ||
          typeof boarding !== 'string' || !boarding.startsWith('bcrt1')) {
        fail('ArkNetworkMismatch', `invalid regtest addresses for ${wallet}`);
      }
      wallets[wallet] = {
        ark: [offchain],
        boarding: [boarding],
        onchain,
        offchain_address: offchain,
        boarding_address: boarding,
        onchain_address: onchain,
      };
    }
    return { network: 'regtest', asset: 'BTC', wallets };
  }

  if (command === 'balance') {
    if (rest.length > 1) fail('ArkCliUsage', 'usage: balance [alice|bob]');
    const wallets = {};
    for (const wallet of selectWallets(rest[0])) {
      const [rawBalance, vtxoRows] = await Promise.all([
        execArkInContainer(wallet, ['balance'], options),
        fetchWalletVtxos(wallet, options),
      ]);
      wallets[wallet] = computeWalletBalance(rawBalance, vtxoRows);
    }
    return { network: 'regtest', asset: 'BTC', wallets };
  }

  if (command === 'list-vtxos') {
    if (rest.length > 1) fail('ArkCliUsage', 'usage: list-vtxos [alice|bob]');
    const wallets = {};
    for (const wallet of selectWallets(rest[0])) {
      wallets[wallet] = await fetchWalletVtxos(wallet, options);
    }
    return { network: 'regtest', asset: 'BTC', wallets };
  }

  if (command === 'board') {
    if (rest.length !== 2) fail('ArkCliUsage', 'usage: board <alice|bob> <txid:vout>');
    const [wallet, fundingOutpoint] = rest;
    if (!WALLETS.includes(wallet)) fail('ArkInvalidWallet', 'expected alice or bob');
    if (!OUTPOINT_RE.test(fundingOutpoint)) fail('ArkOutpointInvalid', 'invalid funding outpoint');
    const password = options.password || readArkCliPassword(runtimeDir);
    let settled;
    try {
      settled = await execArkInContainer(wallet, ['settle', '--password', password], options);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no funds|nothing to settle|missing funds/i.test(msg)) {
        return {
          network: 'regtest',
          asset: 'BTC',
          wallets: { [wallet]: { input: fundingOutpoint, commitment_txid: null } },
        };
      }
      fail('ArkSubmissionUncertain', 'reconcile the original input; do not repeat funding');
    }
    const commitmentTxid = typeof settled?.txid === 'string' && TXID_RE.test(settled.txid)
      ? settled.txid
      : (typeof settled?.commitment_txid === 'string' && TXID_RE.test(settled.commitment_txid)
        ? settled.commitment_txid
        : null);
    return {
      network: 'regtest',
      asset: 'BTC',
      wallets: {
        [wallet]: {
          input: fundingOutpoint,
          commitment_txid: commitmentTxid,
        },
      },
    };
  }

  if (command === 'offboard-coop') {
    if (rest.length !== 3) fail('ArkCliUsage', 'usage: offboard-coop <vtxoOutpoint> <destinationAddress> <amountSats>');
    const [vtxoOutpoint, destinationAddress, amountRaw] = rest;
    if (!OUTPOINT_RE.test(vtxoOutpoint)) fail('ArkOutpointInvalid', 'invalid VTXO outpoint');
    if (!destinationAddress.startsWith('bcrt1')) fail('ArkNetworkMismatch', 'expected bcrt1 regtest address');
    if (!/^[1-9][0-9]*$/.test(amountRaw)) fail('ArkInvalidAmount', 'invalid amount');
    const amountSats = Number(amountRaw);
    if (!Number.isSafeInteger(amountSats) || amountSats < dustSats) {
      fail('ArkInvalidAmount', 'amount below dust');
    }

    let ownerWallet = 'bob';
    const bobVtxos = await fetchWalletVtxos('bob', options);
    let matched = bobVtxos.find(v => v.outpoint === vtxoOutpoint && !v.is_spent);
    if (!matched) {
      const aliceVtxos = await fetchWalletVtxos('alice', options);
      matched = aliceVtxos.find(v => v.outpoint === vtxoOutpoint && !v.is_spent);
      if (matched) ownerWallet = 'alice';
    }
    if (!matched) {
      fail('ArkInputNotSpendable', 'missing, consumed, or stale VTXO');
    }
    const changeSats = matched.amount_sats - amountSats;
    if (changeSats < 0 || (changeSats > 0 && changeSats < dustSats)) {
      fail('ArkInvalidAmount', 'amount or change outside supported range');
    }

    const password = options.password || readArkCliPassword(runtimeDir);
    let redeemed;
    try {
      redeemed = await execArkInContainer(
        ownerWallet,
        ['redeem', '--address', destinationAddress, '--amount', String(amountSats), '--password', password],
        options,
      );
    } catch {
      fail('ArkSubmissionUncertain', 'reconcile the original input; do not submit a replacement');
    }
    const commitmentTxid = redeemed?.txid ?? redeemed?.commitment_txid;
    if (typeof commitmentTxid !== 'string' || !TXID_RE.test(commitmentTxid)) {
      fail('ArkSubmissionUncertain', 'missing commitment txid from cooperative redeem');
    }
    return {
      network: 'regtest',
      asset: 'BTC',
      wallets: {
        bob: {
          input: vtxoOutpoint,
          address: destinationAddress,
          amount_sats: amountSats,
          commitment_txid: commitmentTxid,
          method: 'cooperative',
        },
      },
    };
  }

  fail('ArkCliCommandRejected', `unsupported command ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runArkLabCli(process.argv.slice(2))
    .then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch(error => {
      fail('ArkSdkOperationFailed', error instanceof Error ? error.message : 'unexpected error');
    });
}
