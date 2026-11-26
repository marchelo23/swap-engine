import { z } from 'zod';

export type ParsedLndMacaroon = {
  location?: string;
  ops: Array<{ entity: string; actions: string[] }>;
  caveatCount: number;
};

export type LndMacaroonRole = 'readonly' | 'payer-readonly' | 'payee-readonly' | 'router';

const ROUTER_URI_ACTIONS = new Set([
  '/routerrpc.Router/SendPaymentV2',
  '/routerrpc.Router/TrackPaymentV2',
]);

const PAYER_READ_REQUIRED_URIS = new Set([
  '/lnrpc.Lightning/GetInfo',
  '/lnrpc.Lightning/ListChannels',
  '/lnrpc.Lightning/WalletBalance',
  '/lnrpc.Lightning/ListPayments',
  '/lnrpc.Lightning/DecodePayReq',
]);

const PAYEE_READ_REQUIRED_URIS = new Set([
  '/lnrpc.Lightning/GetInfo',
  '/lnrpc.Lightning/ListChannels',
  '/lnrpc.Lightning/WalletBalance',
]);

const OPTIONAL_READ_URIS = new Set([
  '/lnrpc.State/GetState',
]);

const READONLY_ENTITY_ALLOWLIST = new Set([
  'info',
  'offchain',
  'onchain',
]);

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++]!;
    if (pos > offset + 1 && byte === 0) throw new Error('FORWARD_MACAROON_INVALID');
    value += (byte & 0x7f) * (2 ** shift);
    if (!Number.isSafeInteger(value) || value > 0x7fffffff) {
      throw new Error('FORWARD_MACAROON_INVALID');
    }
    if ((byte & 0x80) === 0) {
      return { value, next: pos };
    }
    shift += 7;
    if (shift > 28) throw new Error('FORWARD_MACAROON_INVALID');
  }
  throw new Error('FORWARD_MACAROON_INVALID');
}

function decodeUtf8Strict(buf: Buffer): string {
  const decoded = buf.toString('utf8');
  if (decoded.includes('\0') || !Buffer.from(decoded, 'utf8').equals(buf)) {
    throw new Error('FORWARD_MACAROON_INVALID');
  }
  return decoded;
}

function readPacketField(buf: Buffer, offset: number): { type: number; data: Buffer; next: number } {
  const { value: type, next: afterType } = readVarint(buf, offset);
  if (type === 0) return { type: 0, data: Buffer.alloc(0), next: afterType };
  const { value: length, next } = readVarint(buf, afterType);
  if (next + length > buf.length) throw new Error('FORWARD_MACAROON_INVALID');
  return { type, data: buf.subarray(next, next + length), next: next + length };
}

function parseOp(buf: Buffer): { entity: string; actions: string[] } {
  let pos = 0;
  let entity: string | undefined;
  const actions: string[] = [];
  const seenActions = new Set<string>();
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x07;
    if (wire !== 2) throw new Error('FORWARD_MACAROON_INVALID');
    const len = readVarint(buf, pos);
    pos = len.next;
    if (pos + len.value > buf.length) throw new Error('FORWARD_MACAROON_INVALID');
    const slice = buf.subarray(pos, pos + len.value);
    pos += len.value;
    if (field === 1) {
      if (entity !== undefined || slice.length === 0) throw new Error('FORWARD_MACAROON_INVALID');
      entity = decodeUtf8Strict(slice);
    } else if (field === 2) {
      if (slice.length === 0) throw new Error('FORWARD_MACAROON_INVALID');
      const action = decodeUtf8Strict(slice);
      if (seenActions.has(action)) throw new Error('FORWARD_MACAROON_INVALID');
      seenActions.add(action);
      actions.push(action);
    } else {
      throw new Error('FORWARD_MACAROON_INVALID');
    }
  }
  if (!entity || actions.length === 0) throw new Error('FORWARD_MACAROON_INVALID');
  return { entity, actions };
}

function parseLndIdentifier(identifier: Buffer): Array<{ entity: string; actions: string[] }> {
  if (identifier.length < 2 || identifier[0] !== 0x03) {
    throw new Error('FORWARD_MACAROON_INVALID');
  }
  const ops: Array<{ entity: string; actions: string[] }> = [];
  let pos = 1;
  let seenNonce = false;
  let seenStorageId = false;
  while (pos < identifier.length) {
    const tag = readVarint(identifier, pos);
    pos = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 0x07;
    if (wire !== 2) throw new Error('FORWARD_MACAROON_INVALID');
    const len = readVarint(identifier, pos);
    pos = len.next;
    if (pos + len.value > identifier.length) throw new Error('FORWARD_MACAROON_INVALID');
    const slice = identifier.subarray(pos, pos + len.value);
    pos += len.value;
    if (field === 1) {
      if (seenNonce || slice.length === 0) throw new Error('FORWARD_MACAROON_INVALID');
      seenNonce = true;
    } else if (field === 2) {
      if (seenStorageId) throw new Error('FORWARD_MACAROON_INVALID');
      seenStorageId = true;
    } else if (field === 3) {
      ops.push(parseOp(slice));
    } else {
      throw new Error('FORWARD_MACAROON_INVALID');
    }
  }
  if (!seenNonce || ops.length === 0) throw new Error('FORWARD_MACAROON_INVALID');
  return ops;
}

