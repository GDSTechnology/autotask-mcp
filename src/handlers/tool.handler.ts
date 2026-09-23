import { Server } from "@modelcontextprotocol/server";

// Autotask Tool Handler
// Handles MCP tool calls for Autotask operations (search, create, update)
import { AutotaskService } from '../services/autotask.service.js';
import { AutotaskRateLimitError } from '../services/autotask-http.js';
import { PicklistCache, PicklistValue } from '../services/picklist.cache.js';
import { Logger } from '../utils/logger.js';
import { formatCompactResponse, detectEntityType, COMPACT_SEARCH_TOOLS, PageMeta } from '../utils/response.formatter.js';
import { PagedResult } from '../types/autotask.js';
import { MappingService } from '../utils/mapping.service.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { normalizeCreateToolResult, CREATE_TOOL_META, NormalizedCreateResult } from '../utils/create-result.js';
import { calculateProjectSchedule } from '../utils/project-schedule.js';
import { generateProjectLaborPlan } from '../utils/project-labor-plan.js';
import { generateSlaFramework } from '../utils/sla-framework.js';
import { extractProjectScope } from '../utils/project-scope.js';
import { computeBomLabor } from '../utils/bom-labor.js';
import { classifyProject } from '../utils/project-classification.js';
import { WEBHOOK_ENTITIES } from '../utils/webhook-entities.js';
import { extractCallerContext, stripCallerContext, CallerContext } from '../types/context.js';
import { emitAudit, AuditEntry } from '../utils/audit.js';
import { AuditSink, createAuditSink } from '../db/audit-sink.js';
import {
  RiskLevel,
  classifyRisk,
  requiresExplicitConfirmation,
  buildConfirmationRequired,
} from '../utils/risk.js';
import { InMemoryIdempotencyStore, deriveIdempotencyKey, isMutatingTool } from '../utils/idempotency.js';
import {
  FunctionalRole,
  parseRoleMap,
  resolveRole,
  evaluatePermission,
  buildPermissionDenied,
  isPermissionsEnabled,
} from '../utils/permissions.js';
import { evaluateRawRequest, buildRawRequestDenied } from '../utils/raw-gate.js';
import {
  CallerResolution,
  ResolvedResource,
  parseUserMap,
  callerMapKeys,
  resourceDisplayName,
  classifyEmailMatch,
  identificationRequired,
  ACTING_RESOURCE_TOOLS,
  ACTING_ROLE_FIELDS,
  CURRENT_USER_DEFAULT_TOOLS,
} from '../utils/caller-resolution.js';
import { TrustedActing } from '../utils/impersonation.js';
import {
  runWithRequestContext,
  getImpersonationMode,
  getRequestOrigin,
  isImpersonationAllowedForSource,
} from '../utils/request-context.js';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from './tool.definitions.js';
import { buildTicketCard } from './card.builder.js';

// Default concurrency for company/resource name enrichment. Autotask allows
// only a handful of concurrent API threads per integration, so enrichment is
// fanned out in small batches rather than all at once (see enhanceItems).
const DEFAULT_ENHANCE_CONCURRENCY = 3;

function resolveEnhanceConcurrency(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_ENHANCE_CONCURRENCY;
}

// Fields accepted by autotask_create_ticket / autotask_update_ticket.
// Keep this list in sync with the tool definitions in tool.definitions.ts.
const TICKET_WRITABLE_FIELDS = [
  'companyID',
  'title',
  'description',
  'status',
  'priority',
  'assignedResourceID',
  // Autotask requires the primary resource and its role together — omitting
  // assignedResourceRoleID from this allowlist silently dropped the role from
  // the typed payload, so assignment updates failed while a raw PATCH carrying
  // both fields succeeded (brief §4.4).
  'assignedResourceRoleID',
  'contactID',
  'queueID',
  'ticketCategory',
  'ticketType',
  'issueType',
  'subIssueType',
  'source',
  'billingCodeID',
  'serviceLevelAgreementID',
  'estimatedHours',
  'projectID',
  'ticketAdditionalContacts',
  'resolution',
  'userDefinedFields',
  // §4.5: complete a ticket in one create call (a 2nd update retriggers
  // "Created, Edited" workflow rules). companyLocationID pairs with companyID.
  'dueDateTime',
  'companyLocationID',
  'configurationItemID',
  // §7: contract/service linkage + idempotency + problem-ticket grouping. All
  // verified writable on the live Tickets schema.
  'contractID',
  'contractServiceID',
  'contractServiceBundleID',
  'externalID',
  'problemTicketId'
] as const;

