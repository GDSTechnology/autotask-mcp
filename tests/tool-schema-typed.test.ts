// Every tool input property declares a type. Strict MCP clients (ChatGPT's
// connector) reject a tool whose schema has a property with no type, so a
// single loose `{ description }` can hide that tool from the agent entirely.

import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';

type S = { type?: unknown; anyOf?: unknown; oneOf?: unknown; enum?: unknown; properties?: Record<string, S>; items?: S };

function untyped(s: S | undefined, path = ''): string[] {
  if (!s || typeof s !== 'object') return [];
  const out: string[] = [];
  if (s.type === 'array' && !s.items) out.push(`${path || '(root)'}: array without items`);
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    if (v.type == null && v.anyOf == null && v.oneOf == null && v.enum == null) out.push(`${path}${k}`);
    out.push(...untyped(v, `${path}${k}.`));
    if (v.items) {
      if (v.items.type == null && v.items.anyOf == null && v.items.oneOf == null) out.push(`${path}${k}[]`);
      out.push(...untyped(v.items, `${path}${k}[].`));
    }
  }
  return out;
}

test('every tool input property has a type', () => {
  const bad = TOOL_DEFINITIONS.map((t) => [t.name, untyped(t.inputSchema as S)] as const).filter(([, b]) => b.length);
  expect(bad).toEqual([]);
});
