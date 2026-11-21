export const rails = ['onchain', 'lightning', 'liquid'] as const;
export type Rail = typeof rails[number];
export type Side = 'send' | 'receive';
export type Pair = Record<Side, Rail>;
export type Turn = 1 | -1;

export const railLabel: Record<Rail, string> = { onchain: 'On-chain', lightning: 'Lightning', liquid: 'Liquid' };
export const defaultPair: Pair = { send: 'lightning', receive: 'onchain' };

export function stepRail(rail: Rail, turn: Turn) {
  return rails[(rails.indexOf(rail) + turn + rails.length) % rails.length]!;
}

export function linkRail(pair: Pair, side: Side, rail: Rail): Pair {
  const opposite = side === 'send' ? 'receive' : 'send';
  return { ...pair, [side]: rail, [opposite]: rail === pair[opposite] ? stepRail(rail, 1) : pair[opposite] };
}

export function canQuote({ send, receive }: Pair) {
  return send === 'lightning' && receive === 'onchain';
}