function buildTicketPayload(args: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const field of TICKET_WRITABLE_FIELDS) {
    if (args[field] !== undefined) {
      payload[field] = args[field];
    }
  }
  return payload;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    // Literal 'object' (not string): the v2 SDK's tools/list result type
    // requires the JSON Schema type discriminant as a literal.
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** MCP Apps (SEP-1865) metadata, e.g. `ui/resourceUri` linking a ui:// card. */
  _meta?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export class AutotaskToolHandler {
  protected autotaskService: AutotaskService;
  protected logger: Logger;
  protected picklistCache: PicklistCache;
  protected mcpServer: Server | null = null;
  private mappingService: MappingService | null = null;
  private lazyLoading: boolean;
  private enhanceConcurrency: number;
  // Caller→resource mapping (§4.1): a static override map for non-email identities
  // and an in-memory cache of resolutions so a caller is only prompted once.
  private userMap = parseUserMap(process.env.AUTOTASK_USER_MAP);
  private resourceCache = new Map<string, ResolvedResource>();
  // Per-tool risk level (§4.3), derived once from the tool annotations + the
  // financial/inventory registries. Drives the confirmation gate in callTool.
  private toolRisk = new Map<string, RiskLevel>(
    TOOL_DEFINITIONS.map((d) => [d.name, classifyRisk(d.name, d.annotations)])
  );
  // Idempotency store (§4.4): replays the prior result for a repeated mutation.
  private idempotencyStore = new InMemoryIdempotencyStore<McpToolResult>();
  // Optional PG audit sink (§23): persists audit records when MCP_PG_AUDIT_ENABLED.
  // Null when disabled — the structured log is always emitted regardless.
  // Assigned in the constructor (needs this.logger).
  private auditSink: AuditSink | null = null;
  // Caller → functional role (§4.2), for the permission gate. Config-driven for
  // now; disabled unless MCP_PERMISSIONS_ENABLED=true.
  private roleMap = parseRoleMap(process.env.AUTOTASK_ROLE_MAP);

  constructor(autotaskService: AutotaskService, logger: Logger, lazyLoading = false) {
    this.autotaskService = autotaskService;
    this.logger = logger;
    this.lazyLoading = lazyLoading;
    this.auditSink = createAuditSink(logger);
    this.enhanceConcurrency = resolveEnhanceConcurrency(process.env.AUTOTASK_ENHANCE_CONCURRENCY);
    this.picklistCache = new PicklistCache(
      logger,
      (entityType) => this.autotaskService.getFieldInfo(entityType)
    );
  }

  private async getMappingService(): Promise<MappingService> {
    if (!this.mappingService) {
      // Per-toolHandler MappingService instance. In gateway mode this
      // toolHandler is created per-request (see McpServer.buildPerRequestHandlers),
      // so each tenant gets a MappingService bound to its own AutotaskService —
      // company/resource caches cannot leak across tenants. The tenantKey
      // lets same-tenant instances share warmed cache DATA across requests
      // (keyed by credential, so isolation still holds) — without it, every
      // request re-walked the tenant's full company list, stalling responses
      // past the gateway timeout on large tenants.
      this.mappingService = await MappingService.create(this.autotaskService, this.logger, {
        lazyLoading: this.lazyLoading,
        tenantKey: this.autotaskService.getTenantKey() ?? undefined,
      });
    }
    return this.mappingService;
  }

  /**
   * Enhance items by inlining company/resource names from IDs
   */
  private async enhanceItems(items: any[]): Promise<any[]> {
    try {
      const mappingService = await this.getMappingService();
      // Bound the fan-out: one item may trigger up to a few Autotask API
      // calls (company + resource names), and Autotask 429s past its
      // concurrent-thread limit. mapWithConcurrency keeps us under it so
      // every row's names resolve instead of most of them being dropped.
      const enhanced = await mapWithConcurrency(
        items,
        this.enhanceConcurrency,
        async (item) => {
          const result = { ...item };
          if (item.companyID != null && typeof item.companyID === 'number') {
            try {
              const name = await mappingService.getCompanyName(item.companyID);
              if (name) result.company = name;
            } catch { /* skip */ }
          }
          if (item.assignedResourceID != null && typeof item.assignedResourceID === 'number') {
            try {
              const name = await mappingService.getResourceName(item.assignedResourceID);
              if (name) result.assignedTo = name;
            } catch { /* skip */ }
          }
          if (item.projectLeadResourceID != null && typeof item.projectLeadResourceID === 'number') {
            try {
              const name = await mappingService.getResourceName(item.projectLeadResourceID);
              if (name) result.lead = name;
            } catch { /* skip */ }
          }
          return result;
        }
      );
      return enhanced
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map(r => r.value);
    } catch (error) {
      this.logger.debug('Enhancement failed, returning original items:', error);
      return items;
    }
  }

  /**
   * Set the MCP server reference for elicitation support
   */
  setServer(server: Server): void {
    this.mcpServer = server;
  }

  /**
   * Trusted acting identity from a gateway header (#42). Set ONLY on a
   * per-request, gateway-mode handler after the S2S gate — never on the shared
   * env-mode handler — so it can't leak across requests.
   */
  private trustedActing: TrustedActing | undefined;
  setTrustedActingContext(acting: TrustedActing | undefined): void {
    this.trustedActing = acting;
  }

  /**
   * Elicit user input for a selection from picklist values.
   * Falls back to returning null if elicitation is not supported by the client.
   */
  protected async elicitSelection(
    message: string,
    fieldName: string,
    options: PicklistValue[]
  ): Promise<string | null> {
    if (!this.mcpServer) return null;

    try {
      const result = await this.mcpServer.elicitInput({
        message,
        requestedSchema: {
          type: 'object' as const,
          properties: {
            [fieldName]: {
              type: 'string' as const,
              title: fieldName,
              description: `Select a ${fieldName}`,
              enum: options.map(o => o.value),
              enumNames: options.map(o => o.label),
            }
          },
          required: [fieldName],
        }
      });

      if (result.action === 'accept' && result.content) {
        return result.content[fieldName] as string;
      }
      return null;
    } catch (error) {
      // Client likely doesn't support elicitation — not an error
      this.logger.debug(`Elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a date range filter when no filters are provided for ticket search.
   * Returns date filter params or null if elicitation is not available/dismissed.
   * Times out after 5 seconds to avoid blocking in non-interactive environments.
   */
  protected async elicitDateRange(): Promise<Record<string, string> | null> {
    if (!this.mcpServer) return null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('elicitation timeout')), 5000)
      );
      const result = await Promise.race([this.mcpServer.elicitInput({
        message: 'No filters specified. What date range would you like to search?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            dateRange: {
              type: 'string' as const,
              title: 'Date Range',
              description: 'How far back to search',
              enum: ['today', 'past_week', 'past_month', 'past_quarter', 'all'],
              enumNames: ['Today', 'Past Week', 'Past Month', 'Past Quarter', 'All Time'],
            }
          },
          required: ['dateRange'],
        }
      }), timeoutPromise]);

      if (result.action === 'accept' && result.content) {
        const range = result.content.dateRange as string;
        const now = new Date();
        let createdAfter: string | undefined;

        switch (range) {
          case 'today':
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_week':
            now.setDate(now.getDate() - 7);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_month':
            now.setMonth(now.getMonth() - 1);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_quarter':
            now.setMonth(now.getMonth() - 3);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'all':
          default:
            return null; // No date filter
        }

        if (createdAfter) {
          return { createdAfter };
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Date range elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a company name and resolve it to a companyId.
   * Returns the selected companyId or null if elicitation is unavailable/dismissed.
   */
  protected async elicitCompanyId(): Promise<number | null> {
    if (!this.mcpServer) return null;

    try {
      // First, ask for the company name
      const nameResult = await this.mcpServer.elicitInput({
        message: 'No company specified. What company is this quote for?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            companyName: {
              type: 'string' as const,
              title: 'Company Name',
              description: 'Enter the company name to search for',
            }
          },
          required: ['companyName'],
        }
      });

      if (nameResult.action !== 'accept' || !nameResult.content?.companyName) {
        return null;
      }

      const searchTerm = nameResult.content.companyName as string;
      const { items: companies } = await this.autotaskService.searchCompanies({ searchTerm });

      if (companies.length === 0) {
        this.logger.debug(`No companies found matching "${searchTerm}"`);
        return null;
      }

      if (companies.length === 1 && companies[0].id) {
        return companies[0].id;
      }

      // Multiple results — let user pick
      const options: PicklistValue[] = companies
        .filter(c => c.id != null)
        .map(c => ({
          value: String(c.id),
          label: c.companyName || `Company #${c.id}`,
        }));

      const selected = await this.elicitSelection(
        `Found ${companies.length} companies matching "${searchTerm}". Which one?`,
        'companyId',
        options
      );

      return selected ? Number(selected) : null;
    } catch (error) {
      this.logger.debug(`Company elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Ask the caller for their Autotask username/email and resolve it to a
   * resource, binding it to this connection (#42). Used when the connecting app
   * didn't identify the user. Returns the resolution, or null if the client
   * can't be prompted or the caller declines (caller then falls back to the
   * identification_required response). Resolving via `resolveCaller` with an
   * explicit email/name caches the result under the caller's connection keys,
   * so subsequent calls skip the prompt.
   */
  protected async elicitAutotaskIdentity(ctx: CallerContext): Promise<CallerResolution | null> {
    if (!this.mcpServer) return null;
    try {
      const res = await this.mcpServer.elicitInput({
        message: 'To act on your behalf in Autotask, what is your Autotask username (login email)?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            autotaskUsername: {
              type: 'string' as const,
              title: 'Autotask username / email',
              description: 'Your Autotask login email (e.g. jane.doe@example.com)',
            },
          },
          required: ['autotaskUsername'],
        },
      });
      if (res.action !== 'accept' || !res.content?.autotaskUsername) return null;
      const value = String(res.content.autotaskUsername).trim();
      if (!value) return null;
      // An "@" means an email (matched against Resources); otherwise treat as a name.
      return value.includes('@')
        ? await this.resolveCaller(ctx, { resourceEmail: value })
        : await this.resolveCaller(ctx, { resourceName: value });
    } catch (error) {
      this.logger.debug(`Identity elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a service or product selection when creating a quote item without explicit IDs.
   * Searches both services and products by name, presents a combined list.
   * Returns { serviceID, productID } or null.
   */
  protected async elicitItemSelection(
    name: string
  ): Promise<{ serviceID?: number; productID?: number } | null> {
    if (!this.mcpServer) return null;

    try {
      const [services, products] = await Promise.all([
        this.autotaskService.searchServices({ searchTerm: name, isActive: true }),
        this.autotaskService.searchProducts({ searchTerm: name, isActive: true }),
      ]);

      const options: PicklistValue[] = [];

      for (const svc of services) {
        if (svc.id == null) continue;
        const price = svc.unitPrice != null ? ` ($${svc.unitPrice.toFixed(2)})` : '';
        options.push({
          value: `service:${svc.id}`,
          label: `Service: ${svc.name || `#${svc.id}`}${price}`,
        });
      }

      for (const prod of products) {
        if (prod.id == null) continue;
        const price = prod.unitPrice != null ? ` ($${prod.unitPrice.toFixed(2)})` : '';
        options.push({
          value: `product:${prod.id}`,
          label: `Product: ${prod.name || `#${prod.id}`}${price}`,
        });
      }

      if (options.length === 0) return null;

      const selected = await this.elicitSelection(
        `Found ${options.length} services/products matching "${name}". Which one should be used for this quote item?`,
        'itemSelection',
        options
      );

      if (!selected) return null;

      const [type, idStr] = selected.split(':');
      const id = Number(idStr);
      if (type === 'service') return { serviceID: id };
      if (type === 'product') return { productID: id };
      return null;
    } catch (error) {
      this.logger.debug(`Item elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Route a natural-language intent to the best matching tool with pre-filled parameters.
   */
  private routeIntent(rawIntent: string): {
    suggestedTool: string;
    suggestedParams: Record<string, any>;
    description: string;
    requiredParams: string[];
  } {
    // Extract quoted strings from original (preserves case) before lowercasing
    const quotedStrings = rawIntent.match(/["']([^"']+)["']/g)?.map(s => s.slice(1, -1)) || [];
    const intent = rawIntent.toLowerCase();

    // Extract potential IDs from the intent
    const numbers = intent.match(/\b\d+\b/g)?.map(Number) || [];

    // Extract hours pattern (e.g., "2 hours", "1.5 hrs")
    const hoursMatch = intent.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i);
    const hours = hoursMatch ? parseFloat(hoursMatch[1]) : undefined;

    // Decision tree based on keyword matching

    // Company To-Do (CRM calendar follow-up) — check BEFORE time tracking so a
    // "sales follow-up To-Do" is not misrouted to a time entry (§4.10). A
    // To-Do is distinct from an appointment, service call, checklist item,
    // project task, and time entry.
    if (/\b(?:to-?dos?|follow[-\s]?ups?)\b/.test(intent)) {
      const ticketIdMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
      if (/\b(?:create|add|new|schedule|set|make|put)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (ticketIdMatch) params.ticketID = parseInt(ticketIdMatch[1]);
        if (quotedStrings[0]) params.activityDescription = quotedStrings[0];
        if (/\bsales\b/.test(intent)) params.actionTypeName = 'Sales';
        else if (/\bmeeting\b/.test(intent)) params.actionTypeName = 'Meeting';
        else if (/\b(?:phone|call)\b/.test(intent)) params.actionTypeName = 'Phone Call';
        return {
          suggestedTool: 'autotask_create_company_todo',
          suggestedParams: params,
          description: 'Create a Company To-Do (CRM calendar follow-up)',
          requiredParams: ['companyID', 'assignedToResourceID', 'startDateTime', 'endDateTime'],
        };
      }
      const params: Record<string, any> = {};
      if (ticketIdMatch) params.ticketID = parseInt(ticketIdMatch[1]);
      return {
        suggestedTool: 'autotask_search_company_todos',
        suggestedParams: params,
        description: 'Search Company To-Dos (CRM calendar follow-ups)',
        requiredParams: [],
      };
    }

    // Time tracking (check BEFORE tickets — "log hours on ticket" should route here, not to tickets)
    if (/\b(?:hours?|hrs?)\b/.test(intent) && /\b(?:log|enter|add|record|track|create)\b/.test(intent)) {
      const params: Record<string, any> = {};
      if (hours) params.hoursWorked = hours;
      // Look for ticket ID pattern
      const ticketIdMatch = intent.match(/ticket\s*#?\s*(\d+)/i) || intent.match(/on\s+(\d+)/);
      if (ticketIdMatch) params.ticketID = parseInt(ticketIdMatch[1]);
      else if (numbers[0] && !hours) params.ticketID = numbers[0];
      else if (numbers.length > 1) params.ticketID = numbers.find(n => n > 100) || numbers[1]; // larger numbers are likely ticket IDs
      return {
        suggestedTool: 'autotask_create_time_entry',
        suggestedParams: params,
        description: 'Log a time entry',
        requiredParams: [...(!params.ticketID ? ['ticketID'] : []), ...(!params.hoursWorked ? ['hoursWorked'] : [])],
      };
    }

    // Ticket operations
    if (/\b(?:tickets?|issues?|requests?)\b/.test(intent)) {
      if (/\b(?:create|open|new|submit)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0]) params.companyId = numbers[0];
        if (quotedStrings[0]) params.title = quotedStrings[0];
        return {
          suggestedTool: 'autotask_create_ticket',
          suggestedParams: params,
          description: 'Create a new service ticket',
          requiredParams: [...(!params.companyId ? ['companyId'] : []), ...(!params.title ? ['title'] : [])],
        };
      }
      if (/\b(?:update|change|modify|edit|assign|reassign|close)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0]) params.ticketId = numbers[0];
        return {
          suggestedTool: 'autotask_update_ticket',
          suggestedParams: params,
          description: 'Update an existing ticket',
          requiredParams: !params.ticketId ? ['ticketId'] : [],
        };
      }
      if (/\b(?:details?|info|view|show|get)\b/.test(intent) && numbers[0]) {
        return {
          suggestedTool: 'autotask_get_ticket_details',
          suggestedParams: { ticketID: numbers[0], fullDetails: true },
          description: 'Get full ticket details by ID',
          requiredParams: [],
        };
      }
      if (/\b(?:notes?|comments?)\b/.test(intent)) {
        if (/\b(?:add|create|post)\b/.test(intent)) {
          const params: Record<string, any> = {};
          if (numbers[0]) params.ticketId = numbers[0];
          return {
            suggestedTool: 'autotask_create_ticket_note',
            suggestedParams: params,
            description: 'Add a note to a ticket',
            requiredParams: [...(!params.ticketId ? ['ticketId'] : []), 'title', 'description'],
          };
        }
        const params: Record<string, any> = {};
        if (numbers[0]) params.ticketId = numbers[0];
        return {
          suggestedTool: 'autotask_search_ticket_notes',
          suggestedParams: params,
          description: 'List notes on a ticket',
          requiredParams: !params.ticketId ? ['ticketId'] : [],
        };
      }
      // Default: search tickets
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      else if (/for\s+(\w[\w\s]*?)(?:\.|$|,)/i.test(intent)) {
        const match = intent.match(/for\s+(\w[\w\s]*?)(?:\.|$|,)/i);
        if (match) params.searchTerm = match[1].trim();
      }
      if (numbers[0]) params.companyID = numbers[0];
      return {
        suggestedTool: 'autotask_search_tickets',
        suggestedParams: params,
        description: 'Search for tickets',
        requiredParams: [],
      };
    }

    // Quote operations (check before company — "quote for client" should match quote, not company)
    if (/\b(?:quotes?|proposals?|estimates?)\b/.test(intent)) {
      if (/\b(?:item|line|add.*to)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0]) params.quoteId = numbers[0];
        return {
          suggestedTool: 'autotask_create_quote_item',
          suggestedParams: params,
          description: 'Add a line item to a quote',
          requiredParams: [...(!params.quoteId ? ['quoteId'] : []), 'name', 'quantity', 'unitPrice'],
        };
      }
      if (/\b(?:create|new|build)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (quotedStrings[0]) params.name = quotedStrings[0];
        return {
          suggestedTool: 'autotask_create_quote',
          suggestedParams: params,
          description: 'Create a new quote',
          requiredParams: [...(!params.name ? ['name'] : []), 'companyId'],
        };
      }
      const params: Record<string, any> = {};
      if (numbers[0]) params.quoteId = numbers[0];
      return {
        suggestedTool: numbers[0] ? 'autotask_get_quote' : 'autotask_search_quotes',
        suggestedParams: params,
        description: numbers[0] ? 'Get quote details' : 'Search for quotes',
        requiredParams: [],
      };
    }

    // Company operations
    if (/\b(?:company|companies|organization|client|account)\b/.test(intent)) {
      if (/\b(?:create|new|add)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (quotedStrings[0]) params.companyName = quotedStrings[0];
        return {
          suggestedTool: 'autotask_create_company',
          suggestedParams: params,
          description: 'Create a new company',
          requiredParams: !params.companyName ? ['companyName'] : [],
        };
      }
      if (/\b(?:update|edit|modify)\b/.test(intent)) {
        const params: Record<string, any> = {};
        if (numbers[0]) params.id = numbers[0];
        return {
          suggestedTool: 'autotask_update_company',
          suggestedParams: params,
          description: 'Update company details',
          requiredParams: !params.id ? ['id'] : [],
        };
      }
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_companies',
        suggestedParams: params,
        description: 'Search for companies',
        requiredParams: [],
      };
    }

    // Contact operations
    if (/\b(?:contacts?|person|people)\b/.test(intent)) {
      if (/\b(?:create|new|add)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_create_contact',
          suggestedParams: {},
          description: 'Create a new contact',
          requiredParams: ['firstName', 'lastName', 'companyID'],
        };
      }
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_contacts',
        suggestedParams: params,
        description: 'Search for contacts',
        requiredParams: [],
      };
    }

    // Project operations
    if (/\b(?:projects?)\b/.test(intent)) {
      if (/\b(?:create|new)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_create_project',
          suggestedParams: {},
          description: 'Create a new project',
          requiredParams: ['projectName', 'companyID'],
        };
      }
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_projects',
        suggestedParams: params,
        description: 'Search for projects',
        requiredParams: [],
      };
    }

    // Resource operations
    if (/\b(?:resource|technician|tech|engineer|staff)\b/.test(intent)) {
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_resources',
        suggestedParams: params,
        description: 'Search for resources/technicians',
        requiredParams: [],
      };
    }

    // Expense operations
    if (/\b(?:expense|receipt)\b/.test(intent)) {
      if (/\b(?:create|new|submit)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_create_expense_report',
          suggestedParams: {},
          description: 'Create an expense report',
          requiredParams: ['name', 'submitterId', 'weekEndingDate'],
        };
      }
      return {
        suggestedTool: 'autotask_search_expense_reports',
        suggestedParams: {},
        description: 'Search expense reports',
        requiredParams: [],
      };
    }

    // Configuration items / assets
    if (/\b(?:config|asset|device|hardware|ci)\b/.test(intent)) {
      const params: Record<string, any> = {};
      if (quotedStrings[0]) params.searchTerm = quotedStrings[0];
      return {
        suggestedTool: 'autotask_search_configuration_items',
        suggestedParams: params,
        description: 'Search configuration items/assets',
        requiredParams: [],
      };
    }

    // Product/service catalog
    if (/\b(?:product|service|bundle|catalog)\b/.test(intent)) {
      if (/\b(?:bundle)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_search_service_bundles',
          suggestedParams: {},
          description: 'Search service bundles',
          requiredParams: [],
        };
      }
      if (/\b(?:service)\b/.test(intent)) {
        return {
          suggestedTool: 'autotask_search_services',
          suggestedParams: {},
          description: 'Search services',
          requiredParams: [],
        };
      }
      return {
        suggestedTool: 'autotask_search_products',
        suggestedParams: {},
        description: 'Search products',
        requiredParams: [],
      };
    }

    // Charge operations
    if (/\b(?:charges?|material|cost)\b/.test(intent) && /\b(?:ticket|bill)\b/.test(intent)) {
      if (/\b(?:create|add|new)\b/.test(intent)) {
        const params: Record<string, any> = {};
        const ticketMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
        if (ticketMatch) params.ticketID = parseInt(ticketMatch[1]);
        else if (numbers[0]) params.ticketID = numbers[0];
        return {
          suggestedTool: 'autotask_create_ticket_charge',
          suggestedParams: params,
          description: 'Create a ticket charge',
          requiredParams: [...(!params.ticketID ? ['ticketID'] : []), 'name', 'chargeType'],
        };
      }
      if (/\b(?:delete|remove)\b/.test(intent) && numbers[0]) {
        const deleteParams: Record<string, any> = { chargeId: numbers[0] };
        const ticketDeleteMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
        if (ticketDeleteMatch) deleteParams.ticketId = parseInt(ticketDeleteMatch[1]);
        else if (numbers[1]) deleteParams.ticketId = numbers[1];
        return {
          suggestedTool: 'autotask_delete_ticket_charge',
          suggestedParams: deleteParams,
          description: 'Delete a ticket charge',
          requiredParams: [...(!deleteParams.ticketId ? ['ticketId'] : [])],
        };
      }
      const params: Record<string, any> = {};
      const ticketMatch = intent.match(/ticket\s*#?\s*(\d+)/i);
      if (ticketMatch) params.ticketId = parseInt(ticketMatch[1]);
      else if (numbers[0]) params.ticketId = numbers[0];
      return {
        suggestedTool: 'autotask_search_ticket_charges',
        suggestedParams: params,
        description: 'Search ticket charges',
        requiredParams: [],
      };
    }

    // Contract operations
    if (/\b(?:contract|agreement)s?\b/.test(intent) && /expir|renew|laps/.test(intent)) {
      return {
        suggestedTool: 'autotask_list_expiring_contracts',
        suggestedParams: {},
        description: 'List contracts expiring soon (or already expired)',
        requiredParams: [],
      };
    }
    if (/\b(?:contract|agreement)s?\b/.test(intent)) {
      return {
        suggestedTool: 'autotask_search_contracts',
        suggestedParams: {},
        description: 'Search contracts',
        requiredParams: [],
      };
    }

    // Invoice operations
    if (/\b(?:invoice|bill|billing)\b/.test(intent)) {
      return {
        suggestedTool: 'autotask_search_invoices',
        suggestedParams: {},
        description: 'Search invoices',
        requiredParams: [],
      };
    }

    // Field info / picklist
    if (/\b(?:field|picklist|dropdown|options)\b/.test(intent)) {
      const entityMatch = intent.match(/(?:for|on|of)\s+(\w+)/i);
      return {
        suggestedTool: 'autotask_get_field_info',
        suggestedParams: entityMatch ? { entityType: entityMatch[1] } : {},
        description: 'Get field definitions and picklist values',
        requiredParams: entityMatch ? [] : ['entityType'],
      };
    }

    // Queue / status / priority lookups
    if (/\b(?:queue|status|statuses|priorit)\b/.test(intent)) {
      if (/\bqueue\b/.test(intent)) return { suggestedTool: 'autotask_list_queues', suggestedParams: {}, description: 'List ticket queues', requiredParams: [] };
      if (/\bstatus\b/.test(intent)) return { suggestedTool: 'autotask_list_ticket_statuses', suggestedParams: {}, description: 'List ticket statuses', requiredParams: [] };
      return { suggestedTool: 'autotask_list_ticket_priorities', suggestedParams: {}, description: 'List ticket priorities', requiredParams: [] };
    }

    // Connection test
    if (/\b(?:test|connect|connection|ping|health)\b/.test(intent)) {
      return {
        suggestedTool: 'autotask_test_connection',
        suggestedParams: {},
        description: 'Test API connection',
        requiredParams: [],
      };
    }

    // Fallback: suggest list_categories
    return {
      suggestedTool: 'autotask_list_categories',
      suggestedParams: {},
      description: 'Could not determine intent. Use autotask_list_categories to discover available tool categories.',
      requiredParams: [],
    };
  }

  /**
   * List all available tools
   */
  async listTools(): Promise<McpTool[]> {
    if (this.lazyLoading) {
      // In lazy loading mode, only expose the 3 meta-tools
      const metaTools = TOOL_DEFINITIONS.filter(t =>
        t.name === 'autotask_list_categories' ||
        t.name === 'autotask_list_category_tools' ||
        t.name === 'autotask_execute_tool' ||
        t.name === 'autotask_router'
      );
      this.logger.debug(`Lazy loading mode: exposing ${metaTools.length} meta-tools (${TOOL_DEFINITIONS.length} total available)`);
      return metaTools;
    }
    this.logger.debug(`Listed ${TOOL_DEFINITIONS.length} available tools`);
    return TOOL_DEFINITIONS;
  }

  /**
   * Dispatch table: maps tool names to handler functions
   */
  private getDispatchTable(): Map<string, (args: any, ctx: CallerContext) => Promise<{ result: any; message: string; pagination?: PageMeta }>> {
    const s = this.autotaskService;
    type H = (args: any, ctx: CallerContext) => Promise<{ result: any; message: string; pagination?: PageMeta }>;
    // Search tools return a PagedResult; unwrap it into the array callers expect
    // and carry the honest `hasMore` alongside, so the response formatter reports
    // real pagination state instead of guessing from `items.length >= pageSize`.
    const paged = <T>(p: PagedResult<T>, noun: string) => ({
      result: p.items,
      message: `Found ${p.items.length} ${noun}`,
      pagination: { page: p.page, pageSize: p.pageSize, hasMore: p.hasMore },
    });
    return new Map<string, H>([
      // Connection
      ['autotask_test_connection', async () => {
        const ok = await s.testConnection();
        if (!ok) {
          throw new Error('Connection to Autotask API failed. Verify AUTOTASK_USERNAME, AUTOTASK_SECRET, and AUTOTASK_INTEGRATION_CODE are configured correctly and that the API user has at least read access to Companies.');
        }
        return { result: { success: true }, message: 'Successfully connected to Autotask API' };
      }],

      // Identity: resolve the caller to an Autotask resource (§4.1)
      ['autotask_whoami', async (a, ctx) => {
        const r = await this.resolveCaller(ctx, {
          resourceId: a.resourceId,
          resourceEmail: a.resourceEmail,
          resourceName: a.resourceName,
        });
        const message =
          r.status === 'resolved'
            ? `You are ${r.resource.name} (Autotask resource ${r.resource.id}), resolved via ${r.via}.`
            : r.message;
        return { result: r, message };
      }],

      // Companies
      ['autotask_search_companies', async (a) => {
        return paged(await s.searchCompanies(a), 'companies');
      }],
      ['autotask_create_company', async (a) => {
        const id = await s.createCompany(a); return { result: id, message: `Successfully created company with ID: ${id}` };
      }],
      ['autotask_update_company', async (a) => {
        await s.updateCompany(a.id, a); return { result: undefined, message: `Successfully updated company ID: ${a.id}` };
      }],
      ['autotask_get_company_site_configuration', async (a) => {
        const r = await s.getCompanySiteConfigurations(a.companyId);
        return { result: r, message: `Found ${r.length} site configuration record(s) for company ${a.companyId}` };
      }],
      ['autotask_update_company_site_configuration', async (a) => {
        await s.updateCompanySiteConfiguration(a.id, a.updates || {});
        return { result: undefined, message: `Successfully updated company site configuration ID: ${a.id}` };
      }],

      // Contacts
      ['autotask_search_contacts', async (a) => {
        return paged(await s.searchContacts(a), 'contacts');
      }],
      ['autotask_create_contact', async (a) => {
        const id = await s.createContact(a); return { result: id, message: `Successfully created contact with ID: ${id}` };
      }],
      ['autotask_find_or_create_contact', async (a) => {
        const { companyID, ...rest } = a;
        const r = await s.findOrCreateContact(companyID, rest);
        return { result: r, message: r.created ? `Created contact ${r.id}` : `Found existing contact ${r.id}` };
      }],
      ['autotask_update_contact', async (a) => {
        await s.updateContact(a.id, a); return { result: undefined, message: `Successfully updated contact ID: ${a.id}` };
      }],

      // Tickets
      ['autotask_search_tickets', async (a) => {
        // Elicitation for zero-filter ticket searches
        const hasFilters = a.searchTerm || a.companyID || a.contactID || a.status !== undefined ||
          a.priority !== undefined || a.queueID !== undefined ||
          a.assignedResourceID || a.unassigned || a.createdAfter || a.createdBefore || a.lastActivityAfter ||
          a.externalID;
        if (!hasFilters && this.mcpServer) {
          const dateChoice = await this.elicitDateRange();
          if (dateChoice) a = { ...a, ...dateChoice };
        }
        const { companyID, ...rest } = a;
        const opts = { ...rest, ...(companyID !== undefined && { companyId: companyID }) };
        return paged(await s.searchTickets(opts), 'tickets');
      }],
      ['autotask_get_ticket_details', async (a) => {
        const r = await s.getTicket(a.ticketID, a.fullDetails); return { result: r, message: 'Ticket details retrieved successfully' };
      }],
      ['autotask_create_ticket', async (a) => {
        const payload = buildTicketPayload(a);
        const additional: number[] = Array.isArray(a.additionalConfigurationItemIDs)
          ? a.additionalConfigurationItemIDs.filter((n: unknown) => typeof n === 'number')
          : [];
        if (additional.length > 0) {
          // §7 convenience: create → link additional CIs → read back → enriched.
          const r = await s.createTicketWithConfigurationItems(payload, additional);
          const linked = r.additionalConfigurationItems.length;
          const failed = r.linkErrors.length;
          return {
            result: r,
            message: `Created ticket ${r.id}; linked ${linked} additional CI(s)` + (failed ? `, ${failed} failed` : ''),
          };
        }
        const id = await s.createTicket(payload);
        return { result: id, message: `Successfully created ticket with ID: ${id}` };
      }],
      ['autotask_update_ticket', async (a) => {
        const { ticketId, ...rest } = a;
        const payload = buildTicketPayload(rest);
        await s.updateTicket(ticketId, payload);
        return { result: ticketId, message: `Successfully updated ticket ${ticketId}` };
      }],
      ['autotask_move_ticket_to_company', async (a) => {
        const r = await s.moveTicketToCompany(a.ticketId, a.companyID, { contactID: a.contactID, force: a.force });
        return { result: r, message: (r.message as string) ?? `Ticket ${a.ticketId} move result: ${r.status}` };
      }],
      ['autotask_find_ticket_by_external_id', async (a) => {
        const r = await s.findTicketByExternalId(a.externalID);
        return { result: r, message: r.length ? `Found ${r.length} ticket(s) with externalID "${a.externalID}"` : `No ticket found with externalID "${a.externalID}"` };
      }],
      // TicketAdditionalConfigurationItems (§8)
      ['autotask_search_ticket_configuration_items', async (a) => {
        const r = await s.searchTicketConfigurationItems(a.ticketID, a.configurationItemID);
        return { result: r, message: `Found ${r.length} additional configuration item(s) on ticket ${a.ticketID}` };
      }],
      ['autotask_add_ticket_configuration_item', async (a) => {
        const id = await s.addTicketConfigurationItem(a.ticketID, a.configurationItemID);
        return { result: id, message: `Linked CI ${a.configurationItemID} to ticket ${a.ticketID} (association ${id})` };
      }],
      ['autotask_remove_ticket_configuration_item', async (a) => {
        await s.removeTicketConfigurationItem(a.associationID);
        return { result: a.associationID, message: `Removed ticket additional-CI association ${a.associationID}` };
      }],
      // Ticket Charges
      ['autotask_get_ticket_charge', async (a) => {
        const r = await s.getTicketCharge(a.chargeId);
        if (!r) return { result: null, message: `No ticket charge found with ID ${a.chargeId}` };
        return { result: r, message: 'Ticket charge retrieved successfully' };
      }],
      ['autotask_search_ticket_charges', async (a) => {
        const r = await s.searchTicketCharges(a);
        return { result: r, message: `Found ${r.length} ticket charges` };
      }],
      ['autotask_create_ticket_charge', async (a) => {
        const id = await s.createTicketCharge(a);
        return { result: id, message: `Successfully created ticket charge with ID: ${id}` };
      }],
      ['autotask_update_ticket_charge', async (a) => {
        const { chargeId, ...updates } = a;
        await s.updateTicketCharge(chargeId, updates);
        return { result: chargeId, message: `Successfully updated ticket charge ${chargeId}` };
      }],
      ['autotask_delete_ticket_charge', async (a) => {
        await s.deleteTicketCharge(a.ticketId, a.chargeId);
        return { result: a.chargeId, message: `Successfully deleted ticket charge ${a.chargeId}` };
      }],

      // Ticket History (read-only audit trail)
      ['autotask_get_ticket_history', async (a) => {
        const r = await s.getTicketHistory(a.historyId);
        if (!r) return { result: null, message: `No ticket history entry found with ID ${a.historyId}` };
        return { result: r, message: 'Ticket history entry retrieved successfully' };
      }],
      ['autotask_search_ticket_history', async (a) => {
        const r = await s.searchTicketHistory({ ticketId: a.ticketId, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} ticket history entries for ticket ${a.ticketId}` };
      }],

      // Canonical record-reference resolver (read-only, tickets + tasks)
      ['autotask_resolve_record_reference', async (a) => {
        const r = await s.resolveRecordReference(a.reference);
        const message =
          r.status === 'matched'
            ? `Resolved ${r.reference} to ${r.entityType} ${r.id}${r.title ? ` — ${r.title}` : ''}`
            : r.status === 'ambiguous'
              ? `Reference ${r.reference} is ambiguous (${r.candidates?.length ?? 0} matches); no record selected`
              : `No ticket or task found for reference ${r.reference}`;
        return { result: r, message };
      }],

      // Service Calls
      ['autotask_get_service_call', async (a) => {
        const r = await s.getServiceCall(a.serviceCallId);
        if (!r) return { result: null, message: `No service call found with ID ${a.serviceCallId}` };
        return { result: r, message: 'Service call retrieved successfully' };
      }],
      ['autotask_search_service_calls', async (a) => {
        return paged(await s.searchServiceCalls(a), 'service calls');
      }],
      ['autotask_reconcile_service_call', async (a) => {
        const r = await s.reconcileServiceCall({ serviceCallId: a.serviceCallId, ticketId: a.ticketId });
        if (!r) return { result: null, message: 'No service call / linked ticket found to reconcile' };
        const msg = r.issues.length === 0
          ? `Service call ${r.serviceCallId} on ticket ${r.ticketNumber ?? r.ticketId}: no billing issues`
          : `Service call ${r.serviceCallId} on ticket ${r.ticketNumber ?? r.ticketId}: ${r.issues.join(', ')}` +
            (r.atRiskPartsValue > 0 ? ` ($${r.atRiskPartsValue} parts unfulfilled)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_report_service_call_leakage', async (a) => {
        const r = await s.reportServiceCallLeakage({
          lookbackDays: a.lookbackDays, companyID: a.companyID,
          maxServiceCalls: a.maxServiceCalls, includeClean: a.includeClean, includeCompleted: a.includeCompleted,
        });
        return {
          result: r,
          message: `Scanned ${r.scanned} service call(s) since ${r.window.after} (${r.scannedOpen} open, ${r.scannedCompleted} completed); ${r.flagged} flagged — ` +
            `${r.totals.doneNotClosed} done-not-closed, ${r.totals.noTimeLogged} no-time, ${r.totals.partsUnfulfilled} parts-unfulfilled ($${r.totals.atRiskPartsValue}), ` +
            `${r.totals.unbilledTime} with unbilled time (${r.totals.unbilledHours}h)` + (r.truncated ? ' [truncated]' : ''),
        };
      }],
      ['autotask_analyze_ticket_billing_gaps', async (a) => {
        const r = await s.analyzeTicketBillingGaps(a.ticketId);
        if (!r) return { result: null, message: `Ticket ${a.ticketId} not found` };
        const msg = r.issues.length === 0
          ? `Ticket ${r.ticketNumber ?? r.ticketId}: no billing gaps`
          : `Ticket ${r.ticketNumber ?? r.ticketId}: ${r.issues.join(', ')}` +
            (r.flags.nonbillableSuspect.hours > 0 ? ` (${r.flags.nonbillableSuspect.hours}h non-billable suspect)` : '') +
            (r.flags.notesWithoutTime.count > 0 ? ` (${r.flags.notesWithoutTime.count} note(s) w/o time)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_report_ticket_billing_gaps', async (a) => {
        const r = await s.reportTicketBillingGaps({
          lookbackDays: a.lookbackDays, companyID: a.companyID,
          maxTickets: a.maxTickets, includeCompleted: a.includeCompleted, includeClean: a.includeClean,
        });
        return {
          result: r,
          message: `Scanned ${r.scanned} ticket(s) active since ${r.window.after}; ${r.flagged} flagged — ` +
            `${r.totals.workNotLogged} work-not-logged, ${r.totals.noteWithoutTime} note-without-time (${r.totals.uncapturedNotes} notes), ` +
            `${r.totals.billableMarkedNonbillable} billable-marked-nonbillable (${r.totals.suspectNonbillableHours}h)` + (r.truncated ? ' [truncated]' : ''),
        };
      }],
      ['autotask_create_service_call', async (a) => {
        const id = await s.createServiceCall(a);
        return { result: id, message: `Successfully created service call with ID: ${id}` };
      }],
      ['autotask_update_service_call', async (a) => {
        const { serviceCallId, ...updates } = a;
        await s.updateServiceCall(serviceCallId, updates);
        return { result: serviceCallId, message: `Successfully updated service call ${serviceCallId}` };
      }],
      ['autotask_delete_service_call', async (a) => {
        await s.deleteServiceCall(a.serviceCallId);
        return { result: a.serviceCallId, message: `Successfully deleted service call ${a.serviceCallId}` };
      }],

      // ServiceCallTickets
      ['autotask_search_service_call_tickets', async (a) => {
        const r = await s.searchServiceCallTickets(a);
        return { result: r, message: `Found ${r.length} service call tickets` };
      }],
      ['autotask_create_service_call_ticket', async (a) => {
        const id = await s.createServiceCallTicket(a);
        return { result: id, message: `Successfully linked ticket to service call, record ID: ${id}` };
      }],
      ['autotask_delete_service_call_ticket', async (a) => {
        await s.deleteServiceCallTicket(a.serviceCallTicketId);
        return { result: a.serviceCallTicketId, message: `Successfully removed ticket from service call` };
      }],

      // ServiceCallTicketResources
      ['autotask_search_service_call_ticket_resources', async (a) => {
        const r = await s.searchServiceCallTicketResources(a);
        return { result: r, message: `Found ${r.length} service call ticket resources` };
      }],
      ['autotask_create_service_call_ticket_resource', async (a) => {
        const id = await s.createServiceCallTicketResource(a);
        return { result: id, message: `Successfully assigned resource to service call ticket, record ID: ${id}` };
      }],
      ['autotask_delete_service_call_ticket_resource', async (a) => {
        await s.deleteServiceCallTicketResource(a.serviceCallTicketResourceId);
        return { result: a.serviceCallTicketResourceId, message: `Successfully removed resource from service call ticket` };
      }],

      // ServiceCallTasks (schedule a project task onto the Autotask calendar)
      ['autotask_search_service_call_tasks', async (a) => {
        const r = await s.searchServiceCallTasks(a);
        return { result: r, message: `Found ${r.length} service call task(s)` };
      }],
      ['autotask_create_service_call_task', async (a) => {
        const id = await s.createServiceCallTask(a);
        return { result: id, message: `Successfully linked task to service call, record ID: ${id}` };
      }],
      ['autotask_delete_service_call_task', async (a) => {
        await s.deleteServiceCallTask(a.serviceCallTaskId);
        return { result: a.serviceCallTaskId, message: `Successfully removed task from service call` };
      }],

      // ServiceCallTaskResources
      ['autotask_search_service_call_task_resources', async (a) => {
        const r = await s.searchServiceCallTaskResources(a);
        return { result: r, message: `Found ${r.length} service call task resource(s)` };
      }],
      ['autotask_create_service_call_task_resource', async (a) => {
        const id = await s.createServiceCallTaskResource(a);
        return { result: id, message: `Successfully assigned resource to service call task, record ID: ${id}` };
      }],
      ['autotask_delete_service_call_task_resource', async (a) => {
        await s.deleteServiceCallTaskResource(a.serviceCallTaskResourceId);
        return { result: a.serviceCallTaskResourceId, message: `Successfully removed resource from service call task` };
      }],

      // Company To-Dos (CRM calendar follow-ups)
      ['autotask_get_company_todo', async (a) => {
        const r = await s.getCompanyToDo(a.id);
        if (!r) return { result: null, message: `No Company To-Do found with ID ${a.id}` };
        return { result: r, message: 'Company To-Do retrieved successfully' };
      }],
      ['autotask_search_company_todos', async (a) => {
        const r = await s.searchCompanyToDos(a);
        return { result: r, message: `Found ${r.length} Company To-Do(s)` };
      }],
      ['autotask_create_company_todo', async (a) => {
        const id = await s.createCompanyToDo(a);
        return { result: id, message: `Successfully created Company To-Do with ID: ${id}` };
      }],
      ['autotask_update_company_todo', async (a) => {
        const { id, companyID, ...updates } = a;
        await s.updateCompanyToDo(id, updates, companyID);
        return { result: id, message: `Successfully updated Company To-Do ${id}` };
      }],
      ['autotask_complete_company_todo', async (a) => {
        const completedDate = await s.completeCompanyToDo(a.id, a.companyID);
        return { result: { id: a.id, completedDate }, message: `Company To-Do ${a.id} marked complete (completedDate ${completedDate})` };
      }],
      ['autotask_delete_company_todo', async (a) => {
        await s.deleteCompanyToDo(a.id, a.companyID);
        return { result: a.id, message: `Successfully deleted Company To-Do ${a.id}` };
      }],


      // Time entries
      ['autotask_create_time_entry', async (a) => {
        // If no resource specified at all, prompt the user
        if (!a.resourceID && !a.resourceName) {
          return { result: null, message: 'Please specify who is logging this time. Provide a resourceName (e.g., "Will Spence") or resourceID.' };
        }
        // Resolve resourceName to resourceID via SDK helper
        if (a.resourceName && !a.resourceID) {
          const resource = await s.resolveResourceByName(a.resourceName);
          if (!resource) {
            throw new Error(`No resource found matching "${a.resourceName}"`);
          }
          a.resourceID = resource.id;
          delete a.resourceName;
        }
        // For Regular Time entries (no ticket/task/project), handle category
        const isRegularTime = !a.ticketID && !a.taskID && !a.projectID;
        if (isRegularTime) {
          if (!a.category && !a.internalBillingCodeID) {
            // List available categories and prompt user
            const categories = await s.getInternalBillingCodeNames();
            return { result: null, message: `Please specify a category for this Regular Time entry. Available categories: ${categories.join(', ')}` };
          }
          if (a.category && !a.internalBillingCodeID) {
            const billingCode = await s.resolveInternalBillingCodeByName(a.category);
            if (!billingCode) {
              const categories = await s.getInternalBillingCodeNames();
              throw new Error(`No category found matching "${a.category}". Available categories: ${categories.join(', ')}`);
            }
            a.internalBillingCodeID = billingCode.id;
            delete a.category;
          }
        }
        // Ticket/task time entries require a roleID. Use the resource's default
        // when it has one; otherwise surface a pick rather than guessing. Best-
        // effort: if the role lookup itself fails, let the create proceed (Autotask
        // still enforces the requirement) rather than hard-blocking.
        if ((a.ticketID || a.taskID) && a.roleID == null) {
          let rr: Awaited<ReturnType<typeof s.resolveWorkTimeEntryRole>> | null;
          try { rr = await s.resolveWorkTimeEntryRole(a.resourceID); } catch { rr = null; }
          if (rr && 'error' in rr) return { result: null, message: rr.error };
          if (rr && 'needsSelection' in rr) {
            const opts = rr.needsSelection.map((r) => `${r.roleID} = ${r.roleName ?? '(unnamed role)'}`).join(', ');
            return { result: { needsSelection: rr.needsSelection }, message: `This resource has multiple roles and no single default — re-run with roleID set to one of: ${opts}.` };
          }
          if (rr && 'roleID' in rr) a.roleID = rr.roleID;
        }
        const id = await s.createTimeEntry(a); return { result: id, message: `Successfully created time entry with ID: ${id}` };
      }],
      ['autotask_get_my_day', async (a) => {
        if (a.resourceID == null) {
          return { result: null, message: 'Could not determine the acting user. Provide resourceID, or call as an identified user (currentUser / gateway impersonation).' };
        }
        const r = await s.getMyDay(a.resourceID, a.date);
        return { result: r, message: `${r.date}: ${r.totals.assignedTickets} assigned ticket(s), ${r.totals.timeEntries} time entr(ies) (${r.totals.hoursLogged}h logged), ${r.openTasks.length} open task(s)` };
      }],
      ['autotask_log_my_time', async (a) => {
        if (a.resourceID == null) {
          return { result: null, message: 'Could not determine who to log time as. Provide resourceID, or call as an identified user (currentUser / gateway impersonation).' };
        }
        // Regular Time (no ticket/task): resolve a category to its internal billing code (mirrors create_time_entry).
        const isRegular = !a.ticketID && !a.taskID;
        if (isRegular) {
          if (a.category && !a.internalBillingCodeID) {
            const bc = await s.resolveInternalBillingCodeByName(a.category);
            if (!bc) {
              const cats = await s.getInternalBillingCodeNames();
              throw new Error(`No category found matching "${a.category}". Available categories: ${cats.join(', ')}`);
            }
            a.internalBillingCodeID = bc.id;
          }
          if (!a.internalBillingCodeID) {
            const cats = await s.getInternalBillingCodeNames();
            return { result: null, message: `Regular Time (no ticket/task) needs a category. Available categories: ${cats.join(', ')}` };
          }
        }
        delete a.category;
        // Ticket/task time entries require a roleID — default, else pick (no guess).
        // Best-effort: a role-lookup failure doesn't block the log.
        if ((a.ticketID || a.taskID) && a.roleID == null) {
          let rr: Awaited<ReturnType<typeof s.resolveWorkTimeEntryRole>> | null;
          try { rr = await s.resolveWorkTimeEntryRole(a.resourceID); } catch { rr = null; }
          if (rr && 'error' in rr) return { result: null, message: rr.error };
          if (rr && 'needsSelection' in rr) {
            const opts = rr.needsSelection.map((r) => `${r.roleID} = ${r.roleName ?? '(unnamed role)'}`).join(', ');
            return { result: { needsSelection: rr.needsSelection }, message: `This resource has multiple roles and no single default — re-run with roleID set to one of: ${opts}.` };
          }
          if (rr && 'roleID' in rr) a.roleID = rr.roleID;
        }
        const dateWorked = typeof a.dateWorked === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.dateWorked)
          ? a.dateWorked.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
        const r = await s.logTimeIdempotent({ ...a, dateWorked });
        return { result: r, message: r.created ? `Logged time entry ${r.id}` : `Skipped — duplicate of existing time entry ${r.duplicateOf}` };
      }],

      // Projects
      ['autotask_search_projects', async (a) => {
        return paged(await s.searchProjects(a), 'projects');
      }],
      ['autotask_get_project', async (a) => {
        const r = await s.getProject(a.id); return { result: r, message: r ? `Project ${a.id}` : `Project ${a.id} not found` };
      }],
      ['autotask_get_project_structure', async (a) => {
        const r = await s.getProjectStructure(a.projectID);
        return { result: r, message: `Project ${a.projectID}: ${r.summary.phaseCount} phase(s), ${r.summary.taskCount} task(s), depth ${r.summary.maxPhaseDepth}` };
      }],
      ['autotask_get_complete_project_context', async (a) => {
        const r = await s.getCompleteProjectContext(a.projectID, {
          includeConfigurationItems: a.includeConfigurationItems,
          includeCommercial: a.includeCommercial,
        });
        if (!r.found) return { result: r, message: r.message };
        const errs = r.errors?.length ? `, ${r.errors.length} section error(s)` : '';
        return { result: r, message: `Project ${a.projectID} context: ${r.summary.phaseCount} phase(s), ${r.summary.taskCount} task(s), ${r.summary.dependencyCount} dependency(ies), ${r.summary.milestoneCount} milestone(s)${errs}` };
      }],
      ['autotask_get_project_labor_summary', async (a) => {
        const r = await s.getProjectLaborSummary(a.projectID);
        return { result: r, message: `Project ${a.projectID} labor: ${r.actualHours}h actual vs ${r.estimatedHours}h estimated (variance ${r.variance}h), ${r.billableHours}h billable` };
      }],
      ['autotask_export_project_blueprint', async (a) => {
        const r = await s.exportProjectBlueprint(a.projectID);
        return { result: r, message: `Blueprint of "${r.name}": ${r.phaseCount} phase(s), ${r.taskCount} task(s), ${r.estimatedHours}h` };
      }],
      ['autotask_calculate_project_schedule', async (a) => {
        // Pure/deterministic — no Autotask I/O. Schedules a caller-provided plan.
        const r = calculateProjectSchedule(a.plan, {
          startDate: a.startDate,
          hoursPerDay: a.hoursPerDay,
          defaultCrewSize: a.defaultCrewSize,
          workweek: a.workweek,
          holidays: a.holidays,
          targetCompletionDate: a.targetCompletionDate,
        });
        const warn = r.warnings.length ? `; ${r.warnings.length} warning(s)` : '';
        return {
          result: r,
          message: `Scheduled ${r.taskCount} task(s): ${r.startDate} → ${r.targetCompletionDate} (${r.durationWorkingDays} working days, ${r.totalEstimatedHours}h)${warn}`,
        };
      }],
      ['autotask_extract_project_scope', async (a) => {
        // Pure/deterministic — no Autotask I/O, no reference-project inference.
        // Section-parses a SOW into the normalized scope envelope for review.
        const r = extractProjectScope({ sowText: a.sowText, scope: a.scope, source: a.source, quantityBuckets: a.quantityBuckets });
        const counts = `${r.included.length} in / ${r.excluded.length} out / ${r.assumptions.length} assumption(s) / ${r.quantities.length} qty`;
        return {
          result: r,
          message: `Scope extracted: ${counts}. ${r.unclassified.length} unclassified; ${r.warnings.length} warning(s) — review before planning.`,
        };
      }],
      ['autotask_classify_project', async (a) => {
        // Pure/deterministic — no Autotask I/O. Keyword-scores a project/scope
        // against a caller-provided archetype set; explainable, no AI.
        const r = classifyProject({ archetypes: a.archetypes, text: a.text, scope: a.scope, minScore: a.minScore, defaultArchetype: a.defaultArchetype });
        return {
          result: r,
          message: `Classified as "${r.classification}" (${r.confidence} confidence). ${r.rationale}`,
        };
      }],
      // Webhook management (#23 §16) — read/discovery layer
      ['autotask_list_webhook_entities', async () => {
        // Pure/deterministic — the prerequisite: which entities support webhooks
        // and the REST entity names behind each (incl. the excluded-resources
        // child used for loop prevention).
        const entities = Object.values(WEBHOOK_ENTITIES).map((m) => ({
          entity: m.key, watches: m.targetEntity, webhookEntity: m.parent,
          fieldsEntity: m.fields, udfFieldsEntity: m.udfFields, excludedResourcesEntity: m.excludedResources,
        }));
        return {
          result: { entities, loopPreventionNote: 'Exclude the MCP integration user\'s resourceID via the excluded-resources child so the MCP\'s own writes do not trigger the webhook (avoids loops).' },
          message: `${entities.length} webhook-capable entit(ies): ${entities.map((e) => e.entity).join(', ')}`,
        };
      }],
      ['autotask_search_webhooks', async (a) => {
        const r = await s.searchWebhooks(a.entity, { activeOnly: a.activeOnly, pageSize: a.pageSize });
        const active = r.webhooks.filter((w) => w.isActive).length;
        return { result: r, message: `${r.webhooks.length} webhook(s) on ${r.entity} (${active} active)` };
      }],
      ['autotask_get_webhook', async (a) => {
        const r = await s.getWebhook(a.entity, a.id);
        if (!r) return { result: null, message: `Webhook ${a.id} not found on ${a.entity}` };
        return { result: r, message: `Webhook ${a.id} on ${r.entity}: ${(r.fields as any[]).length} field(s), ${(r.excludedResources as any[]).length} excluded resource(s)` };
      }],
      ['autotask_create_webhook', async (a) => {
        const r = await s.createWebhook(a.entity, {
          name: a.name, webhookUrl: a.webhookUrl, deactivationUrl: a.deactivationUrl, isActive: a.isActive,
          subscribeCreate: a.subscribeCreate, subscribeUpdate: a.subscribeUpdate, subscribeDelete: a.subscribeDelete,
          sendThresholdExceededNotification: a.sendThresholdExceededNotification, notificationEmailAddress: a.notificationEmailAddress,
          secretKey: a.secretKey,
          fields: a.fields, excludedResourceIDs: a.excludedResourceIDs, dryRun: a.dryRun,
        });
        const msg = r.status === 'dry_run' ? `Dry run: would create a ${a.entity} webhook → ${a.webhookUrl} with ${(r.plannedFields as any[])?.length ?? 0} field(s), ${(r.plannedExcludedResources as any[])?.length ?? 0} excluded resource(s); nothing written`
          : r.status === 'validation_failed' ? `Validation failed: ${JSON.stringify(r.errors ?? r.detail)}`
          : `Created ${a.entity} webhook ${r.webhookID}` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} child error(s)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_update_webhook', async (a) => {
        const r = await s.updateWebhook(a.entity, a.id, {
          name: a.name, webhookUrl: a.webhookUrl, deactivationUrl: a.deactivationUrl, isActive: a.isActive,
          subscribeCreate: a.subscribeCreate, subscribeUpdate: a.subscribeUpdate, subscribeDelete: a.subscribeDelete,
          sendThresholdExceededNotification: a.sendThresholdExceededNotification, notificationEmailAddress: a.notificationEmailAddress,
          secretKey: a.secretKey,
        }, a.dryRun);
        const msg = r.status === 'dry_run' ? `Dry run: would update ${a.entity} webhook ${a.id} — ${Object.keys(r.plannedPatch as object).join(', ')}; nothing written`
          : r.status === 'validation_failed' ? `Validation failed: ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : `Updated ${a.entity} webhook ${a.id}`;
        return { result: r, message: msg };
      }],
      ['autotask_delete_webhook', async (a) => {
        await s.deleteWebhook(a.entity, a.id);
        return { result: undefined, message: `Deleted ${a.entity} webhook ${a.id}` };
      }],
      ['autotask_set_webhook_excluded_resources', async (a) => {
        const r = await s.setWebhookExcludedResources(a.entity, a.webhookID, a.resourceIDs, a.mode, a.dryRun);
        const msg = r.status === 'dry_run' ? `Dry run (${a.mode ?? 'add'}): would add ${(r.wouldAddResourceIDs as any[])?.length ?? 0}, remove ${(r.wouldRemoveRowIDs as any[])?.length ?? 0} excluded resource(s) on webhook ${a.webhookID}; nothing written`
          : r.status === 'validation_failed' ? `Validation failed: ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : `Excluded resources on webhook ${a.webhookID}: +${r.added}/-${r.removed}`;
        return { result: r, message: msg };
      }],
      ['autotask_calculate_bom_labor', async (a) => {
        // Pure/deterministic — no Autotask I/O. BOM quantities + caller rate
        // catalog → calculated hours per phase (+ tasks) for the labor plan.
        const r = computeBomLabor({ items: a.items, rates: a.rates, defaultHoursPerUnit: a.defaultHoursPerUnit, defaultPhaseRef: a.defaultPhaseRef });
        return {
          result: r,
          message: `Calculated ${r.totalHours}h from ${r.matchedItems}/${r.lines.length} matched item(s) across ${Object.keys(r.byPhase).length} phase(s); ${r.unmatched.length} unmatched${r.warnings.length ? `; ${r.warnings.length} warning(s)` : ''}`,
        };
      }],
      ['autotask_generate_project_labor_plan', async (a) => {
        // Pure/deterministic — no Autotask I/O. Compares planned vs quoted vs
        // calculated labor for a caller-provided plan.
        const r = generateProjectLaborPlan({
          plan: a.plan,
          quotedHoursByPhase: a.quotedHoursByPhase,
          calculatedHoursByPhase: a.calculatedHoursByPhase,
          quotedHoursTotal: a.quotedHoursTotal,
          calculatedHoursTotal: a.calculatedHoursTotal,
          varianceThresholdPct: a.varianceThresholdPct,
        });
        const q = r.totals.quotedHours != null ? ` vs ${r.totals.quotedHours}h quoted` : '';
        return {
          result: r,
          message: `Labor plan: ${r.totals.plannedHours}h planned${q} across ${r.phases.length} phase(s); ${r.flaggedPhases} flagged for variance (>${Math.round(r.varianceThresholdPct * 100)}%)`,
        };
      }],
      ['autotask_create_project', async (a) => {
        const projectData = { ...a };
        // Map startDate/endDate (YYYY-MM-DD) to startDateTime/endDateTime (ISO) expected by the API
        if (projectData.startDate && !projectData.startDateTime) {
          projectData.startDateTime = `${projectData.startDate}T00:00:00Z`;
          delete projectData.startDate;
        }
        if (projectData.endDate && !projectData.endDateTime) {
          projectData.endDateTime = `${projectData.endDate}T00:00:00Z`;
          delete projectData.endDate;
        }
        const id = await s.createProject(projectData); return { result: id, message: `Successfully created project with ID: ${id}` };
      }],
      ['autotask_update_project', async (a) => {
        const { projectId, ...rest } = a;
        const updates: Record<string, any> = {};
        // Only fields Autotask actually accepts on Projects reach the API
        // (verified against entityInformation). `estimatedTime` is read-only
        // there, and assignedResourceID/assignedResourceRoleID are Task fields,
        // not Project ones — all three were being forwarded and doing nothing.
        // They stay accepted as arguments so existing callers do not break, but
        // are no longer sent upstream.
        for (const key of [
          'projectName',
          'description',
          'status',
          'statusDetail',
          'projectLeadResourceID',
          'startDateTime',
          'endDateTime',
          'contractID',
          'opportunityID',
          'purchaseOrderNumber',
          'userDefinedFields'
        ]) {
          if (rest[key] !== undefined) updates[key] = rest[key];
        }
        // The Projects field is `department`, not `departmentID`; the advertised
        // spelling was silently dropped. Accept either.
        const department = rest.department ?? rest.departmentID;
        if (department !== undefined) updates.department = department;
        await s.updateProject(projectId, updates);
        return { result: undefined, message: `Successfully updated project ID: ${projectId}` };
      }],
      ['autotask_create_configuration_item', async (a) => {
        const id = await s.createConfigurationItem(a);
        return { result: id, message: `Successfully created configuration item with ID: ${id}` };
      }],
      ['autotask_update_configuration_item', async (a) => {
        const { id, ...updates } = a;
        await s.updateConfigurationItem(id, updates);
        return { result: id, message: `Successfully updated configuration item ${id}` };
      }],
      ['autotask_link_project_commercial', async (a) => {
        const r = await s.linkProjectCommercial(a);
        return { result: r, message: `Project commercial linkage: ${r.status}` };
      }],
      ['autotask_build_project_from_plan', async (a) => {
        const r = await s.buildProjectFromPlan({
          plan: a.plan, companyID: a.companyID, buildKey: a.buildKey,
          projectDefaults: a.projectDefaults, dryRun: a.dryRun,
        });
        const sm = r.summary as Record<string, number> | undefined;
        const msg =
          r.status === 'dry_run' ? `Dry run OK — would create ${r.plannedPhases} phase(s), ${r.plannedTasks} task(s), ${r.plannedDependencies} dependency link(s)${r.existingProjectId ? ` (resuming project ${r.existingProjectId})` : ''}; nothing written`
          : r.status === 'validation_failed' ? `Validation failed at step "${r.step}": ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : r.status === 'built' ? `Built project ${r.projectId}: +${sm?.phasesCreated} phase(s), +${sm?.tasksCreated} task(s), +${sm?.dependenciesCreated} dependency link(s)${r.resumed ? ' (resumed)' : ''}`
          : r.status === 'built_with_errors' ? `Built project ${r.projectId} with ${(r.errors as any[])?.length} error(s): +${sm?.tasksCreated} task(s), +${sm?.phasesCreated} phase(s) — re-run to complete`
          : `Build result: ${r.status}`;
        return { result: r, message: msg };
      }],
      ['autotask_extend_project', async (a) => {
        const r = await s.extendProject({ projectID: a.projectID, plan: a.plan, dryRun: a.dryRun });
        const sm = r.summary as Record<string, number> | undefined;
        const msg =
          r.status === 'dry_run' ? `Dry run OK — would add ${(r.wouldAddPhases as any[])?.length ?? 0} phase(s), ${(r.wouldAddTasks as any[])?.length ?? 0} task(s) to project ${r.projectId} (${r.plannedDependencies} dependency link(s)); nothing written`
          : r.status === 'validation_failed' ? `Validation failed at step "${r.step}": ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`
          : r.status === 'extended' ? `Extended project ${r.projectId}: +${sm?.phasesCreated} phase(s), +${sm?.tasksCreated} task(s), +${sm?.dependenciesCreated} dependency link(s)`
          : r.status === 'extended_with_errors' ? `Extended project ${r.projectId} with ${(r.errors as any[])?.length} error(s): +${sm?.tasksCreated} task(s), +${sm?.phasesCreated} phase(s) — re-run to complete`
          : `Extend result: ${r.status}`;
        return { result: r, message: msg };
      }],

      // Resources
      ['autotask_search_resources', async (a) => {
        return paged(await s.searchResources(a), 'resources');
      }],
      ['autotask_search_roles', async (a) => {
        const r = await s.searchRoles({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} role(s)` };
      }],
      ['autotask_get_resource_roles', async (a) => {
        const r = await s.getResourceRoles(a.resourceID);
        return { result: r, message: `Resource ${a.resourceID} has ${r.length} role(s)` };
      }],

      // Configuration Items
      ['autotask_search_configuration_items', async (a) => {
        const r = await s.searchConfigurationItems(a); return { result: r, message: `Found ${r.length} configuration items` };
      }],
      ['autotask_get_configuration_item', async (a) => {
        const ci = await s.getConfigurationItem(a.configurationItemId);
        if (!ci) return { result: null, message: `No configuration item found with ID ${a.configurationItemId}` };
        if (a.enrichReferences) {
          const _enriched = await s.enrichConfigurationItemReferences(ci);
          return { result: { ...ci, _enriched }, message: `Retrieved configuration item ${a.configurationItemId} (enriched)` };
        }
        return { result: ci, message: `Retrieved configuration item ${a.configurationItemId}` };
      }],
      ['autotask_get_configuration_item_entitlement', async (a) => {
        const r = await s.getConfigurationItemEntitlement(a.configurationItemId);
        const msg = !r.found ? `Configuration item ${a.configurationItemId} not found`
          : `CI ${a.configurationItemId}: ${r.isEntitled ? 'entitled' : 'not entitled'} (${r.reason})`;
        return { result: r, message: msg };
      }],
      ['autotask_search_configuration_item_coverage_gaps', async (a) => {
        const r = await s.searchConfigurationItemCoverageGaps({ companyID: a.companyID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} active uncovered configuration item(s)` };
      }],
      ['autotask_create_maintenance_ticket', async (a) => {
        const r = await s.createMaintenanceTicket(a);
        const msg = r.status === 'created' ? `Created maintenance ticket ${r.id}`
          : r.status === 'duplicate' ? `Occurrence already exists (${(r.existingTickets as any[])?.length} ticket(s) with externalID "${a.externalID}") — no duplicate created`
          : r.status === 'dry_run' ? `Dry run OK — validated ${(r.validation as any[])?.length} step(s); nothing written`
          : `Validation failed at step "${r.step}": ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`;
        return { result: r, message: msg };
      }],

      // Contracts
      ['autotask_search_contracts', async (a) => {
        const r = await s.searchContracts(a); return { result: r, message: `Found ${r.length} contracts` };
      }],
      ['autotask_get_contract', async (a) => {
        const r = await s.getContract(a.id); return { result: r, message: `Retrieved contract ${a.id}` };
      }],
      ['autotask_list_expiring_contracts', async (a) => {
        const r = await s.listExpiringContracts(a);
        return { result: r, message: `Found ${r.length} contracts with end dates within ${a.daysAhead ?? 60} days` };
      }],
      ['autotask_report_block_hour_usage', async (a) => {
        const r = await s.getBlockHourUsage({ contractID: a.contractID, companyID: a.companyID, includeInactive: a.includeInactive });
        const over = r.filter((c) => (c.billableOverageHours ?? 0) > 0).length;
        return { result: r, message: `Block-hour usage for ${r.length} contract(s); ${over} over block hours` };
      }],
      ['autotask_report_ticket_charges', async (a) => {
        const r = await s.getTicketChargesReport({ sinceDays: a.sinceDays, status: a.status, unbilledOnly: a.unbilledOnly, companyID: a.companyID });
        return { result: r, message: `${r.totalCharges} charge(s) on ${r.ticketsWithCharges} ticket(s); ${r.unbilled} unbilled ($${r.unbilledBillable})` };
      }],
      ['autotask_report_unbilled', async (a) => {
        const r = await s.getUnbilledReport({ companyID: a.companyID, minAgeDays: a.minAgeDays });
        return { result: r, message: `$${r.totalAmount} unbilled across ${r.totalCount} item(s); $${r.atRiskAmount} at risk (>30d)` };
      }],
      ['autotask_report_sla_compliance', async (a) => {
        const r = await s.getSlaCompliance({ from: a.from, to: a.to, companyID: a.companyID, queueID: a.queueID, openOnly: a.openOnly, groupBy: a.groupBy, maxTickets: a.maxTickets });
        const tr = r.stages.triage, en = r.stages.engagement, rv = r.stages.resolved;
        const pct = (a2: any) => a2.compliancePct == null ? 'n/a' : `${a2.compliancePct}%`;
        const rm = r.responseMetrics;
        const base = r.targetsConfigured === 0
          ? `No SLA targets configured on ${r.ticketsEvaluated} ticket(s) — compliance n/a`
          : `SLA over ${r.ticketsEvaluated} ticket(s) (${r.targetsConfigured} with targets): triage ${pct(tr)}, engagement ${pct(en)}, resolved ${pct(rv)}; ${r.breaches.length} open breach(es)`;
        return { result: r, message: `${base}. Actual: median ${rm.medianHoursToFirstResponse ?? 'n/a'}h to first response, ${rm.medianHoursToResolve ?? 'n/a'}h to resolve${r.truncated ? ' [truncated]' : ''}` };
      }],
      ['autotask_generate_sla_framework', async (a) => {
        // Pure/deterministic — no Autotask I/O. Produces an ITIL-standard SLA spec
        // (priority matrix + clean scheme + target matrix) to enter in the UI.
        const r = generateSlaFramework({
          levels: a.levels,
          requestTypes: a.requestTypes,
          tiers: a.tiers,
          currentPriorities: a.currentPriorities,
          businessHoursPerDay: a.businessHoursPerDay,
          serviceRequestResolutionMultiplier: a.serviceRequestResolutionMultiplier,
          overrides: a.overrides,
        });
        const mig = r.priorityMigration ? `; mapped ${r.priorityMigration.length} current priority value(s)` : '';
        return {
          result: r,
          message: `ITIL SLA framework: ${r.priorityScheme.length}-level priority scheme + ${r.targets.length} target row(s) across ${new Set(r.targets.map((t) => t.tier)).size} tier(s). Advisory only — enter in the Autotask UI${mig}.`,
        };
      }],
      ['autotask_report_time_entry_compliance', async (a) => {
        const r = await s.getTimeEntryComplianceReport({
          from: a.from, to: a.to, bucket: a.bucket, resourceID: a.resourceID,
          expectedHoursPerBucket: a.expectedHoursPerBucket, expectedHoursPerWeek: a.expectedHoursPerWeek,
          lateThresholdDays: a.lateThresholdDays, maxEntries: a.maxEntries,
        });
        const o = r.overall;
        return {
          result: r,
          message: `Time entry over ${r.resourcesEvaluated} resource(s), ${r.bucketsCovered.length} ${r.bucket}(s): ${o.totalHours}h logged (${o.billableHours}h billable), ${o.unapprovedHours}h unapproved, ${o.lateEntries} late entr(y/ies); ${r.flagged.length} resource(s) flagged${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_request_segmentation', async (a) => {
        const r = await s.getRequestSegmentation({
          from: a.from, to: a.to, companyID: a.companyID, queueID: a.queueID, openOnly: a.openOnly,
          segments: a.segments, defaultSegmentName: a.defaultSegmentName, maxTickets: a.maxTickets,
        });
        const top = r.segments.slice(0, 3).map((s2) => `${s2.name} ${s2.total}${s2.sharePct != null ? ` (${s2.sharePct}%)` : ''}`).join(', ');
        return {
          result: r,
          message: `Segmented ${r.ticketsEvaluated} ticket(s) into ${r.segments.length} segment(s) [${r.rulesUsed}]: ${top}${r.segments.length > 3 ? ', …' : ''}${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_ticket_throughput', async (a) => {
        const r = await s.getTicketThroughput({
          from: a.from, to: a.to, companyID: a.companyID, queueID: a.queueID,
          agingThresholds: a.agingThresholds, groupBy: a.groupBy, maxTickets: a.maxTickets,
        });
        const f = r.flow;
        const rt = f.completionRatio != null ? `${Math.round(f.completionRatio * 100)}%` : 'n/a';
        return {
          result: r,
          message: `Flow ${r.from}→${r.to}: ${f.created} created / ${f.completed} completed (${rt}), net backlog ${f.netBacklogChange >= 0 ? '+' : ''}${f.netBacklogChange}. Open now: ${r.backlog.open} (oldest ${r.backlog.oldestOpenDays ?? 'n/a'}d)${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_tickets_needing_scheduling', async (a) => {
        const r = await s.getTicketsNeedingScheduling({
          companyID: a.companyID, queueID: a.queueID, ticketType: a.ticketType,
          requireHoursToSchedule: a.requireHoursToSchedule, groupBy: a.groupBy, maxTickets: a.maxTickets,
        });
        return {
          result: r,
          message: `${r.needsScheduling.length} of ${r.ticketsEvaluated} open ticket(s) need scheduling (${r.counts.unscheduled} no service call, ${r.counts.pastServiceCall} stale); ${r.totalHoursToSchedule}h to schedule${r.truncated ? ' [truncated]' : ''}`,
        };
      }],
      ['autotask_report_sla_coverage', async (a) => {
        const r = await s.getContractSlaCoverage({ companyID: a.companyID, status: a.status, activeOnly: a.activeOnly, maxContracts: a.maxContracts });
        const msg = r.readiness === 'no_sla_definitions'
          ? `No SLA definitions in this tenant — define them in the UI first (${r.contractsEvaluated} contract(s) checked)`
          : `${r.linked}/${r.contractsEvaluated} contract(s) linked to an SLA; ${r.unlinked} unlinked${r.truncated ? ' [truncated]' : ''}`;
        return { result: r, message: msg };
      }],
      ['autotask_assign_contract_sla', async (a) => {
        const r = await s.assignContractSla({ assignments: a.assignments, serviceLevelAgreementID: a.serviceLevelAgreementID, contractIDs: a.contractIDs, dryRun: a.dryRun });
        const detail = (d: unknown) => typeof d === 'string' ? d : (d as any)?.message ?? JSON.stringify(d);
        const msg = r.status === 'dry_run' ? `Dry run: would assign an SLA to ${(r.plannedAssignments as any[])?.length ?? 0} contract(s); nothing written`
          : r.status === 'validation_failed' ? `Validation failed at "${r.step}": ${detail(r.detail)}`
          : `Assigned an SLA to ${r.assigned} contract(s)` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} error(s)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_report_project_pl', async (a) => {
        const r = await s.getProjectPL({ projectID: a.projectID, taskId: a.taskId, ticketId: a.ticketId, bucket: a.bucket, from: a.from, to: a.to });
        const t = r.totals;
        const cov = r.costCoverage.hoursNoBurden > 0 ? ` — ${r.costCoverage.hoursNoBurden}h with NO burden set (cost understated)` : '';
        const pend = t.pendingBillableHours > 0 ? `; ${t.pendingBillableHours}h pending/unposted` : '';
        return { result: r, message: `${r.scope} ${r.entityId} P&L (${r.bucket}): $${t.postedRevenue} revenue − $${t.totalCost} cost = $${t.realizedMargin} margin${t.marginPct != null ? ` (${Math.round(t.marginPct * 100)}%)` : ''} over ${r.buckets.length} ${r.bucket}(s)${pend}${cov}` };
      }],
      ['autotask_report_inventory_reorder', async (a) => {
        const r = await s.getInventoryReorder({ locationID: a.locationID, warehouseOnly: a.warehouseOnly });
        return { result: r, message: `${r.count} product/location line(s) below minimum; est order cost $${r.totalEstCost}` };
      }],
      ['autotask_report_inventory_closeouts', async (a) => {
        const r = await s.getInventoryCloseouts({ includeGenerics: a.includeGenerics });
        return { result: r, message: `${r.count} to-order charge(s) already in stock (${r.generics} generic/flagged)` };
      }],
      ['autotask_report_inventory_stale', async (a) => {
        const r = await s.getInventoryStale({ staleDays: a.staleDays, recentDays: a.recentDays });
        return { result: r, message: `${r.staleCount} stale product(s) of ${r.count} on hand; $${r.staleValue} tied up — ${r.phantomCount} phantom ($${r.phantomValue}, never decremented) vs ${r.deadStockCount} dead-stock ($${r.deadStockValue})` };
      }],
      ['autotask_create_contracts_bulk', async (a) => {
        const r = await s.createContracts(a.contracts);
        const ok = r.filter((item) => item.success).length;
        return { result: r, message: `Created ${ok}/${r.length} contracts` };
      }],
      ['autotask_create_contract', async (a) => {
        const id = await s.createContract(a); return { result: id, message: `Successfully created contract with ID: ${id}` };
      }],
      ['autotask_update_contract', async (a) => {
        const { id, ...rest } = a;
        await s.updateContract(id, rest); return { result: undefined, message: `Successfully updated contract ID: ${id}` };
      }],
      ['autotask_create_contract_service', async (a) => {
        const id = await s.createContractService(a); return { result: id, message: `Successfully created contract service with ID: ${id}` };
      }],
      ['autotask_update_contract_service', async (a) => {
        const { id, ...rest } = a;
        await s.updateContractService(id, rest); return { result: undefined, message: `Successfully updated contract service ID: ${id}` };
      }],
      ['autotask_get_contract_service', async (a) => {
        const r = await s.getContractService(a.id);
        return { result: r, message: r ? `Retrieved contract service ${a.id}` : `Contract service ${a.id} not found` };
      }],
      ['autotask_search_contract_services', async (a) => {
        const r = await s.searchContractServices({ contractID: a.contractID, serviceID: a.serviceID, quoteItemID: a.quoteItemID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} contract service(s)` };
      }],
      ['autotask_get_contract_billed_units', async (a) => {
        const r = await s.getContractBilledUnits({
          contractID: a.contractID, contractServiceID: a.contractServiceID,
          startAfter: a.startAfter, startBefore: a.startBefore,
          includeBundles: a.includeBundles, pageSize: a.pageSize,
        });
        return { result: r, message: `${r.totalServiceUnits} service + ${r.totalBundleUnits} bundle unit row(s); $${r.totalBilled} billed` };
      }],
      ['autotask_report_contract_recurring_revenue', async (a) => {
        const r = await s.getContractRecurringRevenue({ contractID: a.contractID, asOfDate: a.asOfDate });
        return { result: r, message: `MRR $${r.mrr} / ARR $${r.arr} across ${r.activeLineCount} active recurring line(s) as of ${r.asOf}` };
      }],
      ['autotask_get_contract_milestone', async (a) => {
        const r = await s.getContractMilestone(a.id); return { result: r, message: r ? `Contract milestone ${a.id}` : `Contract milestone ${a.id} not found` };
      }],
      ['autotask_search_contract_milestones', async (a) => {
        const r = await s.searchContractMilestones({ contractID: a.contractID, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} contract milestone(s)` };
      }],
      ['autotask_create_contract_milestone', async (a) => {
        const id = await s.createContractMilestone(a); return { result: id, message: `Successfully created contract milestone with ID: ${id}` };
      }],
      ['autotask_update_contract_milestone', async (a) => {
        const { id, ...rest } = a;
        await s.updateContractMilestone(id, rest); return { result: undefined, message: `Successfully updated contract milestone ${id}` };
      }],

      // Raw REST passthrough (escape hatch)
      ['autotask_raw_request', async (a) => {
        const r = await s.rawRequest(a.method, a.path, a.body, a.queryParams);
        return { result: r, message: `Autotask ${a.method} ${a.path} completed` };
      }],

      // Invoices
      ['autotask_search_invoices', async (a) => {
        const r = await s.searchInvoices(a); return { result: r, message: `Found ${r.length} invoices` };
      }],
      ['autotask_get_invoice_details', async (a) => {
        const r = await s.getInvoiceDetails(a.invoiceId);
        const count = r?.lineItems?.length ?? 0;
        const tix = r?.linkedTicketIDs?.length ?? 0;
        return { result: r, message: r ? `Invoice ${a.invoiceId}: ${count} line item(s), ${tix} linked ticket(s)` : `Invoice ${a.invoiceId} not found` };
      }],

      // Tasks
      ['autotask_search_tasks', async (a) => {
        return paged(await s.searchTasks(a), 'tasks');
      }],
      ['autotask_create_task', async (a) => {
        const taskData = { ...a, taskType: a.taskType ?? 1 };
        const id = await s.createTask(taskData); return { result: id, message: `Successfully created task with ID: ${id}` };
      }],
      ['autotask_get_task', async (a) => {
        const r = await s.getTask(a.id); return { result: r, message: r ? `Task ${a.id}` : `Task ${a.id} not found` };
      }],
      ['autotask_update_task', async (a) => {
        const { id, ...rest } = a; await s.updateTask(id, rest); return { result: undefined, message: `Successfully updated task ${id}` };
      }],
      ['autotask_complete_task', async (a) => {
        await s.completeTask(a.id, { projectID: a.projectID, statusId: a.statusId });
        return { result: undefined, message: `Task ${a.id} marked complete` };
      }],
      ['autotask_list_task_resources', async (a) => {
        const r = await s.listTaskResources(a.taskID); return { result: r, message: `${r.length} secondary resource(s) on task ${a.taskID}` };
      }],
      ['autotask_add_task_resource', async (a) => {
        const id = await s.addTaskResource(a.taskID, a.resourceID, a.roleID); return { result: id, message: `Added resource ${a.resourceID} to task ${a.taskID} (row ${id})` };
      }],
      ['autotask_remove_task_resource', async (a) => {
        await s.removeTaskResource(a.id); return { result: undefined, message: `Removed task resource row ${a.id}` };
      }],
      ['autotask_list_task_predecessors', async (a) => {
        const r = await s.listTaskPredecessors(a.taskID); return { result: r, message: `${r.length} predecessor(s) for task ${a.taskID}` };
      }],
      ['autotask_add_task_predecessor', async (a) => {
        const id = await s.addTaskPredecessor(a.successorTaskID, a.predecessorTaskID, a.lagDays); return { result: id, message: `Task ${a.predecessorTaskID} → ${a.successorTaskID} (row ${id})` };
      }],
      ['autotask_remove_task_predecessor', async (a) => {
        await s.removeTaskPredecessor(a.id); return { result: undefined, message: `Removed task predecessor row ${a.id}` };
      }],
      ['autotask_get_task_predecessor', async (a) => {
        const r = await s.getTaskPredecessor(a.id); return { result: r, message: r ? `Task predecessor row ${a.id}` : `Task predecessor row ${a.id} not found` };
      }],
      ['autotask_search_task_predecessors', async (a) => {
        const r = await s.searchTaskPredecessors({ successorTaskID: a.successorTaskID, predecessorTaskID: a.predecessorTaskID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} task predecessor row(s)` };
      }],
      ['autotask_update_task_predecessor', async (a) => {
        await s.updateTaskPredecessor(a.id, a.lagDays); return { result: undefined, message: `Updated task predecessor row ${a.id} (lagDays=${a.lagDays})` };
      }],

      // Phases
      ['autotask_list_phases', async (a) => {
        return paged(await s.searchPhases(a.projectID, { page: a.page, pageSize: a.pageSize }), 'phases');
      }],
      ['autotask_create_phase', async (a) => {
        const id = await s.createPhase(a); return { result: id, message: `Successfully created phase with ID: ${id}` };
      }],
      ['autotask_get_phase', async (a) => {
        const r = await s.getPhase(a.id); return { result: r, message: r ? `Phase ${a.id}` : `Phase ${a.id} not found` };
      }],
      ['autotask_update_phase', async (a) => {
        const { id, ...rest } = a; await s.updatePhase(id, rest); return { result: undefined, message: `Successfully updated phase ${id}` };
      }],

      // Notes (ticket/project/company)
      ['autotask_get_ticket_note', async (a) => {
        const r = await s.getTicketNote(a.ticketId, a.noteId); return { result: r, message: 'Ticket note retrieved successfully' };
      }],
      ['autotask_search_ticket_notes', async (a) => {
        const r = await s.searchTicketNotes(a.ticketId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} ticket notes` };
      }],
      ['autotask_create_ticket_note', async (a) => {
        if (a.noteType === undefined || a.noteType === null) {
          throw new Error('noteType is required. Picklist values are tenant-specific — call autotask_get_field_info with entityType "TicketNotes" and fieldName "noteType" to discover the correct ID.');
        }
        if (a.publish === undefined || a.publish === null) {
          throw new Error('publish is required and security-sensitive (controls client visibility). Picklist values are tenant-specific — call autotask_get_field_info with entityType "TicketNotes" and fieldName "publish" to discover the correct ID.');
        }
        const id = await s.createTicketNote(a.ticketId, {
          title: a.title || 'Note',
          description: a.description,
          noteType: a.noteType,
          publish: a.publish
        });
        return { result: id, message: `Successfully created ticket note with ID: ${id}` };
      }],
      // Ticket Checklist Items
      ['autotask_search_ticket_checklist_items', async (a) => {
        const r = await s.searchTicketChecklistItems(a.ticketId);
        return { result: r, message: `Found ${r.length} checklist items` };
      }],
      ['autotask_create_ticket_checklist_item', async (a) => {
        const id = await s.createTicketChecklistItem(a.ticketId, {
          itemName: a.itemName,
          position: a.position,
          isCompleted: a.isCompleted
        });
        return { result: id, message: `Successfully created ticket checklist item with ID: ${id}` };
      }],
      ['autotask_update_ticket_checklist_item', async (a) => {
        await s.updateTicketChecklistItem(a.ticketId, a.itemId, {
          itemName: a.itemName,
          isCompleted: a.isCompleted,
          position: a.position
        });
        return { result: a.itemId, message: `Successfully updated ticket checklist item ${a.itemId}` };
      }],
      ['autotask_delete_ticket_checklist_item', async (a) => {
        await s.deleteTicketChecklistItem(a.ticketId, a.itemId);
        return { result: a.itemId, message: `Successfully deleted ticket checklist item ${a.itemId}` };
      }],

      // Checklist Libraries (§10)
      ['autotask_search_checklist_libraries', async (a) => {
        const r = await s.searchChecklistLibraries({ isActive: a.isActive, entityType: a.entityType, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} checklist librar${r.length === 1 ? 'y' : 'ies'}` };
      }],
      ['autotask_get_checklist_library', async (a) => {
        const r = await s.getChecklistLibrary(a.id);
        if (!r) return { result: null, message: `No checklist library found with ID ${a.id}` };
        return { result: r, message: `Retrieved checklist library ${a.id} with ${(r.items as any[])?.length ?? 0} item(s)` };
      }],
      ['autotask_apply_checklist_library_to_ticket', async (a) => {
        const r = await s.applyChecklistLibraryToTicket(a.ticketID, a.checklistLibraryID);
        const failed = r.itemErrors.length;
        return { result: r, message: `Applied checklist library ${a.checklistLibraryID} to ticket ${a.ticketID}: created ${r.created.length} item(s)` + (failed ? `, ${failed} failed` : '') };
      }],

      ['autotask_get_project_note', async (a) => {
        const r = await s.getProjectNote(a.projectId, a.noteId); return { result: r, message: 'Project note retrieved successfully' };
      }],
      ['autotask_search_project_notes', async (a) => {
        const r = await s.searchProjectNotes(a.projectId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} project notes` };
      }],
      ['autotask_create_project_note', async (a) => {
        const id = await s.createProjectNote(a.projectId, { title: a.title, description: a.description, noteType: a.noteType, publish: a.publish ?? 1, isAnnouncement: a.isAnnouncement ?? false });
        return { result: id, message: `Successfully created project note with ID: ${id}` };
      }],
      ['autotask_get_task_note', async (a) => {
        const r = await s.getTaskNote(a.taskId, a.noteId); return { result: r, message: r ? `Task note ${a.noteId}` : `Task note ${a.noteId} not found` };
      }],
      ['autotask_search_task_notes', async (a) => {
        const r = await s.searchTaskNotes(a.taskId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} task notes` };
      }],
      ['autotask_create_task_note', async (a) => {
        const note: Record<string, any> = { description: a.description };
        if (a.title !== undefined) note.title = a.title;
        if (a.noteType !== undefined) note.noteType = a.noteType;
        if (a.publish !== undefined) note.publish = a.publish;
        const id = await s.createTaskNote(a.taskId, note);
        return { result: id, message: `Successfully created task note with ID: ${id}` };
      }],
      ['autotask_search_project_attachments', async (a) => {
        const r = await s.searchProjectAttachments(a.projectId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} project attachment(s)` };
      }],
      ['autotask_search_task_attachments', async (a) => {
        const r = await s.searchTaskAttachments(a.taskId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} task attachment(s)` };
      }],
      ['autotask_get_company_note', async (a) => {
        const r = await s.getCompanyNote(a.companyId, a.noteId); return { result: r, message: 'Company note retrieved successfully' };
      }],
      ['autotask_search_company_notes', async (a) => {
        const r = await s.searchCompanyNotes(a.companyId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} company notes` };
      }],
      ['autotask_create_company_note', async (a) => {
        const id = await s.createCompanyNote(a.companyId, { title: a.title, description: a.description, actionType: a.actionType });
        return { result: id, message: `Successfully created company note with ID: ${id}` };
      }],

      // Attachments
      ['autotask_get_ticket_attachment', async (a) => {
        const r = await s.getTicketAttachment(a.ticketId, a.attachmentId, {
          includeData: a.includeData,
          maxInlineBase64Bytes: a.maxInlineBase64Bytes,
        });
        if (!r) return { result: null, message: `No ticket attachment found with ID ${a.attachmentId} on ticket ${a.ticketId}` };
        const message = r.dataOmittedReason
          ? `Ticket attachment retrieved (data omitted: oversized for inline transport)`
          : 'Ticket attachment retrieved successfully';
        return { result: r, message };
      }],
      ['autotask_search_ticket_attachments', async (a) => {
        const r = await s.searchTicketAttachments(a.ticketId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} ticket attachments` };
      }],
      ['autotask_create_ticket_attachment', async (a) => {
        // Never log `data` (base64 file bytes) — can be large / contain PII.
        const decodedBytes = typeof a.data === 'string'
          ? Buffer.from(a.data, 'base64').length
          : 0;
        this.logger.info(
          `autotask_create_ticket_attachment invoked: ticketId=${a.ticketId} title="${a.title}" bytes=${decodedBytes}`
        );
        const id = await s.createTicketAttachment(a.ticketId, {
          title: a.title,
          fullPath: a.fullPath || a.title,
          data: a.data,
          contentType: a.contentType,
          publish: a.publish ?? 1
        });
        return { result: id, message: `Successfully created ticket attachment with ID: ${id}` };
      }],
      ['autotask_get_project_attachment', async (a) => {
        const r = await s.getProjectAttachment(a.projectId, a.attachmentId, {
          includeData: a.includeData,
          maxInlineBase64Bytes: a.maxInlineBase64Bytes,
        });
        if (!r) return { result: null, message: `No project attachment found with ID ${a.attachmentId} on project ${a.projectId}` };
        const message = r.dataOmittedReason
          ? 'Project attachment retrieved (data omitted: oversized for inline transport)'
          : 'Project attachment retrieved successfully';
        return { result: r, message };
      }],
      ['autotask_create_project_attachment', async (a) => {
        // Never log `data` (base64 file bytes) — can be large / contain PII.
        const decodedBytes = typeof a.data === 'string' ? Buffer.from(a.data, 'base64').length : 0;
        this.logger.info(
          `autotask_create_project_attachment invoked: projectId=${a.projectId} title="${a.title}" bytes=${decodedBytes}`
        );
        const id = await s.createProjectAttachment(a.projectId, {
          title: a.title,
          fullPath: a.fullPath || a.title,
          data: a.data,
          contentType: a.contentType,
          publish: a.publish ?? 1
        });
        return { result: id, message: `Successfully created project attachment with ID: ${id}` };
      }],
      ['autotask_get_task_attachment', async (a) => {
        const r = await s.getTaskAttachment(a.taskId, a.attachmentId, {
          includeData: a.includeData,
          maxInlineBase64Bytes: a.maxInlineBase64Bytes,
        });
        if (!r) return { result: null, message: `No task attachment found with ID ${a.attachmentId} on task ${a.taskId}` };
        const message = r.dataOmittedReason
          ? 'Task attachment retrieved (data omitted: oversized for inline transport)'
          : 'Task attachment retrieved successfully';
        return { result: r, message };
      }],
      ['autotask_create_task_attachment', async (a) => {
        // Never log `data` (base64 file bytes) — can be large / contain PII.
        const decodedBytes = typeof a.data === 'string' ? Buffer.from(a.data, 'base64').length : 0;
        this.logger.info(
          `autotask_create_task_attachment invoked: taskId=${a.taskId} title="${a.title}" bytes=${decodedBytes}`
        );
        const id = await s.createTaskAttachment(a.taskId, {
          title: a.title,
          fullPath: a.fullPath || a.title,
          data: a.data,
          contentType: a.contentType,
          publish: a.publish ?? 1
        });
        return { result: id, message: `Successfully created task attachment with ID: ${id}` };
      }],

      // Expense Reports
      ['autotask_get_expense_report', async (a) => {
        const r = await s.getExpenseReport(a.reportId); return { result: r, message: 'Expense report retrieved successfully' };
      }],
      ['autotask_search_expense_reports', async (a) => {
        const r = await s.searchExpenseReports({ submitterId: a.submitterId, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} expense reports` };
      }],
      ['autotask_create_expense_report', async (a) => {
        const id = await s.createExpenseReport({ name: a.name, description: a.description, submitterID: a.submitterId, weekEnding: a.weekEndingDate || a.weekEnding });
        return { result: id, message: `Successfully created expense report with ID: ${id}` };
      }],

      // Expense Items
      ['autotask_create_expense_item', async (a) => {
        const id = await s.createExpenseItem({ expenseReportID: a.expenseReportId, description: a.description, expenseDate: a.expenseDate, expenseCategory: a.expenseCategory, expenseCurrencyExpenseAmount: a.amount, companyID: a.companyId ?? 0, haveReceipt: a.haveReceipt ?? false, isBillableToCompany: a.isBillableToCompany ?? false, isReimbursable: a.isReimbursable ?? true, paymentType: a.paymentType ?? 10 });
        return { result: id, message: `Successfully created expense item with ID: ${id}` };
      }],

      // Quotes
      ['autotask_get_quote', async (a) => {
        const r = await s.getQuote(a.quoteId); return { result: r, message: 'Quote retrieved successfully' };
      }],
      ['autotask_search_quotes', async (a) => {
        const r = await s.searchQuotes({ companyId: a.companyId, contactId: a.contactId, opportunityId: a.opportunityId, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} quotes` };
      }],
      ['autotask_create_quote', async (a) => {
        // Elicit company if not provided
        if (!a.companyId && this.mcpServer) {
          try {
            const companyId = await this.elicitCompanyId();
            if (companyId) a = { ...a, companyId: companyId };
          } catch { /* proceed without company */ }
        }

        // Elicit opportunity if not provided but company is known
        if (!a.opportunityId && a.companyId && this.mcpServer) {
          try {
            const opps = await s.searchOpportunities({ companyId: a.companyId });
            if (opps.length > 0) {
              const options: PicklistValue[] = opps
                .filter(o => o.id != null)
                .map(o => ({
                  value: String(o.id),
                  label: o.title || `Opportunity #${o.id}`,
                }));
              const selected = await this.elicitSelection(
                `Found ${opps.length} opportunities for this company. Which one should the quote be attached to?`,
                'opportunityId',
                options
              );
              if (selected) a = { ...a, opportunityId: Number(selected) };
            }
          } catch { /* proceed without opportunity */ }
        }

        const id = await s.createQuote({ name: a.name, description: a.description, companyID: a.companyId, contactID: a.contactId, opportunityID: a.opportunityId, effectiveDate: a.effectiveDate, expirationDate: a.expirationDate });
        return { result: id, message: `Successfully created quote with ID: ${id}` };
      }],

      // Opportunities
      ['autotask_get_opportunity', async (a) => {
        const r = await s.getOpportunity(a.opportunityId); return { result: r, message: 'Opportunity retrieved successfully' };
      }],
      ['autotask_search_opportunities', async (a) => {
        const r = await s.searchOpportunities({ companyId: a.companyId, searchTerm: a.searchTerm, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} opportunities` };
      }],
      ['autotask_create_opportunity', async (a) => {
        const id = await s.createOpportunity({ title: a.title, companyID: a.companyId, ownerResourceID: a.ownerResourceId, status: a.status, stage: a.stage, projectedCloseDate: a.projectedCloseDate, startDate: a.startDate, probability: a.probability ?? 50, amount: a.amount ?? 0, cost: a.cost ?? 0, useQuoteTotals: a.useQuoteTotals ?? true, totalAmountMonths: a.totalAmountMonths, contactID: a.contactId, description: a.description, opportunityCategoryID: a.opportunityCategoryID });
        return { result: id, message: `Successfully created opportunity with ID: ${id}` };
      }],
      ['autotask_update_opportunity', async (a) => {
        const updates: Record<string, any> = {};
        for (const f of ['title', 'status', 'stage', 'projectedCloseDate', 'startDate', 'amount', 'cost', 'probability', 'description'] as const) {
          if (a[f] !== undefined) updates[f] = a[f];
        }
        if (a.contactId !== undefined) updates.contactID = a.contactId;
        await s.updateOpportunity(a.opportunityId, updates);
        return { result: a.opportunityId, message: `Successfully updated opportunity ${a.opportunityId}` };
      }],

      // Products
      ['autotask_get_product', async (a) => {
        const r = await s.getProduct(a.productId); return { result: r, message: 'Product retrieved successfully' };
      }],
      ['autotask_search_products', async (a) => {
        const r = await s.searchProducts({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} products` };
      }],
      ['autotask_find_product', async (a) => {
        const r = await s.findProducts(a.query, { limit: a.limit, activeOnly: a.activeOnly, maxProducts: a.maxProducts });
        return { result: r, message: `${r.matchCount} match(es) for "${a.query}" across ${r.scanned} product(s)${r.truncated ? ' [catalog truncated]' : ''}` };
      }],
      ['autotask_list_product_categories', async (a) => {
        const r = await s.listProductCategories({ withCounts: a.withCounts, maxProducts: a.maxProducts });
        return { result: r, message: `${r.categoryCount} categories (${r.malformedCount} malformed)` };
      }],
      ['autotask_find_catalog_gaps', async (a) => {
        const r = await s.findCatalogGaps({ activeOnly: a.activeOnly, minDescriptionLength: a.minDescriptionLength, maxSamples: a.maxSamples, maxProducts: a.maxProducts });
        return { result: r, message: `${r.scanned} product(s): ${r.gaps.missingCategory.count} no-category, ${r.gaps.missingMsrp.count} no-MSRP, ${r.gaps.weakDescription.count} weak-description${r.truncated ? ' [truncated]' : ''}` };
      }],
      ['autotask_find_duplicate_products', async (a) => {
        const r = await s.findDuplicateProducts({ activeOnly: a.activeOnly, maxProducts: a.maxProducts, limit: a.limit });
        return { result: r, message: `${r.duplicateGroups} duplicate group(s) covering ${r.totalDuplicateProducts} product(s) of ${r.scanned} scanned${r.truncated ? ' [truncated]' : ''}` };
      }],
      // Catalog Phase B: guarded bulk writes (dry-run-first)
      ['autotask_bulk_update_products', async (a) => {
        const r = await s.bulkUpdateProducts({ updates: a.updates, dryRun: a.dryRun });
        const msg = r.status === 'dry_run' ? `Dry run: ${(r.plannedUpdates as any[])?.length ?? 0} product(s) would change; nothing written`
          : r.status === 'validation_failed' ? `Validation failed at "${r.step}": ${r.detail}`
          : `Updated ${r.updated} product(s)` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} error(s)` : '');
        return { result: r, message: msg };
      }],
      ['autotask_merge_products', async (a) => {
        const r = await s.mergeProducts({ survivorId: a.survivorId, duplicateIds: a.duplicateIds, enrichSurvivor: a.enrichSurvivor, dryRun: a.dryRun });
        const msg = r.status === 'dry_run' ? `Dry run: would deactivate ${(r.wouldDeactivate as any[])?.length ?? 0} dup(s) into survivor ${r.survivorId}` + ((r.onHandWarnings as any[])?.length ? `; ${(r.onHandWarnings as any[]).length} still hold stock` : '') + '; nothing written'
          : r.status === 'validation_failed' ? `Validation failed at "${r.step}": ${r.detail}`
          : `Merged: deactivated ${(r.deactivated as any[])?.length ?? 0} dup(s) into survivor ${r.survivorId}` + ((r.errors as any[])?.length ? ` with ${(r.errors as any[]).length} error(s)` : '');
        return { result: r, message: msg };
      }],
      // Product CRUD (full access)
      ['autotask_create_product', async (a) => {
        const id = await s.createProduct(a); return { result: id, message: `Created product ${id}` };
      }],
      ['autotask_update_product', async (a) => {
        const { id, ...rest } = a; await s.updateProduct(id, rest); return { result: undefined, message: `Updated product ${id}` };
      }],
      // Inventory products (stock at a location)
      ['autotask_search_inventory_products', async (a) => {
        const r = await s.searchInventoryProducts({ productID: a.productID, inventoryLocationID: a.inventoryLocationID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} inventory-product record(s)` };
      }],
      ['autotask_get_inventory_product', async (a) => {
        const r = await s.getInventoryProduct(a.id); return { result: r, message: r ? `Inventory product ${a.id}` : `Inventory product ${a.id} not found` };
      }],
      ['autotask_create_inventory_product', async (a) => {
        const id = await s.createInventoryProduct(a); return { result: id, message: `Created inventory-product ${id}` };
      }],
      ['autotask_update_inventory_product', async (a) => {
        const { id, ...rest } = a; await s.updateInventoryProduct(id, rest); return { result: undefined, message: `Updated inventory-product ${id}` };
      }],
      // Inventory locations
      ['autotask_search_inventory_locations', async (a) => {
        const r = await s.searchInventoryLocations({ isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} inventory location(s)` };
      }],
      ['autotask_get_inventory_location', async (a) => {
        const r = await s.getInventoryLocation(a.id); return { result: r, message: r ? `Inventory location ${a.id}` : `Inventory location ${a.id} not found` };
      }],
      ['autotask_create_inventory_location', async (a) => {
        const id = await s.createInventoryLocation(a); return { result: id, message: `Created inventory location ${id}` };
      }],
      ['autotask_update_inventory_location', async (a) => {
        const { id, ...rest } = a; await s.updateInventoryLocation(id, rest); return { result: undefined, message: `Updated inventory location ${id}` };
      }],
      // Stocked items (units / serials / counts)
      ['autotask_search_inventory_stocked_items', async (a) => {
        const r = await s.searchInventoryStockedItems({ inventoryProductID: a.inventoryProductID, currentInventoryLocationID: a.currentInventoryLocationID, serialNumber: a.serialNumber, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} stocked-item record(s)` };
      }],
      ['autotask_get_inventory_stocked_item', async (a) => {
        const r = await s.getInventoryStockedItem(a.id); return { result: r, message: r ? `Stocked item ${a.id}` : `Stocked item ${a.id} not found` };
      }],
      // Transfers + count adjustments (inventory-movement: need confirm:true)
      ['autotask_search_inventory_transfers', async (a) => {
        const r = await s.searchInventoryTransfers({ productID: a.productID, fromLocationID: a.fromLocationID, toLocationID: a.toLocationID, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} transfer(s)` };
      }],
      ['autotask_create_inventory_transfer', async (a) => {
        const id = await s.createInventoryTransfer(a); return { result: id, message: `Created inventory transfer ${id} (${a.quantityTransferred} of product ${a.productID}: ${a.fromLocationID}→${a.toLocationID})` };
      }],
      ['autotask_add_inventory_stock', async (a) => {
        const id = await s.addInventoryStock(a); return { result: id, message: `Added ${a.quantityBeingAdded} unit(s) to inventory-product ${a.inventoryProductID} (adjustment ${id})` };
      }],
      ['autotask_remove_inventory_stock', async (a) => {
        const id = await s.removeInventoryStock(a); return { result: id, message: `Removed ${a.quantityBeingRemoved} unit(s) from inventory-product ${a.inventoryProductID} (adjustment ${id})` };
      }],

      // Services
      ['autotask_get_service', async (a) => {
        const r = await s.getService(a.serviceId); return { result: r, message: 'Service retrieved successfully' };
      }],
      ['autotask_search_services', async (a) => {
        const r = await s.searchServices({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} services` };
      }],

      // Service Bundles
      ['autotask_get_service_bundle', async (a) => {
        const r = await s.getServiceBundle(a.serviceBundleId); return { result: r, message: 'Service bundle retrieved successfully' };
      }],
      ['autotask_search_service_bundles', async (a) => {
        const r = await s.searchServiceBundles({ searchTerm: a.searchTerm, isActive: a.isActive, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} service bundles` };
      }],

      // Quote Items
      ['autotask_get_quote_item', async (a) => {
        const r = await s.getQuoteItem(a.quoteItemId); return { result: r, message: 'Quote item retrieved successfully' };
      }],
      ['autotask_search_quote_items', async (a) => {
        const r = await s.searchQuoteItems({ quoteId: a.quoteId, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} quote items` };
      }],
      ['autotask_create_quote_item', async (a) => {
        // Elicit service/product selection when no ID is provided but name is available
        if (!a.serviceID && !a.productID && !a.serviceBundleID && a.name && this.mcpServer) {
          try {
            const itemChoice = await this.elicitItemSelection(a.name);
            if (itemChoice) a = { ...a, ...itemChoice };
          } catch { /* proceed as cost-type item */ }
        }

        const id = await s.createQuoteItem({ quoteID: a.quoteId, name: a.name, description: a.description, quantity: a.quantity, unitPrice: a.unitPrice, unitCost: a.unitCost, unitDiscount: a.unitDiscount, lineDiscount: a.lineDiscount, percentageDiscount: a.percentageDiscount, isOptional: a.isOptional, serviceID: a.serviceID, productID: a.productID, serviceBundleID: a.serviceBundleID, sortOrderID: a.sortOrderID, quoteItemType: a.quoteItemType });
        return { result: id, message: `Successfully created quote item with ID: ${id}` };
      }],
      ['autotask_update_quote_item', async (a) => {
        await s.updateQuoteItem(a.quoteItemId, { quantity: a.quantity, unitPrice: a.unitPrice, unitDiscount: a.unitDiscount, lineDiscount: a.lineDiscount, percentageDiscount: a.percentageDiscount, isOptional: a.isOptional, sortOrderID: a.sortOrderID });
        return { result: true, message: `Quote item ${a.quoteItemId} updated successfully` };
      }],
      ['autotask_delete_quote_item', async (a) => {
        await s.deleteQuoteItem(a.quoteId, a.quoteItemId); return { result: true, message: `Quote item ${a.quoteItemId} deleted successfully` };
      }],
      // Picklist tools
      ['autotask_list_queues', async () => {
        const queues = await this.picklistCache.getQueues();
        return { result: queues.map(q => ({ id: q.value, name: q.label, isActive: q.isActive })), message: `Found ${queues.length} queues` };
      }],
      ['autotask_list_ticket_statuses', async () => {
        const statuses = await this.picklistCache.getTicketStatuses();
        return { result: statuses.map(s => ({ id: s.value, name: s.label, isActive: s.isActive })), message: `Found ${statuses.length} ticket statuses` };
      }],
      ['autotask_list_ticket_priorities', async () => {
        const priorities = await this.picklistCache.getTicketPriorities();
        return { result: priorities.map(p => ({ id: p.value, name: p.label, isActive: p.isActive })), message: `Found ${priorities.length} ticket priorities` };
      }],
      ['autotask_get_field_info', async (a) => {
        // LLMs commonly pass `entity`/`field` instead of `entityType`/`fieldName`
        // (our own picklist error hints phrase it as "entity X and field Y"),
        // so accept those as aliases rather than crashing on undefined.
        const rawEntityType: unknown = a.entityType ?? a.entity;
        const rawFieldName: unknown = a.fieldName ?? a.field;
        if (typeof rawEntityType !== 'string' || rawEntityType.length === 0) {
          throw new Error('entityType is required — e.g. { "entityType": "Tickets" } or { "entityType": "TicketNotes", "fieldName": "noteType" }');
        }
        // Normalize common entity type aliases to correct Autotask REST API names
        const entityAliases: Record<string, string> = {
          'tasks': 'ProjectTasks',
          'task': 'ProjectTasks',
          'projecttask': 'ProjectTasks',
          'ticketnotes': 'TicketNotes',
          'projectnotes': 'ProjectNotes',
          'companynotes': 'CompanyNotes',
        };
        const entityType = entityAliases[rawEntityType.toLowerCase()] || rawEntityType;
        const fields = await this.picklistCache.getFields(entityType);
        if (typeof rawFieldName === 'string' && rawFieldName.length > 0) {
          const field = fields.find(f => f.name?.toLowerCase() === rawFieldName.toLowerCase());
          return { result: field || null, message: field ? `Field info for ${rawEntityType}.${rawFieldName}` : `Field '${rawFieldName}' not found on ${rawEntityType}` };
        }
        const summary = fields.map(f => ({ name: f.name, dataType: f.dataType, isRequired: f.isRequired, isPickList: f.isPickList, isQueryable: f.isQueryable, picklistValueCount: f.picklistValues?.length || 0 }));
        return { result: summary, message: `Found ${fields.length} fields for ${rawEntityType}` };
      }],
      ['autotask_resolve_picklist_value', async (a) => {
        // Note: the entityInformation/fields endpoint uses "Tasks" (not
        // "ProjectTasks", which 404s there) — pass the entity through as given.
        const r = await s.resolvePicklistValue(a.entity, a.field, a.label);
        return { result: r, message: r.status === 'matched' ? `${a.entity}.${a.field} "${a.label}" → ${r.value} (${r.label})` : `${a.entity}.${a.field} "${a.label}": ${r.status}` };
      }],

      // Billing Items (Approve and Post workflow)
      ['autotask_search_billing_items', async (a) => {
        const r = await s.searchBillingItems({
          companyId: a.companyId,
          ticketId: a.ticketId,
          projectId: a.projectId,
          contractId: a.contractId,
          invoiceId: a.invoiceId,
          isInvoiced: a.isInvoiced,
          dateFrom: a.dateFrom,
          dateTo: a.dateTo,
          postedAfter: a.postedAfter,
          postedBefore: a.postedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return paged(r, 'billing items');
      }],
      ['autotask_get_billing_item', async (a) => {
        const r = await s.getBillingItem(a.billingItemId);
        return { result: r, message: 'Billing item retrieved successfully' };
      }],

      // Billing Item Approval Levels
      ['autotask_search_billing_item_approval_levels', async (a) => {
        const r = await s.searchBillingItemApprovalLevels({
          timeEntryId: a.timeEntryId,
          approvalResourceId: a.approvalResourceId,
          approvalLevel: a.approvalLevel,
          approvedAfter: a.approvedAfter,
          approvedBefore: a.approvedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return paged(r, 'billing item approval levels');
      }],

      // Time Entries
      ['autotask_search_time_entries', async (a) => {
        const r = await s.searchTimeEntries({
          resourceId: a.resourceId,
          ticketId: a.ticketId,
          projectId: a.projectId,
          taskId: a.taskId,
          approvalStatus: a.approvalStatus,
          billable: a.billable,
          dateWorkedAfter: a.dateWorkedAfter,
          dateWorkedBefore: a.dateWorkedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return paged(r, 'time entries');
      }],
      ['autotask_get_time_entry', async (a) => {
        const r = await s.getTimeEntry(a.id);
        if (!r) return { result: null, message: `No time entry found with ID ${a.id}` };
        return { result: r, message: 'Time entry retrieved successfully' };
      }],
      ['autotask_update_time_entry', async (a) => {
        const { id, ...updates } = a;
        await s.updateTimeEntry(id, updates);
        return { result: id, message: `Successfully updated time entry ${id}` };
      }],

      // Meta-tools for progressive discovery
      ['autotask_list_categories', async () => {
        const categories = Object.entries(TOOL_CATEGORIES).map(([name, cat]) => ({
          name,
          description: cat.description,
          toolCount: cat.tools.length,
        }));
        return { result: categories, message: `Found ${categories.length} tool categories with ${Object.values(TOOL_CATEGORIES).reduce((sum, c) => sum + c.tools.length, 0)} total tools` };
      }],
      ['autotask_list_category_tools', async (a) => {
        const category = TOOL_CATEGORIES[a.category];
        if (!category) {
          const available = Object.keys(TOOL_CATEGORIES).join(', ');
          throw new Error(`Unknown category "${a.category}". Available: ${available}`);
        }
        const tools = TOOL_DEFINITIONS.filter(t => category.tools.includes(t.name));
        return { result: tools, message: `Found ${tools.length} tools in "${a.category}" category` };
      }],
      ['autotask_execute_tool', async (a, ctx) => {
        const toolName = a.toolName;
        const toolArgs = a.arguments || {};
        const handler = this.getDispatchTable().get(toolName);
        if (!handler) throw new Error(`Unknown tool: ${toolName}`);
        // Prevent recursive meta-tool calls
        if (toolName === 'autotask_execute_tool') throw new Error('Cannot recursively execute autotask_execute_tool');
        return handler(toolArgs, ctx);
      }],

      // Intent-based router
      ['autotask_router', async (a) => {
        const rawIntent = a.intent || '';
        const suggestion = this.routeIntent(rawIntent);
        return { result: suggestion, message: `Suggested tool: ${suggestion.suggestedTool}` };
      }],
    ]);
  }

  /**
   * Build a human-readable "not found" error message from the tool name and arguments.
   * Returns null if the result is NOT empty (i.e. no error needed).
   */
  private buildNotFoundMessage(name: string, args: Record<string, any>, result: any): string | null {
    // Single-entity "get" tools: result is null/undefined
    const isGetTool = name.startsWith('autotask_get_');
    if (isGetTool && (result === null || result === undefined)) {
      const entityLabel = name
        .replace('autotask_get_', '')
        .replace(/_/g, ' ');
      // Try to identify the ID arg used
      const idArg = Object.entries(args).find(([k]) =>
        /id$/i.test(k)
      );
      const idInfo = idArg ? ` with ${idArg[0]} ${idArg[1]}` : '';
      return `No ${entityLabel} found${idInfo}. Verify the ID is correct.`;
    }

    // Search tools: result is an empty array
    const isSearchTool = name.startsWith('autotask_search_') || name === 'autotask_search_tickets';
    if (isSearchTool && Array.isArray(result) && result.length === 0) {
      const entityLabel = name
        .replace('autotask_search_', '')
        .replace(/_/g, ' ');
      // Build a summary of the search criteria
      const criteria = Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      const criteriaInfo = criteria ? `: ${criteria}` : '';
      return `No ${entityLabel} found matching search criteria${criteriaInfo}. The search returned zero results — do not guess or fabricate data.`;
    }

    return null;
  }

  /**
   * Call a tool with the given arguments
   */
  /**
   * Resolve the caller to an Autotask resource for permissions + proxy data
   * input (§4.1). Order: explicit id/email/name → static AUTOTASK_USER_MAP →
   * in-memory cache → live email match. Caches any resolution under the caller's
   * keys so they are prompted at most once. Returns a structured identification
   * prompt when it can't resolve unambiguously.
   */
  async resolveCaller(
    ctx: CallerContext,
    explicit?: { resourceId?: number; resourceEmail?: string; resourceName?: string }
  ): Promise<CallerResolution> {
    const keys = callerMapKeys(ctx);
    const cacheAll = (res: ResolvedResource): void => {
      for (const k of keys) this.resourceCache.set(k, res);
    };
    const toCandidates = (
      ms: Array<{ id: number; firstName?: string; lastName?: string; email?: string }>
    ) => ms.map((m) => ({ id: m.id, name: resourceDisplayName(m), ...(m.email !== undefined ? { email: m.email } : {}) }));

    // 1. Explicit resource id (trusted; establishes/updates the mapping).
    if (explicit?.resourceId != null) {
      const res: ResolvedResource = { id: explicit.resourceId, name: explicit.resourceName ?? `Resource ${explicit.resourceId}` };
      cacheAll(res);
      return { status: 'resolved', via: 'explicit-id', resource: res };
    }
    // 2. Explicit email.
    if (explicit?.resourceEmail) {
      const r = classifyEmailMatch(explicit.resourceEmail, toCandidates(await this.autotaskService.searchResourcesByEmail(explicit.resourceEmail)));
      if (r.status === 'resolved') cacheAll(r.resource);
      return r;
    }
    // 3. Explicit name.
    if (explicit?.resourceName) {
      const m = await this.autotaskService.resolveResourceByName(explicit.resourceName);
      if (!m) return identificationRequired('not-found');
      const res: ResolvedResource = { id: m.id, name: resourceDisplayName(m) };
      cacheAll(res);
      return { status: 'resolved', via: 'explicit-name', resource: res };
    }
    // 3.5 Trusted gateway impersonation (#42): a verified gateway header (behind
    // S2S) said "act as this user". Trusted — outranks the payload email and the
    // static map, but not an explicit in-call resource (1-3). A resource id is
    // authoritative; an email is matched live against Autotask Resources.
    if (ctx.trustedActingResourceId != null) {
      const res: ResolvedResource = { id: ctx.trustedActingResourceId, name: `Resource ${ctx.trustedActingResourceId}` };
      cacheAll(res);
      return { status: 'resolved', via: 'gateway-impersonation', resource: res };
    }
    if (ctx.trustedActingUserEmail) {
      const r = classifyEmailMatch(ctx.trustedActingUserEmail, toCandidates(await this.autotaskService.searchResourcesByEmail(ctx.trustedActingUserEmail)));
      if (r.status === 'resolved') { cacheAll(r.resource); return { ...r, via: 'gateway-impersonation' }; }
      return r;
    }

    // 4. Static override map (Telegram handles / non-email identities).
    for (const k of keys) {
      const id = this.userMap.get(k);
      if (id != null) {
        const res: ResolvedResource = { id, name: `Resource ${id}` };
        cacheAll(res);
        return { status: 'resolved', via: 'static-map', resource: res };
      }
    }
    // 5. In-memory cache (already resolved this session).
    for (const k of keys) {
      const cached = this.resourceCache.get(k);
      if (cached) return { status: 'resolved', via: 'cache', resource: cached };
    }
    // 6. Live email match against Autotask Resources.
    if (ctx.requestingUserEmail) {
      const r = classifyEmailMatch(ctx.requestingUserEmail, toCandidates(await this.autotaskService.searchResourcesByEmail(ctx.requestingUserEmail)));
      if (r.status === 'resolved') cacheAll(r.resource);
      return r;
    }
    // 7. Nothing to go on.
    return identificationRequired('no-identity');
  }

  /**
   * Read-after-write verification for a create result (§2). Reads the just-
   * created entity back (bounded retry for Autotask's post-create read lag) and
   * returns the result augmented with `verified` and, when visible, `item`.
   *
   * Fail-safe by construction: the create's itemId is already authoritative, so
   * a read that never resolves (lag beyond budget) or that errors is reported as
   * `verified: false` — never re-thrown. Throwing here would make a successful
   * create look failed and invite a duplicate on rerun (§42).
   */
  private async verifyCreatedEntity(
    name: string,
    normalized: NormalizedCreateResult
  ): Promise<NormalizedCreateResult> {
    try {
      const item = await this.autotaskService.readEntityForVerification(
        normalized.entityType,
        normalized.id
      );
      if (item) {
        return { ...normalized, verified: true, item: item as Record<string, unknown> };
      }
      this.logger.warn(
        `Read-after-create for ${name} id=${normalized.id} (${normalized.entityType}): entity not visible within retry budget — returning verified:false (the create itemId is authoritative; do NOT recreate).`
      );
      return { ...normalized, verified: false };
    } catch (err) {
      // A payload anomaly / transport error on the read-back is a verification
      // failure, not a create failure. Surface verified:false and move on.
      this.logger.warn(
        `Read-after-create for ${name} id=${normalized.id} (${normalized.entityType}) errored: ${err instanceof Error ? err.message : String(err)} — returning verified:false.`
      );
      return { ...normalized, verified: false };
    }
  }

  /**
   * Emit one audit record: always to the structured log, and additionally to the
   * PG audit_log table when the sink is enabled (§23). The PG write is
   * fire-and-forget and never blocks or fails the call.
   */
  private recordAudit(ctx: CallerContext, entry: AuditEntry): void {
    emitAudit(this.logger, ctx, entry);
    this.auditSink?.record(ctx, entry);
  }

  async callTool(name: string, args: Record<string, any>, meta?: Record<string, any>): Promise<McpToolResult> {
    // Caller context (who/where/correlation) for audit + future permissions
    // (§3.5/§23). Strip the reserved `_context` key so it never reaches tool logic.
    const ctx = extractCallerContext(meta, args);
    // Overlay the trusted gateway acting identity (#42) — this comes from a
    // verified gateway header (behind S2S), NOT from the client payload, so it
    // outranks `requestingUserEmail` when resolving the caller (see resolveCaller).
    if (this.trustedActing) {
      if (this.trustedActing.resourceId != null) ctx.trustedActingResourceId = this.trustedActing.resourceId;
      if (this.trustedActing.email) ctx.trustedActingUserEmail = this.trustedActing.email;
    }
    // Attach the transport-derived origin captured at the HTTP entry (server-
    // side, via AsyncLocalStorage) so the audit trail records where the request
    // actually came from — not just the client-declared `source`.
    const origin = getRequestOrigin();
    if (origin) ctx.origin = origin;
    args = stripCallerContext(args);
    const startedAt = Date.now();
    this.logger.debug(`Calling tool: ${name}`, args);

    try {
      const handler = this.getDispatchTable().get(name);
      if (!handler) throw new Error(`Unknown tool: ${name}`);

      const risk = this.toolRisk.get(name) ?? 'reversible-update';

      // Permission gate (§4.2): the caller's functional role must permit this
      // tool's risk. Disabled unless MCP_PERMISSIONS_ENABLED=true, so the live
      // server is unaffected until roles are mapped. Denied before dispatch and
      // before the confirmation prompt — no point confirming what you can't do.
      if (isPermissionsEnabled() && isMutatingTool(name)) {
        const role: FunctionalRole | undefined = resolveRole(ctx, this.roleMap);
        const decision = evaluatePermission(role, risk);
        if (!decision.allowed) {
          const denied = buildPermissionDenied(name, risk, decision);
          this.recordAudit(ctx, { tool: name, outcome: 'permission-denied', durationMs: Date.now() - startedAt });
          return { content: [{ type: 'text', text: JSON.stringify({ message: denied.message, data: denied }) }] };
        }
      }

      // Raw-request gatekeeping (§3.4): administrator-only when permissions are
      // on, DELETE disabled by default, and a production read-only switch. The
      // HTTP layer already blocks absolute URLs / off-zone hosts / auth overrides.
      if (name === 'autotask_raw_request') {
        const role = resolveRole(ctx, this.roleMap);
        const decision = evaluateRawRequest({ method: args.method, role, permissionsEnabled: isPermissionsEnabled() });
        if (!decision.allowed) {
          const denied = buildRawRequestDenied(args.method, decision);
          this.recordAudit(ctx, { tool: name, outcome: 'permission-denied', durationMs: Date.now() - startedAt });
          return { content: [{ type: 'text', text: JSON.stringify({ message: denied.message, data: denied }) }] };
        }
      }

      // Risk-based confirmation gate (§4.3): destructive / financial / inventory
      // mutations require an explicit confirm:true before running. Read-only and
      // routine reversible updates pass through. `confirm` never reaches the tool.
      if (requiresExplicitConfirmation(risk) && args.confirm !== true) {
        const cr = buildConfirmationRequired(name, risk);
        this.recordAudit(ctx, { tool: name, outcome: 'confirmation-required', durationMs: Date.now() - startedAt });
        return { content: [{ type: 'text', text: JSON.stringify({ message: cr.message, data: cr }) }] };
      }
      if ('confirm' in args) {
        const { confirm: _confirm, ...rest } = args;
        args = rest;
      }

      // "My" tools (#42 slice 3) default to acting as the caller: if neither the
      // resource field nor an explicit currentUser was provided, assume currentUser.
      const defaultField = CURRENT_USER_DEFAULT_TOOLS[name];
      if (defaultField && args[defaultField] == null && args.currentUser == null && args.resourceName == null) {
        args = { ...args, currentUser: true };
      }

      // Proxy data input (§4.1): `currentUser: true` acts as the caller — resolve
      // them to an Autotask resource and write it into the tool's resource field,
      // or return the identity prompt when the caller can't be mapped.
      const actingField = ACTING_RESOURCE_TOOLS[name];
      if (actingField) {
        if (args.currentUser === true && args[actingField] == null) {
          let resolution = await this.resolveCaller(ctx);
          // Prompt-and-bind: when the app didn't identify the caller, ask them
          // for their Autotask username and bind it to this connection (#42).
          // Graceful — if the client can't be prompted, fall through to the
          // identification_required response for the assistant to relay.
          if (resolution.status !== 'resolved') {
            const elicited = await this.elicitAutotaskIdentity(ctx);
            if (elicited && elicited.status === 'resolved') resolution = elicited;
          }
          if (resolution.status !== 'resolved') {
            this.recordAudit(ctx, { tool: name, outcome: 'identification-required', durationMs: Date.now() - startedAt });
            return { content: [{ type: 'text', text: JSON.stringify({ message: resolution.message, data: resolution }) }] };
          }
          args = { ...args, [actingField]: resolution.resource.id };
        }
        if ('currentUser' in args) {
          const { currentUser: _drop, ...rest } = args;
          args = rest;
        }
      }

      // Role auto-fill (#42): when a tool's resource field is set (via currentUser
      // above or explicitly) but its paired role field is empty, fill the role
      // from the resource's default (Resources.defaultServiceDeskRoleID). An
      // explicit role always wins. Best-effort — a resource with no default role
      // leaves the field unset (Autotask then reports its own requirement error).
      const roleMap = ACTING_ROLE_FIELDS[name];
      if (roleMap && args[roleMap.resourceField] != null && args[roleMap.roleField] == null) {
        const roleId = await this.autotaskService.resolveResourceDefaultRole(args[roleMap.resourceField]);
        if (roleId != null) args = { ...args, [roleMap.roleField]: roleId };
      }

      // Idempotency (§4.4): for mutating tools, replay the prior result for a
      // repeated logical action instead of mutating twice. Keyed by a
      // caller-supplied idempotencyKey, or derived from caller + conversation +
      // tool + payload. No key (e.g. a context-free CLI call) → no dedup.
      const idempotencyKey = isMutatingTool(name) ? deriveIdempotencyKey(ctx, name, args) : undefined;
      if (idempotencyKey) {
        const cached = this.idempotencyStore.get(idempotencyKey);
        if (cached) {
          this.recordAudit(ctx, { tool: name, outcome: 'idempotent-replay', durationMs: Date.now() - startedAt });
          return cached;
        }
      }

      // Native Autotask impersonation (#42): for a mutating call, tunnel the
      // write on the acting user's behalf via ImpersonationResourceId. The
      // deployment's posture is set per-instance by AUTOTASK_IMPERSONATION_MODE:
      //
      //   off      no impersonation (integration user; e.g. n8n/cron instance)
      //   gateway  ONLY the trusted, S2S-verified gateway header may impersonate;
      //            the client payload never picks the acting user
      //   caller   resolve the CALLER (distinct from a ticket's assignee)
      //            best-effort and impersonate them, degrading to the integration
      //            user when unidentified (never prompts here)
      //
      // In `caller` mode an optional source allowlist
      // (AUTOTASK_IMPERSONATION_SOURCES) can bar impersonation for specific
      // declared sources (e.g. n8n) even on a shared instance.
      let impersonationResourceId: number | undefined;
      const impersonationMode = getImpersonationMode();
      if (impersonationMode !== 'off' && isMutatingTool(name)) {
        if (ctx.trustedActingResourceId != null) {
          impersonationResourceId = ctx.trustedActingResourceId;
        } else if (impersonationMode === 'caller' && isImpersonationAllowedForSource(ctx.source)) {
          const callerRes = await this.resolveCaller(ctx);
          if (callerRes.status === 'resolved') impersonationResourceId = callerRes.resource.id;
        }
      }

      const { result: rawResult, message, pagination } = await runWithRequestContext(
        {
          ...(impersonationResourceId != null ? { impersonationResourceId } : {}),
          // Preserve the origin captured at the HTTP entry across this nested
          // context so audit inside the dispatch still sees the calling container.
          ...(ctx.origin ? { origin: ctx.origin } : {}),
        },
        () => handler(args, ctx)
      );

      // Check for empty/not-found results and return explicit error to prevent hallucination
      const notFoundMsg = this.buildNotFoundMessage(name, args, rawResult);
      if (notFoundMsg) {
        this.logger.debug(`Not-found result for ${name}: ${notFoundMsg}`);
        this.recordAudit(ctx, { tool: name, outcome: 'not-found', durationMs: Date.now() - startedAt });
        return errorToolResult({ error: notFoundMsg, tool: name });
      }

      // Normalize create-tool ids into the { id, entityType, parentType?,
      // parentId? } contract (§5/§7.1) — one shape for every create, so callers
      // never special-case itemId vs item. Non-create results pass through.
      let result = normalizeCreateToolResult(name, args, rawResult);

      // Read-after-write verification (§2): for create tools flagged verifyRead
      // (Project-Builder entities), read the just-created entity back and attach
      // `item` + `verified`. The create's itemId is authoritative — this only
      // confirms/enriches — so it never converts a successful create into a
      // failure (which would risk a duplicate on rerun, §42).
      if (
        typeof rawResult === 'number' &&
        result !== null && typeof result === 'object' && !Array.isArray(result) &&
        CREATE_TOOL_META[name]?.verifyRead
      ) {
        result = await this.verifyCreatedEntity(name, result as NormalizedCreateResult);
      }

      // Format and enhance response
      let responseText: string;
      if (COMPACT_SEARCH_TOOLS.has(name) && Array.isArray(result)) {
        const entityType = detectEntityType(name);
        if (entityType) {
          const compact = formatCompactResponse(result, entityType, {
            page: args.page,
            pageSize: args.pageSize,
            ...(pagination ? { pagination } : {}),
          });
          compact.items = await this.enhanceItems(compact.items);
          responseText = JSON.stringify(compact);
        } else {
          const enhanced = await this.enhanceItems(result);
          responseText = JSON.stringify({ message, data: enhanced });
        }
      } else if (Array.isArray(result)) {
        const enhanced = await this.enhanceItems(result);
        responseText = JSON.stringify({ message, data: enhanced });
      } else if (result && typeof result === 'object' && !Array.isArray(result)) {
        const enhanced = await this.enhanceItems([result]);
        const data = enhanced[0] || result;
        // MCP Apps: attach the normalized card payload the ui:// ticket card
        // renders from. Best-effort — a null card just means no UI surface.
        if (name === 'autotask_get_ticket_details') {
          const card = await buildTicketCard(data, this.picklistCache, this.autotaskService, this.logger);
          if (card) data._card = card;
        }
        responseText = JSON.stringify({ message, data });
      } else {
        responseText = JSON.stringify({ message, data: result });
      }

      this.logger.debug(`Successfully executed tool: ${name}`);
      const resultId =
        result && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'number'
          ? (result as { id: number }).id
          : undefined;
      this.recordAudit(ctx, {
        tool: name,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
        ...(resultId !== undefined ? { resultId } : {}),
      });
      const finalResult: McpToolResult = { content: [{ type: 'text', text: responseText }] };
      // Cache successful mutations for idempotent replay. Errors and not-found
      // results are never cached, so a genuine failure can still be retried.
      if (idempotencyKey) this.idempotencyStore.set(idempotencyKey, finalResult);
      return finalResult;

    } catch (error) {
      this.logger.error(`Tool execution failed for ${name}:`, error);
      this.recordAudit(ctx, {
        tool: name,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Surface rate-limit errors with a typed envelope so LLM clients can
      // distinguish them from generic failures and stop retrying. Issue #91.
      if (error instanceof AutotaskRateLimitError) {
        return errorToolResult({
          error_type: 'rate_limited',
          error: error.message,
          retry_after_seconds: error.retryAfterSeconds,
          tool: name,
          // Belt-and-suspenders for LLM clients that don't parse error_type.
          instruction: 'Do not retry this call. Ask the user to narrow the query (e.g. filter by date range, company, or ticket ID) before issuing another Autotask request.',
        });
      }
      return errorToolResult({
        error: error instanceof Error ? error.message : 'Unknown error',
        tool: name,
      });
    }
  }
}

/**
 * Build a tool-result envelope for an error. Three call sites in callTool()
 * had assembled this shape inline; this helper keeps the JSON envelope
 * consistent so future error fields don't drift between paths.
 */
function errorToolResult(payload: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}