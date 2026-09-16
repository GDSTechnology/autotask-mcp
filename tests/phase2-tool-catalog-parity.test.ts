// MCP-CORE-003 — tool catalog / registered tool parity.
//
// TOOL_CATEGORIES is hand-maintained and drifts from TOOL_DEFINITIONS with
// nothing enforcing parity, so tools stay registered but unreachable through
// `autotask_list_categories` / `autotask_list_category_tools` — the progressive
// discovery path a client actually browses. At the time this test was written,
// 8 business tools were invisible that way, including `autotask_update_contact`
// and `autotask_find_or_create_contact`.

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';

/**
 * Meta-tools that are deliberately absent from category discovery: the
 * discovery mechanism itself, the router, the generic executor, and the raw
 * escape hatch. Anything else missing is drift, not a decision.
 */
const UNCATEGORIZED_BY_DESIGN = new Set([
  'autotask_list_categories',
  'autotask_list_category_tools',
  'autotask_execute_tool',
  'autotask_router',
  'autotask_raw_request',
]);

const registered = TOOL_DEFINITIONS.map(t => t.name);
const categorized = Object.values(TOOL_CATEGORIES).flatMap(c => c.tools);

describe('MCP-CORE-003 — catalog parity', () => {
  test('every registered business tool is reachable through category discovery', () => {
    const missing = registered
      .filter(n => !UNCATEGORIZED_BY_DESIGN.has(n))
      .filter(n => !categorized.includes(n))
      .sort();
    expect(missing).toEqual([]);
  });

  test('every categorized tool is actually registered', () => {
    const phantom = categorized.filter(n => !registered.includes(n)).sort();
    expect(phantom).toEqual([]);
  });

  test('no tool is listed in two categories', () => {
    const dupes = categorized.filter((n, i) => categorized.indexOf(n) !== i).sort();
    expect([...new Set(dupes)]).toEqual([]);
  });

  test('registered tool names are unique', () => {
    const dupes = registered.filter((n, i) => registered.indexOf(n) !== i).sort();
    expect([...new Set(dupes)]).toEqual([]);
  });

  test('the discovered union equals the registered set minus the meta-tools', () => {
    const expected = registered.filter(n => !UNCATEGORIZED_BY_DESIGN.has(n)).sort();
    expect([...new Set(categorized)].sort()).toEqual(expected);
  });

  test('every category reports a non-empty tool list', () => {
    const empty = Object.entries(TOOL_CATEGORIES).filter(([, c]) => c.tools.length === 0).map(([n]) => n);
    expect(empty).toEqual([]);
  });

  test('every tool exposing `page` also exposes `pageSize`', () => {
    // A `page` with no way to size the window is not a usable pagination contract.
    const offenders = TOOL_DEFINITIONS
      .filter(t => (t.inputSchema as any)?.properties?.page)
      .filter(t => !(t.inputSchema as any)?.properties?.pageSize)
      .map(t => t.name);
    expect(offenders).toEqual([]);
  });
});
