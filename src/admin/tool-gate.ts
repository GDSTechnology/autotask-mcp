// Console-controlled tool switches: "Allow write tools" and "Disabled tool
// groups" (admin/settings.ts). A blocked tool is hidden from tools/list and
// refused at dispatch — including through autotask_execute_tool.

import { TOOL_CATEGORIES, TOOL_DEFINITIONS } from '../handlers/tool.definitions.js';
import { isMutatingTool } from '../utils/idempotency.js';
import { settingValue } from './settings.js';

/** Discovery / routing meta-tools are never switched off — agents need them to see what is available. */
const ALWAYS_ON = new Set(['autotask_list_categories', 'autotask_list_category_tools', 'autotask_execute_tool', 'autotask_router', 'autotask_test_connection', 'autotask_whoami']);

// Name shapes that write even when the name prefix looks like a read
// (e.g. autotask_find_or_create_contact).
const WRITE_VERB = /_(create|update|delete|add|remove|set|log|complete|apply|move|start|close|build|extend|link|assign|approve|post|or_create)(_|$)/;

const readOnlyHint = new Map(TOOL_DEFINITIONS.map((t) => [t.name, !!(t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint]));

const categoriesOf = new Map<string, string[]>();
for (const [cat, { tools }] of Object.entries(TOOL_CATEGORIES)) for (const t of tools) (categoriesOf.get(t) ?? categoriesOf.set(t, []).get(t)!).push(cat);

/** True when a tool can change Autotask data. Errs toward "write": a mislabelled read is merely hidden in read-only mode. */
export function isWriteTool(name: string): boolean {
  if (name === 'autotask_raw_request') return true; // can send any method
  if (READS_DESPITE_NAME.has(name) || readOnlyHint.get(name)) return false;
  return isMutatingTool(name) || WRITE_VERB.test(name.replace(/^autotask/, ''));
}

/** Changes nothing in Autotask (refreshes the local mirror by reading). */
const READS_DESPITE_NAME = new Set(['autotask_shadow_sync']);

/** Why a tool is switched off in the console, or null when it may run. */
export function toolBlockReason(name: string): string | null {
  if (ALWAYS_ON.has(name)) return null;
  if (!settingValue<boolean>('tools.writesEnabled') && isWriteTool(name)) {
    return `${name} is disabled: this MCP is in read-only mode (an administrator turned off write tools in the admin console).`;
  }
  const disabled = settingValue<string[]>('tools.disabledCategories');
  if (disabled.length) {
    const hit = (categoriesOf.get(name) ?? []).find((c) => disabled.includes(c));
    if (hit) return `${name} is disabled: an administrator turned off the "${hit}" tool group in the admin console.`;
  }
  return null;
}

export const toolAllowed = (name: string): boolean => toolBlockReason(name) === null;

export const toolCategoryNames = (): string[] => Object.keys(TOOL_CATEGORIES);