/** Parses libmacaroons v2 binary format with LND v3 MacaroonId protobuf ops. */
export function parseLndMacaroon(bytes: Buffer): ParsedLndMacaroon {
  if (bytes.length < 40 || bytes.length > 65536 || bytes[0] !== 0x02) {
    throw new Error('FORWARD_MACAROON_INVALID');
  }
  let pos = 1;
  let location: string | undefined;
  let identifier: Buffer | undefined;
  let prevHeaderType = 0;
  for (;;) {
    const pkt = readPacketField(bytes, pos);
    pos = pkt.next;
    if (pkt.type === 0) break;
    if (pkt.type <= prevHeaderType) throw new Error('FORWARD_MACAROON_INVALID');
    prevHeaderType = pkt.type;
    if (pkt.type === 1) location = decodeUtf8Strict(pkt.data);
    else if (pkt.type === 2) identifier = pkt.data;
    else throw new Error('FORWARD_MACAROON_INVALID');
  }
  if (!identifier) throw new Error('FORWARD_MACAROON_INVALID');

  let caveatCount = 0;
  for (;;) {
    const first = readPacketField(bytes, pos);
    pos = first.next;
    if (first.type === 0) break;
    let prevCaveatType = 0;
    let hasLocation = false;
    let hasIdentifier = false;
    let hasVid = false;
    let pkt = first;
    for (;;) {
      if (pkt.type <= prevCaveatType) throw new Error('FORWARD_MACAROON_INVALID');
      prevCaveatType = pkt.type;
      if (pkt.type === 1) { decodeUtf8Strict(pkt.data); hasLocation = true; }
      else if (pkt.type === 2) hasIdentifier = true;
      else if (pkt.type === 4) hasVid = true;
      else throw new Error('FORWARD_MACAROON_INVALID');
      const next = readPacketField(bytes, pos);
      pos = next.next;
      if (next.type === 0) break;
      pkt = next;
    }
    if (!hasIdentifier || (hasLocation && !hasVid)) {
      throw new Error('FORWARD_MACAROON_INVALID');
    }
    caveatCount++;
  }

  const sig = readPacketField(bytes, pos);
  if (sig.type !== 6 || sig.data.length !== 32 || sig.next !== bytes.length) {
    throw new Error('FORWARD_MACAROON_INVALID');
  }

  return {
    location,
    ops: parseLndIdentifier(identifier),
    caveatCount,
  };
}

/** Enforces minimum-privilege LND macaroon roles on exact verified bytes; rejects generic offchain:write, admin, and extra permissions. */
export function verifyLndMacaroonRole(bytes: Buffer, role: LndMacaroonRole): void {
  const parsed = parseLndMacaroon(bytes);
  if (parsed.caveatCount !== 0 || parsed.ops.length === 0) {
    throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
  }

  const seenPairs = new Set<string>();
  const entities = new Set<string>();
  const uriActions = new Set<string>();

  for (const op of parsed.ops) {
    if (op.actions.length === 0) throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
    entities.add(op.entity);
    for (const action of op.actions) {
      const pair = `${op.entity}\0${action}`;
      if (seenPairs.has(pair)) throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
      seenPairs.add(pair);
      if (op.entity === 'uri') uriActions.add(action);
    }
  }

  const uriOnly = entities.size === 1 && entities.has('uri');
  if (entities.has('uri') && !uriOnly) {
    throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
  }

  if (role === 'router') {
    if (!uriOnly || uriActions.size !== ROUTER_URI_ACTIONS.size) {
      throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
    }
    for (const required of ROUTER_URI_ACTIONS) {
      if (!uriActions.has(required)) throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
    }
    return;
  }

  if (uriOnly) {
    const requiredUris = role === 'payee-readonly' ? PAYEE_READ_REQUIRED_URIS : PAYER_READ_REQUIRED_URIS;
    for (const required of requiredUris) {
      if (!uriActions.has(required)) throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
    }
    for (const action of uriActions) {
      if (!requiredUris.has(action) && !OPTIONAL_READ_URIS.has(action)) {
        throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
      }
    }
    return;
  }

  if (entities.size !== READONLY_ENTITY_ALLOWLIST.size) {
    throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
  }
  for (const op of parsed.ops) {
    if (!READONLY_ENTITY_ALLOWLIST.has(op.entity) || op.actions.length !== 1 || op.actions[0] !== 'read') {
      throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
    }
  }
  for (const required of READONLY_ENTITY_ALLOWLIST) {
    if (!entities.has(required)) throw new Error('FORWARD_MACAROON_ROLE_REJECTED');
  }
}

export const lndMacaroonRoleSchema = z.enum(['readonly', 'payer-readonly', 'payee-readonly', 'router']);
