export const rails = ['onchain', 'lightning', 'liquid', 'ark'] as const;
export type Rail = typeof rails[number];
export type Side = 'send' | 'receive';
export type Pair = Record<Side, Rail>;
export type Turn = 1 | -1;

export const railLabel: Record<Rail, string> = { onchain: 'On-chain', lightning: 'Lightning', liquid: 'Liquid', ark: 'Ark' };
export const defaultPair: Pair = { send: 'lightning', receive: 'onchain' };

export function stepRail(rail: Rail, turn: Turn) {
  return rails[(rails.indexOf(rail) + turn + rails.length) % rails.length]!;
}

export function linkRail(pair: Pair, side: Side, rail: Rail): Pair {
  const opposite = side === 'send' ? 'receive' : 'send';
  // Ark is opt-in: keep the existing Liquid collision fallback to On-chain.
  const fallback = rail === 'liquid' ? 'onchain' : stepRail(rail, 1);
  return { ...pair, [side]: rail, [opposite]: rail === pair[opposite] ? fallback : pair[opposite] };
}

export function isArkOnchainPair({ send, receive }: Pair) {
  return (send === 'onchain' && receive === 'ark') || (send === 'ark' && receive === 'onchain');
}

export function arkRoute({ send, receive }: Pair): 'onchain-to-ark' | 'ark-to-onchain' | undefined {
  if (send === 'onchain' && receive === 'ark') return 'onchain-to-ark';
  if (send === 'ark' && receive === 'onchain') return 'ark-to-onchain';
  return undefined;
}

export function canQuote(pair: Pair) {
  return (pair.send === 'lightning' && pair.receive === 'onchain') || isArkOnchainPair(pair);
}

export function unsupportedRoute({ send, receive }: Pair) {
  if ((send === 'ark' && receive === 'lightning') || (send === 'lightning' && receive === 'ark')) {
    return `${railLabel[send]} → ${railLabel[receive]} unsupported`;
  }
  return 'Route unavailable';
}
