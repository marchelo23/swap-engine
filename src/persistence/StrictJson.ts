/** Rejects invalid UTF-8, duplicate JSON object keys and noncanonical numbers
 * that JSON.stringify cannot round-trip without precision loss. */
export function parseStrictJson(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\]:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === '{') stack.push(new Set());
    else if (value === '[') stack.push(null);
    else if (value === '}' || value === ']') stack.pop();
    else if (value.startsWith('"') && /^\s*:/.test(text.slice(token.index + value.length))) {
      const keys = stack.at(-1);
      const key = JSON.parse(value) as string;
      if (!keys || keys.has(key)) throw new Error('Duplicate JSON key');
      keys.add(key);
    } else if (/^[-0-9]/.test(value) && String(Number(value)) !== value) {
      // Only accept number tokens that JSON.stringify can reproduce exactly.
      throw new Error('Noncanonical JSON number');
    }
  }
  return parsed;
}
