// Normalized create-result contract (GDS brief §5 / §7.1).
//
// Autotask create responses vary (`{ itemId }`, `{ item: {...} }`, a bare id).
// The HTTP layer already reduces them to a numeric id; this module turns that id
// into the ONE shape every create tool returns, so n8n/ChatGPT never carry
// per-endpoint `itemId` vs `item` extraction logic:
//
//   { id, entityType, parentType?, parentId?, item? }
//
// Normalization happens once, centrally, in AutotaskToolHandler.callTool — the
// dispatch handlers still return a plain id, and this maps it by tool name.

export interface NormalizedCreateResult {
  id: number;
  entityType: string;
  /** Parent entity for child-route creates (e.g. "Companies" for a Contact). */
  parentType?: string;
  parentId?: number;
  /** Full object when read-after-create is enabled; omitted for a stable id-only result. */
  item?: Record<string, unknown>;
}

export function normalizeCreateResult(
  entityType: string,
  id: number,
  opts?: { parentType?: string; parentId?: number; item?: Record<string, unknown> }
): NormalizedCreateResult {
  const out: NormalizedCreateResult = { id, entityType };
  if (opts?.parentType !== undefined) out.parentType = opts.parentType;
  if (opts?.parentId !== undefined) out.parentId = opts.parentId;
  if (opts?.item !== undefined) out.item = opts.item;
  return out;
}

interface CreateToolMeta {
  entityType: string;
  parentType?: string;
  /**
   * Candidate arg keys that hold the parent id, tried in order (the codebase
   * mixes `companyID`/`companyId` casing). First numeric match wins; if none
   * match, parentId is simply omitted.
   */
  parentIdArgs?: string[];
}

/**
 * Create tools whose numeric result is normalized. Keyed by tool name so the
 * dispatch table stays untouched. New create tools must be added here to get a
 * normalized result (a create tool absent from this map returns its raw id).
 */
export const CREATE_TOOL_META: Record<string, CreateToolMeta> = {
  autotask_create_company: { entityType: 'Companies' },
  autotask_create_contact: { entityType: 'Contacts', parentType: 'Companies', parentIdArgs: ['companyID', 'companyId'] },
  autotask_create_ticket: { entityType: 'Tickets' },
  autotask_create_ticket_charge: { entityType: 'TicketCharges', parentType: 'Tickets', parentIdArgs: ['ticketId', 'ticketID'] },
  autotask_create_service_call: { entityType: 'ServiceCalls' },
  autotask_create_service_call_ticket: { entityType: 'ServiceCallTickets', parentType: 'ServiceCalls', parentIdArgs: ['serviceCallID', 'serviceCallId'] },
  autotask_create_service_call_ticket_resource: { entityType: 'ServiceCallTicketResources', parentType: 'ServiceCallTickets', parentIdArgs: ['serviceCallTicketID', 'serviceCallTicketId'] },
  autotask_create_time_entry: { entityType: 'TimeEntries' },
  autotask_create_project: { entityType: 'Projects' },
  autotask_create_contract: { entityType: 'Contracts' },
  autotask_create_contract_service: { entityType: 'ContractServices' },
  autotask_create_task: { entityType: 'Tasks', parentType: 'Projects', parentIdArgs: ['projectID', 'projectId'] },
  autotask_create_phase: { entityType: 'Phases', parentType: 'Projects', parentIdArgs: ['projectID', 'projectId'] },
  autotask_create_ticket_note: { entityType: 'TicketNotes', parentType: 'Tickets', parentIdArgs: ['ticketId', 'ticketID'] },
  autotask_create_ticket_checklist_item: { entityType: 'TicketChecklistItems', parentType: 'Tickets', parentIdArgs: ['ticketId', 'ticketID'] },
  autotask_create_project_note: { entityType: 'ProjectNotes', parentType: 'Projects', parentIdArgs: ['projectId', 'projectID'] },
  autotask_create_company_note: { entityType: 'CompanyNotes', parentType: 'Companies', parentIdArgs: ['companyId', 'companyID'] },
  autotask_create_ticket_attachment: { entityType: 'TicketAttachments', parentType: 'Tickets', parentIdArgs: ['ticketId', 'ticketID'] },
  autotask_create_expense_report: { entityType: 'ExpenseReports' },
  autotask_create_expense_item: { entityType: 'ExpenseItems', parentType: 'ExpenseReports', parentIdArgs: ['expenseReportId', 'expenseReportID'] },
  autotask_create_quote: { entityType: 'Quotes' },
  autotask_create_opportunity: { entityType: 'Opportunities' },
  autotask_create_quote_item: { entityType: 'QuoteItems', parentType: 'Quotes', parentIdArgs: ['quoteId', 'quoteID'] },
  autotask_create_company_todo: { entityType: 'CompanyToDos', parentType: 'Companies', parentIdArgs: ['companyID', 'companyId'] },
};

/**
 * If `toolName` is a create tool and `result` is a numeric id, return the
 * normalized create result; otherwise return `result` unchanged. This is the
 * single place create ids become the normalized contract.
 */
export function normalizeCreateToolResult(
  toolName: string,
  args: Record<string, any> | undefined,
  result: unknown
): unknown {
  const meta = CREATE_TOOL_META[toolName];
  if (!meta || typeof result !== 'number') return result;

  const opts: { parentType?: string; parentId?: number } = {};
  if (meta.parentType !== undefined) opts.parentType = meta.parentType;
  if (meta.parentIdArgs && args) {
    for (const key of meta.parentIdArgs) {
      const candidate = args[key];
      if (typeof candidate === 'number') {
        opts.parentId = candidate;
        break;
      }
    }
  }
  return normalizeCreateResult(meta.entityType, result, opts);
}
