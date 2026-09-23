// Autotask Tool Definitions
// Declarative schema definitions for all MCP tools

import { McpTool } from './tool.handler.js';
import { TICKET_CARD_META } from './card.builder.js';

// Contract shell fields shared by autotask_create_contract and
// autotask_create_contracts_bulk (issue #237). Field names match the
// Autotask REST API exactly.
const CONTRACT_SHELL_PROPERTIES = {
  companyID: { type: 'number', description: 'Company ID the contract is associated with' },
  contractName: { type: 'string', description: 'Contract name' },
  contractType: { type: 'number', description: 'Contract type picklist ID' },
  contractCategory: { type: 'number', description: 'Contract category picklist ID' },
  startDate: { type: 'string', description: 'Contract start date (ISO YYYY-MM-DD)' },
  endDate: { type: 'string', description: 'Contract end date (ISO YYYY-MM-DD)' },
  contactID: { type: 'number', description: 'Primary contact ID for the contract' },
  contractNumber: { type: 'string', description: 'External-facing contract number' },
  contractPeriodType: { type: 'number', description: 'Period type picklist ID' },
  description: { type: 'string', description: 'Contract description / notes' },
  estimatedCost: { type: 'number', description: 'Estimated cost' },
  estimatedHours: { type: 'number', description: 'Estimated hours' },
  estimatedRevenue: { type: 'number', description: 'Estimated revenue' },
  setupFee: { type: 'number', description: 'Setup fee amount' },
  overageBillingRate: { type: 'number', description: 'Overage billing rate' },
  serviceLevelAgreementID: { type: 'number', description: 'SLA ID' },
  purchaseOrderNumber: { type: 'string', description: 'Customer purchase order number' },
  opportunityID: { type: 'number', description: 'Originating opportunity ID' },
  billingPreference: { type: 'number', description: 'Billing preference picklist ID' },
  billToCompanyID: { type: 'number', description: 'Bill-to company ID' },
  billToCompanyContactID: { type: 'number', description: 'Bill-to contact ID' },
  exclusionContractID: { type: 'number', description: 'Exclusion contract ID' },
  isDefaultContract: { type: 'boolean', description: 'Whether this is the default contract for the company' },
  internalCurrencySetupFee: { type: 'number', description: 'Setup fee in internal currency' },
  internalCurrencyOverageBillingRate: { type: 'number', description: 'Overage rate in internal currency' },
  organizationalLevelAssociationID: { type: 'number', description: 'Org level association ID' },
  contractExclusionSetID: { type: 'number', description: 'Contract exclusion set ID' },
  renewedContractID: { type: 'number', description: 'ID of the contract this renewed' },
  setupFeeBillingCodeID: { type: 'number', description: 'Billing code ID for the setup fee' },
  status: { type: 'number', description: 'Contract status (1=In Effect, 0=Inactive)' },
  timeReportingRequiresStartAndStopTimes: { type: 'number', description: 'Whether time entries require start/stop times' }
};

const CONTRACT_SHELL_REQUIRED = ['companyID', 'contractName', 'contractType', 'contractCategory', 'startDate', 'endDate'];

export const TOOL_DEFINITIONS: McpTool[] = [
  // Connection testing
  {
    name: 'autotask_test_connection',
    description: 'Test Autotask API connection',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  // Company tools
  {
    name: 'autotask_search_companies',
    description: 'Search companies by name or status. Max 200/page.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          
        },
        isActive: {
          type: 'boolean',
          
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 200',
          minimum: 1,
          maximum: 200
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_company',
    description: 'Create new company record',
    inputSchema: {
      type: 'object',
      properties: {
        companyName: {
          type: 'string',
          
        },
        companyType: {
          type: 'number',
          
        },
        phone: {
          type: 'string',
          
        },
        address1: {
          type: 'string',
          
        },
        city: {
          type: 'string',
          
        },
        state: {
          type: 'string',
          
        },
        postalCode: {
          type: 'string',
          
        },
        ownerResourceID: {
          type: 'number',
          
        },
        isActive: {
          type: 'boolean',
          
        }
      },
      required: ['companyName', 'companyType']
    }
  },
  {
    name: 'autotask_update_company',
    description: 'Update company record. invoiceTemplateID sets payment terms (103=Due on Receipt, 104=NET 30). Billing address fields separate from regular address.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          
        },
        companyName: {
          type: 'string',
          
        },
        phone: {
          type: 'string',
          
        },
        address1: {
          type: 'string',
          description: 'Regular address (distinct from billingAddress1)'
        },
        address2: {
          type: 'string',
          
        },
        city: {
          type: 'string',
          
        },
        state: {
          type: 'string',
          
        },
        postalCode: {
          type: 'string',
          
        },
        countryID: {
          type: 'number',
          description: 'e.g. 237 for United States'
        },
        isActive: {
          type: 'boolean',
          
        },
        webAddress: {
          type: 'string',
          description: 'Website URL (field name is webAddress)'
        },
        // ---- Billing-to fields (used for Invoice Settings; SEPARATE from regular address) ----
        billingAddress1: {
          type: 'string',
          description: 'For invoices (separate from address1)'
        },
        billingAddress2: {
          type: 'string',
          description: 'Billing address line 2'
        },
        billToAttention: {
          type: 'string',
          description: 'Bill-to attention name'
        },
        billToAddressToUse: {
          type: 'number',
          description: '1 = use bill-to fields explicitly'
        },
        billToCity: {
          type: 'string',
          description: 'Bill-to city'
        },
        billToState: {
          type: 'string',
          description: 'Bill-to state/province'
        },
        billToZipCode: {
          type: 'string',
          description: 'Bill-to ZIP/postal code'
        },
        billToCountryID: {
          type: 'number',
          description: 'Bill-to country ID'
        },
        billToCompanyLocationID: {
          type: 'number',
          description: 'Bill-to company location ID'
        },
        // ---- Tax / invoice settings ----
        taxRegionID: {
          type: 'number',
          description: 'Tax region ID (capital ID suffix per Autotask convention)'
        },
        invoiceTemplateID: {
          type: 'number',
          description: 'Invoice template ID applied to this company. Acts as the payment-terms selector (e.g. 103=Due on Receipt, 104=NET 30).'
        },
        invoiceMethod: {
          type: 'number',
          description: 'Invoice delivery method picklist ID (e.g. 2=Email)'
        },
        invoiceEmailMessageID: {
          type: 'number',
          description: 'Default email-message template ID used when invoicing this company'
        },
        taxID: {
          type: 'string',
          description: 'Tax registration / FEIN / VAT identifier string'
        },
        isTaxExempt: {
          type: 'boolean',
          description: 'Whether the company is tax-exempt. Note: Autotask field name is `isTaxExempt` — not `taxExempt`.'
        },
        // ---- Quote / PO templates ----
        quoteEmailMessageID: {
          type: 'number',
          description: 'Default email-message template ID used when sending quotes'
        },
        quoteTemplateID: {
          type: 'number',
          description: 'Default quote template ID for this company'
        },
        purchaseOrderTemplateID: {
          type: 'number',
          description: 'Default purchase-order template ID for this company'
        },
        // ---- Ownership / classification ----
        ownerResourceID: {
          type: 'number',
          description: 'Resource ID of the account owner'
        },
        classification: {
          type: 'number',
          description: 'Company classification picklist ID'
        },
        companyType: {
          type: 'number',
          description: 'Company type picklist ID (e.g. Customer, Prospect, Vendor)'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_get_company_site_configuration',
    description: 'Get company site configuration records. Call first to discover available fields.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID whose site configuration records should be returned'
        }
      },
      required: ['companyId']
    }
  },
  {
    name: 'autotask_update_company_site_configuration',
    description: 'Update company site configuration. Fields are tenant-defined; call get first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The company site configuration record ID to update (obtained from autotask_get_company_site_configuration).'
        },
        updates: {
          type: 'object',
          description: 'Object containing the site configuration fields to update. Field names are tenant-specific.',
          additionalProperties: true
        }
      },
      required: ['id', 'updates']
    }
  },

  // Contact tools
  {
    name: 'autotask_search_contacts',
    description: 'Search contacts by name, email, or company. Max 200/page.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for contact name or email'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        isActive: {
          type: 'number',
          description: 'Filter by active status (1=active, 0=inactive)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 200',
          minimum: 1,
          maximum: 200
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_contact',
    description: 'Create new contact record',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Company ID for the contact'
        },
        firstName: {
          type: 'string',
          
        },
        lastName: {
          type: 'string',
          
        },
        emailAddress: {
          type: 'string',
          
        },
        phone: {
          type: 'string',
          
        },
        title: {
          type: 'string',
          
        }
      },
      required: ['companyID', 'firstName', 'lastName']
    }
  },
  {
    name: 'autotask_find_or_create_contact',
    description: 'Find a contact in a company by email address, or create it if none exists. Idempotent — returns the same contact on a repeat instead of creating a duplicate, and avoids the create-then-read race. Returns the contact id and whether it was newly created. Prefer this over create_contact when a contact may already exist (e.g. inbound email automation).',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Company the contact belongs to' },
        emailAddress: { type: 'string', description: 'Email used to match an existing contact (and set on create)' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string' },
        title: { type: 'string' }
      },
      required: ['companyID']
    }
  },
  {
    name: 'autotask_update_contact',
    description: 'Update contact record. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Contact ID to update'
        },
        firstName: {
          type: 'string',
          
        },
        lastName: {
          type: 'string',
          
        },
        emailAddress: {
          type: 'string',
          description: 'Primary email address'
        },
        phone: {
          type: 'string',
          description: 'Primary phone number'
        },
        title: {
          type: 'string',
          description: 'Job title'
        },
        isActive: {
          type: 'boolean',
          description: 'Whether the contact is active'
        },
        mobilePhone: {
          type: 'string',
          description: 'Mobile phone number'
        },
        addressLine: {
          type: 'string',
          description: 'Address line (primary)'
        },
        addressLine1: {
          type: 'string',
          description: 'Address line 1 (secondary)'
        },
        city: {
          type: 'string',
          description: 'City'
        },
        state: {
          type: 'string',
          description: 'State/province'
        },
        zipCode: {
          type: 'string',
          description: 'Postal/ZIP code'
        },
        countryID: {
          type: 'number',
          description: 'Country ID (Autotask Countries entity)'
        },
        primaryContact: {
          type: 'boolean',
          description: 'Whether this contact is the primary contact for their company'
        },
        userDefinedFields: {
          type: 'array',
          description: 'User-defined (custom) fields for the contact, as an array of { name, value } objects matching the Autotask REST API shape. Contacts support UDFs (hasUserDefinedFields: true).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'UDF name' },
              value: { type: 'string', description: 'UDF value (stringified)' }
            },
            required: ['name', 'value']
          }
        }
      },
      required: ['id']
    }
  },

  // Ticket tools
  {
    name: 'autotask_search_tickets',
    description: 'Search tickets by company, queue, status, priority. Use autotask_get_ticket_details for full data. Max 500/page.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search by ticket number prefix'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        contactID: {
          type: 'number',
          description: 'Filter by primary contact ID — returns only tickets where contactID matches'
        },
        status: {
          type: 'number',
          description: 'Filter by ticket status ID (omit for all open tickets)'
        },
        priority: {
          type: 'number',
          description: 'Filter by ticket priority ID. Use autotask_list_ticket_priorities to discover valid IDs.'
        },
        queueID: {
          type: 'number',
          description: 'Filter by queue ID. Use autotask_list_queues to discover valid IDs.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Filter by assigned resource ID'
        },
        unassigned: {
          type: 'boolean',
          description: 'Set to true to find unassigned tickets'
        },
        createdAfter: {
          type: 'string',
          description: 'Filter tickets created on or after this date (ISO format, e.g. 2026-01-01)'
        },
        createdBefore: {
          type: 'string',
          description: 'Filter tickets created on or before this date (ISO format)'
        },
        lastActivityAfter: {
          type: 'string',
          description: 'Filter tickets with activity on or after this date (ISO format)'
        },
        externalID: {
          type: 'string',
          description: 'Filter by external correlation id (occurrence/idempotency key). For a dedicated idempotency check use autotask_find_ticket_by_external_id.'
        },
        page: {
          type: 'number',

          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_ticket_details',
    description: 'Get full ticket details including notes, time entries, and custom fields.',
    _meta: TICKET_CARD_META,
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID to retrieve'
        },
        fullDetails: {
          type: 'boolean',
          description: 'Whether to return full ticket details (default: false for optimized data)',
          default: false
        }
      },
      required: ['ticketID']
    }
  },
  {
    name: 'autotask_create_ticket',
    description: 'Create new ticket record',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Company ID for the ticket'
        },
        title: {
          type: 'string',
          
        },
        description: {
          type: 'string',
          
        },
        status: {
          type: 'number',
          
        },
        priority: {
          type: 'number',
          
        },
        assignedResourceID: {
          type: 'number',
          description: 'Assigned resource ID. If set, assignedResourceRoleID is also required by Autotask (auto-filled from the resource\'s default role when omitted). Use currentUser:true to assign to the calling user.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role ID for the assigned resource. Required by Autotask when assignedResourceID is set; auto-filled from the resource\'s defaultServiceDeskRoleID when omitted. Pass explicitly to override. Discover roles with autotask_search_roles / autotask_get_resource_roles.'
        },
        currentUser: {
          type: 'boolean',
          description: 'Assign to the calling user — resolves the caller to their Autotask resource (assignedResourceID) and auto-fills their default role. Alternative to assignedResourceID.'
        },
        contactID: {
          type: 'number',
          description: 'Contact ID for the ticket'
        },
        queueID: {
          type: 'number',
          description: 'Queue ID to route the ticket to. Use autotask_list_queues to discover valid IDs.'
        },
        ticketCategory: {
          type: 'number',
          description: 'Ticket category ID (picklist). Use autotask_get_field_info with entityType "Tickets" and fieldName "ticketCategory" to discover valid values.'
        },
        ticketType: {
          type: 'number',
          description: 'Ticket type ID (picklist, e.g. Service Request, Incident, Problem, Change).'
        },
        issueType: {
          type: 'number',
          description: 'First-level issue type ID (picklist). Required context for subIssueType. Use autotask_get_field_info (entityType "Tickets", fieldName "issueType") to discover valid values.'
        },
        subIssueType: {
          type: 'number',
          description: 'Sub issue type ID (picklist). Must be valid for the selected issueType. Use autotask_get_field_info (entityType "Tickets", fieldName "subIssueType") to discover valid values.'
        },
        source: {
          type: 'number',
          description: 'Ticket source ID (picklist, e.g. Phone, Email, Portal). Use autotask_get_field_info (entityType "Tickets", fieldName "source") to discover valid values.'
        },
        billingCodeID: {
          type: 'number',
          description: 'Work type / billing code ID used for billing this ticket.'
        },
        serviceLevelAgreementID: {
          type: 'number',
          description: 'Service Level Agreement (SLA) ID to apply to the ticket.'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours of work for the ticket.'
        },
        projectID: {
          type: 'number',
          description: 'Project ID to associate the ticket with. Links the ticket to an existing project.'
        },
        ticketAdditionalContacts: {
          type: 'array',
          items: { type: 'number' },
          description: 'Additional contact IDs to associate with the ticket (beyond the primary contactID).'
        },
        resolution: {
          type: 'string',
          description: 'Ticket-level resolution text. This is the Resolution field on the ticket itself, NOT a ticket note.'
        },
        userDefinedFields: {
          type: 'array',
          description: 'User-defined (custom) fields for the ticket, as an array of { name, value } objects matching the Autotask REST API shape.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'UDF name' },
              value: { type: 'string', description: 'UDF value (stringified)' }
            },
            required: ['name', 'value']
          }
        },
        dueDateTime: {
          type: 'string',
          description: 'Ticket due date/time (ISO 8601). Setting it on create avoids a second update that retriggers workflow rules.'
        },
        companyLocationID: {
          type: 'number',
          description: 'Company location ID. Must belong to companyID. Use autotask_move_ticket_to_company when changing companies so the location stays compatible.'
        },
        configurationItemID: {
          type: 'number',
          description: 'Primary associated configuration item (asset) ID. Must belong to the same company.'
        },
        contractID: {
          type: 'number',
          description: 'Contract this ticket bills against / is delivered under.'
        },
        contractServiceID: {
          type: 'number',
          description: 'Contract service line the ticket is delivered under. Must belong to contractID.'
        },
        contractServiceBundleID: {
          type: 'number',
          description: 'Contract service bundle the ticket is delivered under. Must belong to contractID.'
        },
        externalID: {
          type: 'string',
          description: 'External correlation id (idempotency / occurrence key, e.g. "CS-88321:LOC-231:FIRMWARE:2026-09"). Search with autotask_find_ticket_by_external_id BEFORE creating to avoid duplicate occurrences.'
        },
        problemTicketId: {
          type: 'number',
          description: 'Parent problem ticket ID — files this ticket as an incident under a problem ticket.'
        },
        additionalConfigurationItemIDs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Convenience: extra configuration item IDs to link (beyond the primary configurationItemID). When provided, the ticket is created, each CI is linked via TicketAdditionalConfigurationItems, and the ticket + associations are read back and returned enriched.'
        }
      },
      required: ['companyID', 'title', 'description']
    }
  },
  {
    name: 'autotask_find_ticket_by_external_id',
    description: 'Find ticket(s) by external correlation id (occurrence/idempotency key). Call this BEFORE creating a recurring/maintenance ticket: if a ticket already exists for the occurrence key, do NOT create a duplicate. Returns full matching ticket records (externalID preserved); externalID is not enforced-unique, so all matches are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        externalID: { type: 'string', description: 'The external correlation id / occurrence key to look up' }
      },
      required: ['externalID']
    },
    annotations: { title: 'Find ticket by external ID', readOnlyHint: true }
  },
  {
    name: 'autotask_search_ticket_configuration_items',
    description: 'List the additional configuration items linked to a ticket (TicketAdditionalConfigurationItems — the CIs beyond the ticket\'s primary configurationItemID). Optionally filter to a single CI to check whether it is already linked.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket whose additional CI links to list' },
        configurationItemID: { type: 'number', description: 'Optional: only the association for this CI (existence check)' }
      },
      required: ['ticketID']
    },
    annotations: { title: 'List ticket additional configuration items', readOnlyHint: true }
  },
  {
    name: 'autotask_add_ticket_configuration_item',
    description: 'Link an additional configuration item to a ticket (creates a TicketAdditionalConfigurationItems association). Returns the new association id.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket to link the CI to' },
        configurationItemID: { type: 'number', description: 'The configuration item (asset) to link' }
      },
      required: ['ticketID', 'configurationItemID']
    }
  },
  {
    name: 'autotask_remove_ticket_configuration_item',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Removes an additional configuration item link from a ticket ' +
      '(deletes the TicketAdditionalConfigurationItems association by its association id — NOT the CI itself). ' +
      'Find the association id first with autotask_search_ticket_configuration_items. Confirm with the user before invoking.',
    annotations: {
      title: 'Remove ticket additional configuration item (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The parent ticket ID (for context/safety)' },
        associationID: { type: 'number', description: 'The TicketAdditionalConfigurationItems association id to remove (from autotask_search_ticket_configuration_items)' }
      },
      required: ['associationID']
    }
  },
  {
    name: 'autotask_update_ticket',
    description: 'Update ticket record. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ID of the ticket to update'
        },
        title: {
          type: 'string',
          
        },
        description: {
          type: 'string',
          
        },
        status: {
          type: 'number',
          description: 'Ticket status ID (use autotask_list_ticket_statuses to find valid IDs)'
        },
        priority: {
          type: 'number',
          description: 'Ticket priority ID (use autotask_list_ticket_priorities to find valid IDs)'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Assigned resource ID. If set, assignedResourceRoleID is also required by Autotask (auto-filled from the resource\'s default role when omitted). Use currentUser:true to assign to the calling user.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role ID for the assigned resource. Required by Autotask when assignedResourceID is set; auto-filled from the resource\'s defaultServiceDeskRoleID when omitted. Pass explicitly to override. Discover roles with autotask_search_roles / autotask_get_resource_roles.'
        },
        currentUser: {
          type: 'boolean',
          description: 'Assign to the calling user — resolves the caller to their Autotask resource (assignedResourceID) and auto-fills their default role. Alternative to assignedResourceID.'
        },
        dueDateTime: {
          type: 'string',
          description: 'Due date and time in ISO 8601 format (e.g. 2026-03-15T17:00:00Z)'
        },
        contactID: {
          type: 'number',
          description: 'Contact ID for the ticket'
        },
        issueType: {
          type: 'number',
          description: 'First-level issue type ID (picklist). Required context for subIssueType. Use autotask_get_field_info (entityType "Tickets", fieldName "issueType") to discover valid values.'
        },
        subIssueType: {
          type: 'number',
          description: 'Sub issue type ID (picklist). Must be valid for the selected issueType. Use autotask_get_field_info (entityType "Tickets", fieldName "subIssueType") to discover valid values.'
        },
        companyLocationID: {
          type: 'number',
          description: 'Company location ID. Must belong to the ticket\'s company. To change companies, use autotask_move_ticket_to_company instead so the location stays compatible.'
        },
        configurationItemID: {
          type: 'number',
          description: 'Associated configuration item (asset) ID. Must belong to the ticket\'s company.'
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_move_ticket_to_company',
    description:
      'Safely move a ticket to another company. Resolves the target company\'s ' +
      'primary location and sets companyID + companyLocationID together (changing ' +
      'companyID alone leaves an incompatible location). Refuses to move a ticket ' +
      'linked to a configuration item unless force is set (that can break the ' +
      'RMM-to-Autotask device link), and clears the contact unless a target ' +
      'contact is supplied. Reads back to verify. Confirm with the user first.',
    annotations: { title: 'Move ticket to another company', readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'number', description: 'The ticket to move' },
        companyID: { type: 'number', description: 'Target company ID' },
        contactID: { type: 'number', description: 'Optional target-company contact; the contact is cleared if omitted' },
        force: { type: 'boolean', description: 'Override the configuration-item safety block (not recommended)' }
      },
      required: ['ticketId', 'companyID']
    }
  },

  // Ticket Charge tools
  {
    name: 'autotask_get_ticket_charge',
    description: 'Get a specific ticket charge by ID',
    inputSchema: {
      type: 'object',
      properties: {
        chargeId: {
          type: 'number',
          description: 'The ticket charge ID to retrieve'
        }
      },
      required: ['chargeId']
    }
  },
  {
    name: 'autotask_search_ticket_charges',
    description: 'Search ticket charges (materials, costs, expenses). Provide ticketId for best performance. Max 10 if unfiltered.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID (recommended)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_ticket_charge',
    description: 'Create charge on ticket for materials, costs, or expenses.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID to add the charge to'
        },
        name: {
          type: 'string',
          description: 'Charge name/title'
        },
        description: {
          type: 'string',
          description: 'Charge description'
        },
        chargeType: {
          type: 'number',
          description: 'Charge type picklist ID (use autotask_get_field_info with entityType "TicketCharges" to find valid values)'
        },
        unitQuantity: {
          type: 'number',
          description: 'Quantity of units'
        },
        unitPrice: {
          type: 'number',
          description: 'Price per unit'
        },
        unitCost: {
          type: 'number',
          description: 'Cost per unit'
        },
        datePurchased: {
          type: 'string',
          description: 'Date the charge was incurred (YYYY-MM-DD format)'
        },
        productID: {
          type: 'number',
          description: 'Associated product ID (optional)'
        },
        billingCodeID: {
          type: 'number',
          description: 'Billing code ID for categorization'
        },
        billableToAccount: {
          type: 'boolean',
          description: 'Whether this charge is billable to the client (default: true)'
        },
        status: {
          type: 'number',
          description: 'Charge status picklist ID'
        }
      },
      required: ['ticketID', 'name', 'chargeType']
    }
  },
  {
    name: 'autotask_update_ticket_charge',
    description: 'Update an existing ticket charge. Only fields provided will be changed.',
    inputSchema: {
      type: 'object',
      properties: {
        chargeId: {
          type: 'number',
          description: 'The charge ID to update'
        },
        name: {
          type: 'string',
          description: 'Updated charge name'
        },
        description: {
          type: 'string',
          description: 'Updated description'
        },
        unitQuantity: {
          type: 'number',
          description: 'Updated quantity'
        },
        unitPrice: {
          type: 'number',
          description: 'Updated unit price'
        },
        unitCost: {
          type: 'number',
          description: 'Updated unit cost'
        },
        billableToAccount: {
          type: 'boolean',
          description: 'Updated billable status'
        },
        status: {
          type: 'number',
          description: 'Updated status'
        }
      },
      required: ['chargeId']
    }
  },
  {
    name: 'autotask_delete_ticket_charge',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a ticket charge ' +
      'record and all associated billing data. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete ticket charge (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The parent ticket ID'
        },
        chargeId: {
          type: 'number',
          description: 'The charge ID to delete'
        }
      },
      required: ['ticketId', 'chargeId']
    }
  },

  // Ticket History tools (read-only audit trail of field changes)
  {
    name: 'autotask_get_ticket_history',
    description: 'Get a single ticket history entry by ID. Each entry records one audited change to a ticket field (who, when, before/after).',
    inputSchema: {
      type: 'object',
      properties: {
        historyId: {
          type: 'number',
          description: 'The ticket history entry ID to retrieve'
        }
      },
      required: ['historyId']
    }
  },
  {
    name: 'autotask_search_ticket_history',
    description: 'Get the audit trail of field changes for a ticket (status transitions, assignment changes, priority edits, etc.). Use this to answer questions like "when did this ticket move from In Progress to Waiting Customer" or "who changed the priority". Returns entries ordered by Autotask; sort/filter client-side if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to get history for (required — Autotask does not support unscoped history queries)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of history entries to return (default: 50, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: ['ticketId']
    }
  },

  // Time entry tools
  {
    name: 'autotask_create_time_entry',
    description: 'Create a time entry in Autotask. Can be tied to a ticket, task, or project, OR created as "Regular Time" (no parent) for meetings, admin work, etc. For Regular Time, specify a category like "Internal Meeting", "Office Management", "Training", etc.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID for the time entry (omit for Regular Time)'
        },
        taskID: {
          type: 'number',
          description: 'Task ID for the time entry. Project work is logged against a project TASK — use this (not projectID) for project time.'
        },
        projectID: {
          type: 'number',
          description: 'Deprecated: Autotask time entries have no projectID field. Project time attaches to a project task — pass that task as taskID. A project-only entry is rejected.'
        },
        resourceID: {
          type: 'number',
          description: 'Resource ID (user) logging the time. Can be omitted if resourceName is provided.'
        },
        resourceName: {
          type: 'string',
          description: 'Name of the resource/user (e.g., "Will Spence"). Will be resolved to a resourceID automatically. Use this instead of resourceID for convenience.'
        },
        currentUser: {
          type: 'boolean',
          description: 'Log the time as the calling user — resolves the caller to their Autotask resource. Alternative to resourceID/resourceName.'
        },
        roleID: {
          type: 'number',
          description: 'Role ID for the time entry (required by Autotask for ticket/task time). When omitted it is auto-filled from the resource\'s default service-desk role, or its sole role; if the resource has multiple roles and no single default, the tool returns the role choices (roleID → name) to pick from rather than guessing. Discover roles with autotask_get_resource_roles.'
        },
        category: {
          type: 'string',
          description: 'Category name for Regular Time entries (e.g., "Internal Meeting", "Office Management", "Training", "Research", "HR/Recruiting", "Travel Time", "Holiday", "PTO"). Required for Regular Time entries (when no ticket/task/project is specified).'
        },
        dateWorked: {
          type: 'string',
          description: 'Date worked (YYYY-MM-DD format)'
        },
        startDateTime: {
          type: 'string',
          description: 'Start date/time (ISO format)'
        },
        endDateTime: {
          type: 'string',
          description: 'End date/time (ISO format)'
        },
        hoursWorked: {
          type: 'number',
          description: 'Number of hours worked'
        },
        summaryNotes: {
          type: 'string',
          description: 'Summary notes for the time entry'
        },
        internalNotes: {
          type: 'string',
          description: 'Internal notes for the time entry'
        },
        billingCodeID: {
          type: 'number',
          description: 'Work type / billing code ID. Note: billable status also depends on contract config, so a work type alone does not guarantee the entry is billable.'
        },
        showOnInvoice: {
          type: 'boolean',
          description: 'Whether the entry appears on the customer invoice.'
        }
      },
      required: ['dateWorked', 'hoursWorked', 'summaryNotes']
    }
  },
  {
    name: 'autotask_get_my_day',
    description: 'The acting user\'s working picture for a date (default today): tickets assigned to them, the time they have already logged that day, and their open tasks. Built for a scheduled assistant to see what already exists and backfill only the gaps. Acts as the caller by default (currentUser) — or pass resourceID. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceID: { type: 'number', description: 'Whose day to read. Omit to use the calling user (currentUser).' },
        currentUser: { type: 'boolean', description: 'Read the calling user\'s day (default when resourceID is omitted).' },
        date: { type: 'string', description: 'Day to report (YYYY-MM-DD). Defaults to today (UTC).' }
      },
      required: []
    },
    annotations: { title: 'Get my day', readOnlyHint: true }
  },
  {
    name: 'autotask_log_my_time',
    description: 'Log a time entry as the acting user, idempotently. Before creating, it checks for an existing entry on the same day against the same ticket/task with the same summaryNotes and skips if found — so a scheduled end-of-day backfill (and retries) never double-posts. Acts as the caller by default (currentUser); role auto-fills from the user\'s default. Provide ticketID or taskID (or neither for Regular Time).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'Ticket to log against (omit for a task or Regular Time)' },
        taskID: { type: 'number', description: 'Project task to log against (project time logs against a task)' },
        dateWorked: { type: 'string', description: 'Date worked (YYYY-MM-DD). Defaults to today (UTC).' },
        hoursWorked: { type: 'number', description: 'Hours worked (or provide startDateTime/endDateTime)' },
        startDateTime: { type: 'string', description: 'Start time (ISO 8601); alternative to hoursWorked' },
        endDateTime: { type: 'string', description: 'End time (ISO 8601); alternative to hoursWorked' },
        summaryNotes: { type: 'string', description: 'What was done — also the idempotency signal (same summary on the same day/ticket = duplicate)' },
        resourceID: { type: 'number', description: 'Log as this resource. Omit to log as the calling user (currentUser).' },
        currentUser: { type: 'boolean', description: 'Log as the calling user (default when resourceID is omitted).' },
        roleID: { type: 'number', description: 'Role for the entry. Auto-filled from the user\'s default role when omitted.' },
        billingCodeID: { type: 'number', description: 'Work type / billing code' },
        category: { type: 'string', description: 'Category for Regular Time (no ticket/task), e.g. "Internal Meeting"' }
      },
      required: ['summaryNotes']
    }
  },
  {
    name: 'autotask_get_time_entry',
    description:
      'READ-ONLY. Get a time entry by ID. The record distinguishes actual worked ' +
      'time (hoursWorked) from Autotask billing-rounded time (hoursToBill).',
    annotations: { title: 'Get time entry', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Time entry ID' } },
      required: ['id']
    }
  },
  {
    name: 'autotask_update_time_entry',
    description:
      'Update a time entry (collection PATCH). Only provided fields change. ' +
      'hoursWorked accepts fractional hours (e.g. 0.1 = six minutes).',
    annotations: { title: 'Update time entry', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Time entry ID to update' },
        hoursWorked: { type: 'number', description: 'Actual hours worked (fractional allowed)' },
        startDateTime: { type: 'string', description: 'Start date/time (ISO)' },
        endDateTime: { type: 'string', description: 'End date/time (ISO)' },
        summaryNotes: { type: 'string', description: 'Summary notes' },
        internalNotes: { type: 'string', description: 'Internal notes' },
        billingCodeID: { type: 'number', description: 'Work type / billing code ID' },
        showOnInvoice: { type: 'boolean', description: 'Whether the entry appears on the customer invoice' }
      },
      required: ['id']
    }
  },

  // Project tools
  {
    name: 'autotask_search_projects',
    description: 'Search for projects in Autotask. Returns 25 results per page by default. Use page parameter for more results.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for project name'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        status: {
          type: 'number',
          description: 'Filter by project status'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Filter by project lead resource ID'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_project',
    description: 'Get a single project by ID with its full field set (status, type, lead, department, dates, estimated/actual time, contract, opportunity, UDFs, etc.).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Project ID' } },
      required: ['id']
    },
    annotations: { title: 'Get project', readOnlyHint: true }
  },
  {
    name: 'autotask_get_project_structure',
    description: 'Get the normalized project outline: the project plus its phases nested by parentPhaseID, with tasks bucketed under each phase and any unphased tasks listed separately, plus a summary (phase/task counts, max phase depth, estimated hours). Preserves Autotask-native fields. The prerequisite for reliable project blueprint export and cloning.',
    inputSchema: {
      type: 'object',
      properties: { projectID: { type: 'number', description: 'Project ID' } },
      required: ['projectID']
    },
    annotations: { title: 'Get project structure', readOnlyHint: true }
  },
  {
    name: 'autotask_get_complete_project_context',
    description: 'Assemble the complete read-only context for a project in one call (the Project Builder input): the project, its nested phase/task hierarchy, the task dependency graph, the labor rollup, project notes and attachments, the owning company, and commercial linkage (contract + milestones, opportunity). Best-effort — a section that fails to load is recorded under `errors` instead of failing the whole call. Configuration items are opt-in (can be large per company); set includeCommercial:false to skip contract/opportunity fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'number', description: 'Project ID' },
        includeConfigurationItems: { type: 'boolean', description: 'Also fetch the company\'s configuration items (can be large; default false)' },
        includeCommercial: { type: 'boolean', description: 'Fetch contract/milestones/opportunity linkage (default true)' }
      },
      required: ['projectID']
    },
    annotations: { title: 'Get complete project context', readOnlyHint: true }
  },
  {
    name: 'autotask_get_project_labor_summary',
    description: 'Project labor summary: estimated vs actual and billable hours, variance, first/last worked dates, and a per-phase rollup. Aggregated through the task hierarchy (project tasks → task time entries) because project-scoped time queries are unreliable.',
    inputSchema: {
      type: 'object',
      properties: { projectID: { type: 'number', description: 'Project ID' } },
      required: ['projectID']
    },
    annotations: { title: 'Project labor summary', readOnlyHint: true }
  },
  {
    name: 'autotask_export_project_blueprint',
    description: 'Export a project as a reusable, tenant-agnostic blueprint: the phase/task hierarchy with titles, estimated hours, and task type, WITHOUT tenant-specific ids, resource assignments, or absolute dates. Use an existing project (e.g. a standard low-voltage or onboarding project) as a starting template for a new one.',
    inputSchema: {
      type: 'object',
      properties: { projectID: { type: 'number', description: 'Source project ID to export' } },
      required: ['projectID']
    },
    annotations: { title: 'Export project blueprint', readOnlyHint: true }
  },
  {
    name: 'autotask_calculate_project_schedule',
    description: 'Deterministically schedule a project build plan (no Autotask writes, no AI, no reference-project inference). Each task\'s duration = ceil(estimatedHours ÷ (crewSize × hoursPerDay)) working days; tasks are laid out in dependency order across a configurable working week (weekends/holidays skipped); target completion is the latest task finish. Returns per-task start/end dates, the project start → target completion span, the driving (critical) path, and milestone dates. Same inputs always yield the same schedule. The `plan` uses client-side string refs (not Autotask ids) so it can be scheduled before anything exists in the tenant.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Normalized project build plan.',
          properties: {
            name: { type: 'string', description: 'Project name' },
            archetype: { type: 'string', description: 'Optional GDS archetype classification' },
            phases: {
              type: 'array',
              description: 'Phases (optional). Each: { ref, title, parentRef? } — ref is a unique client-side id; parentRef nests a sub-phase.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  parentRef: { type: 'string' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title']
              }
            },
            tasks: {
              type: 'array',
              description: 'Tasks. Each: { ref, title, estimatedHours, phaseRef?, crewSize?, predecessors?, lagDays?, milestone? }. predecessors are task refs that must finish first; set milestone:true for a zero-duration date marker.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  estimatedHours: { type: 'number' },
                  phaseRef: { type: 'string' },
                  crewSize: { type: 'number', description: 'Parallel resources on this task (overrides defaultCrewSize)' },
                  predecessors: { type: 'array', items: { type: 'string' }, description: 'Refs of tasks that must finish before this one starts' },
                  lagDays: { type: 'number', description: 'Working-day gap after predecessors finish' },
                  taskType: { type: 'number' },
                  milestone: { type: 'boolean' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title', 'estimatedHours']
              }
            }
          },
          required: ['name', 'tasks']
        },
        startDate: { type: 'string', description: 'Earliest project start, ISO date (YYYY-MM-DD). Rolled forward to the next working day if needed.' },
        hoursPerDay: { type: 'number', description: 'Productive hours per working day (default 8)', default: 8 },
        defaultCrewSize: { type: 'number', description: 'Parallel resources per task when a task does not set its own crewSize (default 1)', default: 1 },
        workweek: { type: 'array', items: { type: 'number' }, description: 'Working weekdays as ISO numbers (Mon=1 … Sun=7). Default [1,2,3,4,5] (Mon–Fri).' },
        holidays: { type: 'array', items: { type: 'string' }, description: 'Non-working dates (holidays), ISO YYYY-MM-DD.' },
        targetCompletionDate: { type: 'string', description: 'Optional deadline (ISO date). A target completion beyond it produces a warning.' }
      },
      required: ['plan', 'startDate']
    },
    annotations: { title: 'Calculate project schedule', readOnlyHint: true }
  },
  {
    name: 'autotask_extract_project_scope',
    description: "Front of the SOW-to-project pipeline (#46 §8): deterministically parse a Statement of Work into a normalized, reviewable scope envelope — NO Autotask writes, NO AI, and it NEVER infers scope from a reference project (only from what you give it). Section-parses `sowText` into the canonical buckets — included / excluded / byOthers / assumptions / allowances / customerProvided / vendorProvided / dependencies / milestones — using heading detection (markdown headings, 'X:' labels, or known section names like 'Out of Scope', 'By Others', 'Assumptions'). Extracts BOM-style quantities from in-scope lines ('(12) drops', '12x cameras', '48 jacks') into a structured quantities list (feeds §9 BOM → calculated hours). Merges a caller-supplied partial `scope` (e.g. from an LLM) with the parsed text. Anything it can't classify goes to `unclassified` (never dropped), plus data-quality `warnings`. The output scope is the reviewable artifact to approve before generate_project_labor_plan / calculate_project_schedule / build_project_from_plan.",
    inputSchema: {
      type: 'object',
      properties: {
        sowText: { type: 'string', description: 'Raw SOW text to section-parse (headings + bullet lines). Optional if `scope` is supplied.' },
        scope: {
          type: 'object',
          description: 'A partial scope to merge with the parsed text (e.g. pre-structured by an LLM caller). Same shape as the output; string[] buckets + milestones[] + quantities[].',
          properties: {
            included: { type: 'array', items: { type: 'string' } },
            excluded: { type: 'array', items: { type: 'string' } },
            byOthers: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            allowances: { type: 'array', items: { type: 'string' } },
            customerProvided: { type: 'array', items: { type: 'string' } },
            vendorProvided: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } },
            milestones: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, date: { type: 'string' } }, required: ['text'] } },
            quantities: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' }, source: { type: 'string' } }, required: ['item', 'quantity'] } }
          }
        },
        source: { type: 'string', description: 'Provenance label recorded on the scope (e.g. SOW/quote id or filename)' },
        quantityBuckets: { type: 'array', items: { type: 'string', enum: ['included', 'excluded', 'byOthers', 'assumptions', 'allowances', 'customerProvided', 'vendorProvided', 'dependencies'] }, description: 'Which buckets to scan for quantities (default ["included"])' }
      },
      required: []
    },
    annotations: { title: 'Extract project scope from SOW', readOnlyHint: true }
  },
  {
    name: 'autotask_classify_project',
    description: "Project classification (#46 §7): deterministically map a project/scope to an archetype (e.g. construction/low-voltage, tech deployment, recurring consulting, compliance program, operational onboarding) so the pipeline can pick the right blueprint/defaults. No Autotask writes, no AI — it keyword-scores the supplied text + scope against a CALLER-PROVIDED archetype set (archetypes are tenant-specific, so you define them: name + keywords, optional per-hit weight), ranks them, and returns the top match with a confidence (none/low/medium/high), the full ranked scores, the matched keywords, and a plain rationale (explainable, not a black box). Below the minimum score it stays the default (e.g. 'Unclassified') and says why. Feed it the name/description as `text` and/or the `scope` from autotask_extract_project_scope.",
    inputSchema: {
      type: 'object',
      properties: {
        archetypes: {
          type: 'array',
          description: 'Caller-defined archetypes to classify against. Each: { name, keywords[], weight? }.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              keywords: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive substrings that signal this archetype' },
              weight: { type: 'number', description: 'Per-keyword-hit weight (default 1)', exclusiveMinimum: 0 }
            },
            required: ['name', 'keywords']
          }
        },
        text: { type: 'string', description: 'Project name/description or any free text to classify' },
        scope: {
          type: 'object',
          description: 'Scope to mine for signals (from autotask_extract_project_scope): included[], assumptions[], quantities[{item}].',
          properties: {
            included: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            quantities: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } }
          }
        },
        minScore: { type: 'number', description: 'Minimum top score to accept a classification (default 1)', minimum: 0 },
        defaultArchetype: { type: 'string', description: 'Name used when nothing reaches minScore (default "Unclassified")' }
      },
      required: ['archetypes']
    },
    annotations: { title: 'Classify project archetype', readOnlyHint: true }
  },
  {
    name: 'autotask_calculate_bom_labor',
    description: "BOM → calculated labor (#46 §9): deterministically turn BOM/scope quantities into CALCULATED labor hours using a caller-provided rate catalog, and normalize the quantities into repeated tasks. No Autotask writes, no AI. Feed it the `quantities` from autotask_extract_project_scope (or supply items directly) plus `rates` (minutes/hours per unit per item type — tenant-specific, so you provide them). For each item it finds the first matching rate (case-insensitive keyword), computes hours = quantity × per-unit × laborMultiplier, and groups into `calculatedHoursByPhase` (ready to pass straight to autotask_generate_project_labor_plan as the CALCULATED view) plus a `tasks` list (title/estimatedHours/phaseRef/quantity) for the build plan. Items matching no rate are flagged in `unmatched` (never guessed) unless you set a defaultHoursPerUnit. This is the bottom-up number that §10 compares against QUOTED and PLANNED — it never overwrites quoted labor.",
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'BOM/scope quantities. Each: { item, quantity, unit? }. Use the quantities[] from autotask_extract_project_scope.',
          items: { type: 'object', properties: { item: { type: 'string' }, quantity: { type: 'number' }, unit: { type: 'string' } }, required: ['item', 'quantity'] }
        },
        rates: {
          type: 'array',
          description: 'Labor rate catalog (tenant-specific — you provide it). First matching rate wins. Each: { match | matchAny[], minutesPerUnit | hoursPerUnit, laborMultiplier?, phaseRef?, taskTitle? }.',
          items: {
            type: 'object',
            properties: {
              match: { type: 'string', description: 'Case-insensitive substring matched against the item name' },
              matchAny: { type: 'array', items: { type: 'string' }, description: 'Any of these substrings matches' },
              minutesPerUnit: { type: 'number', description: 'Labor minutes per unit (or use hoursPerUnit)' },
              hoursPerUnit: { type: 'number', description: 'Labor hours per unit' },
              laborMultiplier: { type: 'number', description: 'Multiplies computed hours (e.g. 2 terminations per drop)', exclusiveMinimum: 0 },
              phaseRef: { type: 'string', description: 'Phase this item’s hours roll into (matches your plan phase refs)' },
              taskTitle: { type: 'string', description: 'Task title for the generated repeated task (default: the item name)' }
            }
          }
        },
        defaultHoursPerUnit: { type: 'number', description: 'Fallback hours/unit for items no rate matches (default: none → flagged as unmatched)', minimum: 0 },
        defaultPhaseRef: { type: 'string', description: 'Phase for matched rates that specify none (default "unphased")' }
      },
      required: ['items', 'rates']
    },
    annotations: { title: 'Calculate labor from BOM', readOnlyHint: true }
  },
  {
    name: 'autotask_generate_project_labor_plan',
    description: "Deterministic labor plan for a project build plan (no Autotask writes, no AI). Compares three views of labor per phase — PLANNED (sum of the plan's task estimatedHours), QUOTED (what was sold, from the SOW/quote — you supply it), and CALCULATED (derived from BOM/scope quantities — you supply it) — and flags phases whose planned hours differ from quoted/calculated by more than the variance threshold (default 15%). Never overwrites quoted labor; it only reports variance for review (flags like over_quoted / under_quoted). Returns per-phase and total hours + deltas. Feed the same `plan` as autotask_calculate_project_schedule.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Normalized project build plan (same shape as autotask_calculate_project_schedule): { name, phases:[{ref,title,parentRef?}], tasks:[{ref,title,estimatedHours,phaseRef?,...}] }.',
          properties: {
            name: { type: 'string' },
            phases: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, parentRef: { type: 'string' } }, required: ['ref', 'title'] } },
            tasks: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, estimatedHours: { type: 'number' }, phaseRef: { type: 'string' } }, required: ['ref', 'title', 'estimatedHours'] } }
          },
          required: ['name', 'tasks']
        },
        quotedHoursByPhase: { type: 'object', description: 'Quoted labor hours keyed by phase ref, e.g. {"p1": 40, "p2": 16}', additionalProperties: { type: 'number' } },
        calculatedHoursByPhase: { type: 'object', description: 'Labor hours calculated from BOM/scope quantities, keyed by phase ref', additionalProperties: { type: 'number' } },
        quotedHoursTotal: { type: 'number', description: 'Total quoted hours when a per-phase breakdown is not available' },
        calculatedHoursTotal: { type: 'number', description: 'Total calculated hours when a per-phase breakdown is not available' },
        varianceThresholdPct: { type: 'number', description: 'Fractional variance that counts as material (default 0.15 = 15%)', minimum: 0 }
      },
      required: ['plan']
    },
    annotations: { title: 'Generate project labor plan', readOnlyHint: true }
  },
  {
    name: 'autotask_build_project_from_plan',
    description: "Build engine: realize a validated project build plan as a real Autotask project — project → phases (parent-first) → tasks → task dependencies. SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written and the tool returns the planned mutation counts for review. Idempotent + resumable: it tags the project with a build key and, on a re-run (same buildKey, or same company+name), reuses the existing project and creates only the phases/tasks/dependencies still missing (matched by title), so a retry after a partial failure never duplicates. Returns the shared write-plan envelope (status: dry_run | built | built_with_errors | validation_failed) with the Autotask projectId, a per-ref → id map, and a created/reused summary. Produce the plan with the SOW→project pipeline (or autotask_calculate_project_schedule for dates); this tool only builds an approved plan.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Normalized project build plan (same shape as autotask_calculate_project_schedule). Tasks/phases use client-side string refs; the engine maps them to Autotask ids.',
          properties: {
            name: { type: 'string', description: 'Project name (also the idempotency name)' },
            archetype: { type: 'string', description: 'Optional GDS archetype classification' },
            source: { type: 'string', description: 'Optional provenance (SOW/quote id) — recorded in the project description, not built' },
            phases: {
              type: 'array',
              description: 'Phases (optional). Each: { ref, title, parentRef?, description? } — ref is a unique client-side id; parentRef nests a sub-phase.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  parentRef: { type: 'string' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title']
              }
            },
            tasks: {
              type: 'array',
              description: 'Tasks. Each: { ref, title, estimatedHours, phaseRef?, predecessors?, lagDays?, taskType?, description? }. predecessors are task refs that must finish first.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  estimatedHours: { type: 'number' },
                  phaseRef: { type: 'string' },
                  predecessors: { type: 'array', items: { type: 'string' }, description: 'Refs of tasks that must finish before this one starts' },
                  lagDays: { type: 'number' },
                  taskType: { type: 'number' },
                  description: { type: 'string' }
                },
                required: ['ref', 'title', 'estimatedHours']
              }
            }
          },
          required: ['name', 'tasks']
        },
        companyID: { type: 'number', description: 'Company the project belongs to' },
        buildKey: { type: 'string', description: 'Stable idempotency key for this build (default: "<companyID>:<plan.name>"). Re-running with the same key resumes instead of duplicating.' },
        projectDefaults: {
          type: 'object',
          description: 'Autotask project fields applied on create (e.g. status, projectType, startDate, endDate, projectLeadResourceID, department). projectType is required by Autotask to create a project.',
          properties: {
            status: { type: 'number', description: 'Project status (e.g. 1=New, 2=In Progress)' },
            projectType: { type: 'number', description: 'Project type (2=Proposal, 3=Template, 4=Internal, 5=Client, 8=Baseline)' },
            startDate: { type: 'string', description: 'Project start date (YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'Project end date (YYYY-MM-DD)' },
            projectLeadResourceID: { type: 'number', description: 'Project manager resource ID' },
            department: { type: 'number', description: 'Department id' }
          }
        },
        dryRun: { type: 'boolean', description: 'When true (DEFAULT), validate and return the plan without writing. Pass false to actually build.', default: true }
      },
      required: ['plan', 'companyID']
    },
    annotations: { title: 'Build project from plan' }
  },
  {
    name: 'autotask_extend_project',
    description: "Project extension (#46 §2.4): add phases / tasks / dependencies to an EXISTING project by id — a change order, an added phase, a recurring month, a new site, or extra tasks. SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written and it returns what WOULD be added (the phases/tasks not already present by title). IDEMPOTENT MERGE: phases and tasks already in the project (matched by title) are reused, never duplicated, so re-running is safe and resumable. Same normalized plan shape and build engine as autotask_build_project_from_plan, but targets a known projectID instead of creating/finding a project. Returns the shared write-plan envelope (status: dry_run | validation_failed | extended | extended_with_errors) with a created/reused summary. Produce the `plan` with the SOW→project pipeline (extract_project_scope → calculate_bom_labor → calculate_project_schedule).",
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'number', description: 'The existing Autotask project to extend' },
        plan: {
          type: 'object',
          description: 'Normalized build plan fragment to merge in (same shape as autotask_build_project_from_plan): { name, phases:[{ref,title,parentRef?,description?}], tasks:[{ref,title,estimatedHours,phaseRef?,predecessors?,lagDays?,taskType?,description?}] }. Only phases/tasks not already present (by title) are created.',
          properties: {
            name: { type: 'string', description: 'Label for the plan fragment (not used to find the project — projectID is authoritative)' },
            phases: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, parentRef: { type: 'string' }, description: { type: 'string' } }, required: ['ref', 'title'] } },
            tasks: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, title: { type: 'string' }, estimatedHours: { type: 'number' }, phaseRef: { type: 'string' }, predecessors: { type: 'array', items: { type: 'string' } }, lagDays: { type: 'number' }, taskType: { type: 'number' }, description: { type: 'string' } }, required: ['ref', 'title'] } }
          },
          required: ['name', 'tasks']
        },
        dryRun: { type: 'boolean', description: 'Default true — plan only, no writes. Pass false to apply.' }
      },
      required: ['projectID', 'plan']
    },
    annotations: { title: 'Extend an existing project' }
  },
  {
    name: 'autotask_create_project',
    description: 'Create a new project in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Company ID for the project'
        },
        projectName: {
          type: 'string',
          description: 'Project name'
        },
        description: {
          type: 'string',
          description: 'Project description'
        },
        status: {
          type: 'number',
          description: 'Project status (1=New, 2=In Progress, 5=Complete)'
        },
        startDate: {
          type: 'string',
          description: 'Project start date (YYYY-MM-DD)'
        },
        endDate: {
          type: 'string',
          description: 'Project end date (YYYY-MM-DD)'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Project manager resource ID'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours for the project'
        },
        projectType: {
          type: 'number',
          description: 'Project type (2=Proposal, 3=Template, 4=Internal, 5=Client, 8=Baseline). Required.'
        }
      },
      required: ['companyID', 'projectName', 'status', 'projectType']
    }
  },
  {
    name: 'autotask_link_project_commercial',
    description: 'Link a project to its commercial records — contract and/or opportunity. Validates that each reference belongs to the SAME company as the project (Autotask will otherwise let a project bill against a contract owned by a different company) and that the contract is active and not expired, then writes and reads the link back to confirm it took. Returns the safe-orchestration envelope: status is validation_failed | duplicate | dry_run | linked; anything other than "linked" means nothing was written. Set dryRun:true to validate and see the planned change without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'The project to link'
        },
        contractID: {
          type: 'number',
          description: 'Contract the project bills against. Must belong to the same company as the project, be active, and not be expired.'
        },
        opportunityID: {
          type: 'number',
          description: 'Opportunity the project was won from. Must belong to the same company as the project.'
        },
        dryRun: {
          type: 'boolean',
          description: 'Validate and return the planned change without writing (default false)'
        }
      },
      required: ['projectID']
    }
  },
  {
    name: 'autotask_update_project',
    description: 'Update an existing project in Autotask. Only the fields you provide will be updated. Common use case: set status=5 to mark a project Complete.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The ID of the project to update'
        },
        projectName: {
          type: 'string',
          description: 'Project name'
        },
        description: {
          type: 'string',
          description: 'Project description'
        },
        status: {
          type: 'number',
          description: 'Project status (1=New, 2=In Progress, 5=Complete). Set to 5 to mark the project complete.'
        },
        department: {
          type: 'number',
          description: 'Department picklist ID owning the project. (The Projects field is "department"; "departmentID" is accepted as a legacy alias.)'
        },
        departmentID: {
          type: 'number',
          description: 'Legacy alias for "department". Prefer "department".'
        },
        contractID: {
          type: 'number',
          description: 'Contract this project bills against. Must belong to the same company as the project. Prefer autotask_link_project_commercial, which validates ownership and reads the link back.'
        },
        opportunityID: {
          type: 'number',
          description: 'Opportunity this project was won from. Must belong to the same company as the project. Prefer autotask_link_project_commercial, which validates ownership and reads the link back.'
        },
        statusDetail: {
          type: 'string',
          description: 'Free-text status detail shown alongside the status picklist'
        },
        purchaseOrderNumber: {
          type: 'string',
          description: 'Customer purchase order number for this project'
        },
        assignedResourceID: {
          type: 'number',
          description: 'IGNORED — not a Projects field in Autotask (it belongs to Tasks). Accepted for backward compatibility but never sent. Use projectLeadResourceID.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'IGNORED — not a Projects field in Autotask (it belongs to Tasks). Accepted for backward compatibility but never sent.'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Project lead resource ID'
        },
        startDateTime: {
          type: 'string',
          description: 'Project start date/time (ISO 8601)'
        },
        endDateTime: {
          type: 'string',
          description: 'Project end date/time (ISO 8601)'
        },
        estimatedTime: {
          type: 'number',
          description: 'IGNORED — read-only on Projects in Autotask (it is rolled up from tasks). Accepted for backward compatibility but never sent.'
        },
        userDefinedFields: {
          type: 'array',
          description: 'User-defined field values to set on the project (Autotask REST-native shape)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'UDF name' },
              value: { type: 'string', description: 'UDF value' }
            },
            required: ['name', 'value']
          }
        }
      },
      required: ['projectId']
    }
  },

  // Resource tools
  {
    name: 'autotask_search_resources',
    description: 'Search for resources (users) in Autotask. Returns 25 results per page by default. Use page parameter for more results.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for resource name or email'
        },
        isActive: {
          type: 'boolean',
          
        },
        resourceType: {
          type: 'number',
          description: 'Filter by resource type (1=Employee, 2=Contractor, 3=Temporary)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_search_roles',
    description: 'Search Autotask Roles (the roles used for ticket assignment and time entries). Returns id, name, hourlyRate, roleType, isActive. Use to discover a roleID for assignedResourceRoleID or a time-entry roleID.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: { type: 'string', description: 'Match against the role name (e.g. "Technician", "Engineer")' },
        isActive: { type: 'boolean', description: 'Filter by active state' },
        pageSize: { type: 'number', description: 'Max rows (default 100, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search roles', readOnlyHint: true }
  },
  {
    name: 'autotask_get_resource_roles',
    description: 'List the roles a resource (user) may act in (from ResourceRoles), enriched with each role name and flagging the resource\'s default service-desk role. Use to pick a valid roleID when assigning that user or logging their time.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceID: { type: 'number', description: 'The resource (user) whose roles to list' }
      },
      required: ['resourceID']
    },
    annotations: { title: 'Get resource roles', readOnlyHint: true }
  },

  // Ticket Notes tools
  {
    name: 'autotask_get_ticket_note',
    description: 'Get a specific ticket note by ticket ID and note ID',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID'
        },
        noteId: {
          type: 'number',
          description: 'The note ID to retrieve'
        }
      },
      required: ['ticketId', 'noteId']
    }
  },
  {
    name: 'autotask_search_ticket_notes',
    description: 'Search for notes on a specific ticket. Iterating across many tickets trips Autotask\'s per-integration API threshold — scope the parent list first.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to search notes for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_note',
    description: 'Create a new note for a ticket',
    _meta: TICKET_CARD_META,
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to add the note to'
        },
        title: {
          type: 'string',
          description: 'Note title'
        },
        description: {
          type: 'string',
          description: 'Note content'
        },
        noteType: {
          type: 'number',
          description: 'Note type picklist ID. Tenant-specific — call autotask_get_field_info with entityType "TicketNotes" and fieldName "noteType" to discover the exact label-to-ID mapping before calling this tool. Do not assume values from other Autotask instances apply here.'
        },
        publish: {
          type: 'number',
          description: 'Publish/visibility picklist ID. Tenant-specific and security-sensitive (controls whether the note is visible to clients). Call autotask_get_field_info with entityType "TicketNotes" and fieldName "publish" to discover the exact label-to-ID mapping before calling this tool. Never guess — the wrong value can expose internal notes to clients.'
        }
      },
      required: ['ticketId', 'description', 'noteType', 'publish']
    }
  },

  // Ticket Checklist Items tools (sub-resource of Tickets)
  {
    name: 'autotask_search_ticket_checklist_items',
    description: 'List all checklist items on a ticket, including their completion status. Checklist items are a sub-resource of a ticket and cannot be queried without a ticket ID.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID whose checklist items should be listed'
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_checklist_item',
    description: 'Add a new checklist item to a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to add the checklist item to'
        },
        itemName: {
          type: 'string',
          description: 'The checklist item text'
        },
        position: {
          type: 'number',
          description: 'Optional ordering position for the item'
        },
        isCompleted: {
          type: 'boolean',
          description: 'Whether the item starts in the completed state (default: false)'
        }
      },
      required: ['ticketId', 'itemName']
    }
  },
  {
    name: 'autotask_update_ticket_checklist_item',
    description: 'Update a checklist item on a ticket — edit text, mark complete/incomplete, or change position.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The parent ticket ID'
        },
        itemId: {
          type: 'number',
          description: 'The checklist item ID to update'
        },
        itemName: {
          type: 'string',
          description: 'New text for the checklist item'
        },
        isCompleted: {
          type: 'boolean',
          description: 'Mark the item complete (true) or incomplete (false)'
        },
        position: {
          type: 'number',
          description: 'New ordering position for the item'
        }
      },
      required: ['ticketId', 'itemId']
    }
  },
  {
    name: 'autotask_delete_ticket_checklist_item',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a checklist item ' +
      'from a ticket. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete ticket checklist item (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The parent ticket ID'
        },
        itemId: {
          type: 'number',
          description: 'The checklist item ID to delete'
        }
      },
      required: ['ticketId', 'itemId']
    }
  },
  {
    name: 'autotask_search_checklist_libraries',
    description: 'Search reusable checklist libraries (standardized work-instruction checklists). Filter by isActive, entityType (which entity the library targets), or name searchTerm. Use to pick the right library (e.g. "Managed Network - Firmware Maintenance") before applying it to a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: { type: 'string', description: 'Match against the library name' },
        isActive: { type: 'boolean', description: 'Filter by active state' },
        entityType: { type: 'number', description: 'Filter by target entity type (picklist; libraries are scoped to an entity such as tickets)' },
        pageSize: { type: 'number', description: 'Max rows to return (default 100, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search checklist libraries', readOnlyHint: true }
  },
  {
    name: 'autotask_get_checklist_library',
    description: 'Get a checklist library by id, including its ordered items (from ChecklistLibraryChecklistItems: itemName, isImportant, position, knowledgebaseArticleID). Preview what applying it to a ticket will add.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'ChecklistLibrary id' } },
      required: ['id']
    },
    annotations: { title: 'Get checklist library', readOnlyHint: true }
  },
  {
    name: 'autotask_apply_checklist_library_to_ticket',
    description: 'Apply a checklist library to a ticket — expands the library\'s items into checklist items on the ticket (itemName / isImportant / position / knowledgebaseArticleID carried over). Autotask has no native apply endpoint, so this creates one TicketChecklistItem per library item. Each item is created independently; failures are reported per-item without aborting the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'number', description: 'The ticket to add the checklist items to' },
        checklistLibraryID: { type: 'number', description: 'The checklist library to apply' }
      },
      required: ['ticketID', 'checklistLibraryID']
    }
  },

  // Project Notes tools
  {
    name: 'autotask_get_project_note',
    description: 'Get a specific project note by project ID and note ID',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The project ID'
        },
        noteId: {
          type: 'number',
          description: 'The note ID to retrieve'
        }
      },
      required: ['projectId', 'noteId']
    }
  },
  {
    name: 'autotask_search_project_notes',
    description: 'Search for notes on a specific project. Fan-out across many projects trips Autotask\'s API threshold (see issue #69) — scope the parent list (status, company, date range) first.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The project ID to search notes for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'autotask_create_project_note',
    description: 'Create a new note for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The project ID to add the note to'
        },
        title: {
          type: 'string',
          description: 'Note title'
        },
        description: {
          type: 'string',
          description: 'Note content'
        },
        noteType: {
          type: 'number',
          description: 'Note type (1=General, 2=Appointment, 3=Task, 4=Ticket, 5=Project, 6=Opportunity)'
        },
        publish: {
          type: 'number',
          description: 'Publish visibility (1=All Autotask Users, 2=Internal Project Team, 3=Project Team). Defaults to 1.'
        },
        isAnnouncement: {
          type: 'boolean',
          description: 'Whether this note is an announcement. Defaults to false.'
        }
      },
      required: ['projectId', 'description']
    }
  },
  {
    name: 'autotask_get_task_note',
    description: 'Get a specific project-task note by task ID and note ID.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID' },
        noteId: { type: 'number', description: 'The note ID' }
      },
      required: ['taskId', 'noteId']
    },
    annotations: { title: 'Get task note', readOnlyHint: true }
  },
  {
    name: 'autotask_search_task_notes',
    description: 'List the notes on a project task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID' },
        pageSize: { type: 'number', description: 'Number of results (default 25)', minimum: 1, maximum: 100 }
      },
      required: ['taskId']
    },
    annotations: { title: 'Search task notes', readOnlyHint: true }
  },
  {
    name: 'autotask_create_task_note',
    description: 'Create a note on a project task. Resolve noteType/publish values from tenant metadata (autotask_get_field_info(TaskNotes)) rather than assuming constants.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID to add the note to' },
        title: { type: 'string', description: 'Note title' },
        description: { type: 'string', description: 'Note content' },
        noteType: { type: 'number', description: 'Note type id (resolve via metadata)' },
        publish: { type: 'number', description: 'Publish/visibility id (resolve via metadata)' }
      },
      required: ['taskId', 'description']
    }
  },
  {
    name: 'autotask_search_project_attachments',
    description: 'List attachment metadata on a project (name, type, size, attach date). Read-only; binary upload/download is a separate capability.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'The project ID' },
        pageSize: { type: 'number', description: 'Number of results (default 25)', minimum: 1, maximum: 100 }
      },
      required: ['projectId']
    },
    annotations: { title: 'List project attachments', readOnlyHint: true }
  },
  {
    name: 'autotask_search_task_attachments',
    description: 'List attachment metadata on a project task. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID' },
        pageSize: { type: 'number', description: 'Number of results (default 25)', minimum: 1, maximum: 100 }
      },
      required: ['taskId']
    },
    annotations: { title: 'List task attachments', readOnlyHint: true }
  },
  {
    name: 'autotask_get_project_attachment',
    description: 'Get a project attachment. With includeData=false (default) returns metadata only — fast, suitable for browsing. With includeData=true returns the base64 binary content via the top-level /ProjectAttachments/{id} endpoint (the child endpoint never populates data). The attachment is verified to belong to the given projectId. Oversized binaries are stripped with a dataOmittedReason field (base64 can exceed the MCP client tool-result limit of ~1 MB).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'The project ID the attachment belongs to' },
        attachmentId: { type: 'number', description: 'The attachment ID to retrieve' },
        includeData: { type: 'boolean', description: 'Set true to fetch the base64-encoded file bytes. Default false returns metadata only.', default: false },
        maxInlineBase64Bytes: { type: 'number', description: 'Cap on base64 string length before data is stripped (default 750_000, ~560 KB raw). Only relevant when includeData=true. Raise carefully — your MCP client may reject oversized tool results.', minimum: 1024 }
      },
      required: ['projectId', 'attachmentId']
    },
    annotations: { title: 'Get project attachment', readOnlyHint: true }
  },
  {
    name: 'autotask_create_project_attachment',
    description: 'Upload a file attachment to an existing project. The file content must be passed as a base64-encoded string in the `data` field (MCP is JSON-RPC, so binary bytes must be base64-encoded). Autotask enforces a 3 MB hard limit; this tool validates the decoded size before calling the API. Example: { projectId: 152, title: "SOW.pdf", data: "JVBERi0xLjc..." }',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'The project ID to attach the file to' },
        title: { type: 'string', description: 'Display title for the attachment (typically the filename, e.g. "SOW.pdf")' },
        data: { type: 'string', description: 'Base64-encoded file content. Maximum decoded size: 3 MB.' },
        fullPath: { type: 'string', description: 'Original filename including any path. Defaults to `title` if not provided.' },
        contentType: { type: 'string', description: 'MIME type of the file (e.g. "application/pdf", "image/png"). Optional.' },
        publish: { type: 'number', description: 'Visibility: 1 = All Autotask Users (default), 2 = Internal Users Only', default: 1 }
      },
      required: ['projectId', 'title', 'data']
    }
  },
  {
    name: 'autotask_get_task_attachment',
    description: 'Get a project-task attachment. With includeData=false (default) returns metadata only. With includeData=true returns the base64 binary content via the top-level /TaskAttachments/{id} endpoint (the child endpoint never populates data). The attachment is verified to belong to the given taskId. Oversized binaries are stripped with a dataOmittedReason field.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID the attachment belongs to' },
        attachmentId: { type: 'number', description: 'The attachment ID to retrieve' },
        includeData: { type: 'boolean', description: 'Set true to fetch the base64-encoded file bytes. Default false returns metadata only.', default: false },
        maxInlineBase64Bytes: { type: 'number', description: 'Cap on base64 string length before data is stripped (default 750_000, ~560 KB raw). Only relevant when includeData=true. Raise carefully — your MCP client may reject oversized tool results.', minimum: 1024 }
      },
      required: ['taskId', 'attachmentId']
    },
    annotations: { title: 'Get task attachment', readOnlyHint: true }
  },
  {
    name: 'autotask_create_task_attachment',
    description: 'Upload a file attachment to an existing project task. The file content must be passed as a base64-encoded string in the `data` field. Autotask enforces a 3 MB hard limit; this tool validates the decoded size before calling the API. Example: { taskId: 45678, title: "as-built.pdf", data: "JVBERi0xLjc..." }',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task ID to attach the file to' },
        title: { type: 'string', description: 'Display title for the attachment (typically the filename, e.g. "as-built.pdf")' },
        data: { type: 'string', description: 'Base64-encoded file content. Maximum decoded size: 3 MB.' },
        fullPath: { type: 'string', description: 'Original filename including any path. Defaults to `title` if not provided.' },
        contentType: { type: 'string', description: 'MIME type of the file (e.g. "application/pdf", "image/png"). Optional.' },
        publish: { type: 'number', description: 'Visibility: 1 = All Autotask Users (default), 2 = Internal Users Only', default: 1 }
      },
      required: ['taskId', 'title', 'data']
    }
  },

  // Company Notes tools
  {
    name: 'autotask_get_company_note',
    description: 'Get a specific company note by company ID and note ID',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID'
        },
        noteId: {
          type: 'number',
          description: 'The note ID to retrieve'
        }
      },
      required: ['companyId', 'noteId']
    }
  },
  {
    name: 'autotask_search_company_notes',
    description: 'Search for notes on a specific company. Iterating across many companies trips Autotask\'s API threshold — scope the parent list first.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID to search notes for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['companyId']
    }
  },
  {
    name: 'autotask_create_company_note',
    description: 'Create a new note for a company',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The company ID to add the note to'
        },
        title: {
          type: 'string',
          description: 'Note title'
        },
        description: {
          type: 'string',
          description: 'Note content'
        },
        actionType: {
          type: 'number',
          description: 'Action type for the note'
        }
      },
      required: ['companyId', 'description']
    }
  },

  // Ticket Attachments tools
  {
    name: 'autotask_get_ticket_attachment',
    description: 'Get a ticket attachment. With includeData=false (default) returns metadata only — fast, suitable for browsing. With includeData=true returns the base64 binary content via the top-level /TicketAttachments/{id} endpoint (the child endpoint never populates data). The attachment is verified to belong to the given ticketId. Oversized binaries are stripped from the response with a dataOmittedReason field — Autotask attachments can be up to 3 MB, which is ~4 MB as base64 and may exceed the MCP client tool-result limit (~1 MB).',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID the attachment belongs to'
        },
        attachmentId: {
          type: 'number',
          description: 'The attachment ID to retrieve'
        },
        includeData: {
          type: 'boolean',
          description: 'Set true to fetch the base64-encoded file bytes. Default false returns metadata only.',
          default: false
        },
        maxInlineBase64Bytes: {
          type: 'number',
          description: 'Cap on base64 string length before data is stripped (default 750_000, ~560 KB raw). Only relevant when includeData=true. Raise carefully — your MCP client may reject oversized tool results.',
          minimum: 1024
        }
      },
      required: ['ticketId', 'attachmentId']
    }
  },
  {
    name: 'autotask_search_ticket_attachments',
    description: 'Search for attachments on a specific ticket. Each parent triggers a separate query — scope the parent ticket list before iterating.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to search attachments for'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 50)',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_attachment',
    description:
      'Upload a file attachment to an existing ticket. The file content must be passed as a base64-encoded string in the `data` field (MCP is JSON-RPC, so binary bytes must be base64-encoded). Autotask enforces a 3 MB hard limit on ticket attachments; this tool validates the decoded size before calling the API and returns a clear error if the limit is exceeded. Example: { ticketId: 12345, title: "screenshot.png", data: "iVBORw0KGgoAAAANSUhEUgAA..." }',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The ticket ID to attach the file to'
        },
        title: {
          type: 'string',
          description: 'Display title for the attachment (typically the filename, e.g. "screenshot.png")'
        },
        data: {
          type: 'string',
          description:
            'Base64-encoded file content. Maximum decoded size: 3 MB (Autotask ticket attachment limit). Example: read a file and pass its base64 representation here.'
        },
        fullPath: {
          type: 'string',
          description: 'Original filename including any path. Defaults to `title` if not provided.'
        },
        contentType: {
          type: 'string',
          description: 'MIME type of the file (e.g. "image/png", "application/pdf"). Optional.'
        },
        publish: {
          type: 'number',
          description: 'Visibility: 1 = All Autotask Users (default), 2 = Internal Users Only',
          default: 1
        }
      },
      required: ['ticketId', 'title', 'data']
    }
  },

  // Expense Reports tools
  {
    name: 'autotask_get_expense_report',
    description: 'Get a specific expense report by ID',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: {
          type: 'number',
          description: 'The expense report ID to retrieve'
        }
      },
      required: ['reportId']
    }
  },
  {
    name: 'autotask_search_expense_reports',
    description: 'Search for expense reports with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        submitterId: {
          type: 'number',
          description: 'Filter by submitter resource ID'
        },
        status: {
          type: 'number',
          description: 'Filter by status (1=New, 2=Submitted, 3=Approved, 4=Paid, 5=Rejected, 6=InReview)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_expense_report',
    description: 'Create a new expense report',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Expense report name'
        },
        description: {
          type: 'string',
          description: 'Expense report description'
        },
        submitterId: {
          type: 'number',
          description: 'The resource ID of the submitter'
        },
        weekEndingDate: {
          type: 'string',
          description: 'Week ending date (YYYY-MM-DD format)'
        }
      },
      required: ['name', 'submitterId', 'weekEndingDate']
    }
  },

  // Expense Item tools
  {
    name: 'autotask_create_expense_item',
    description: 'Create an expense item on an existing expense report',
    inputSchema: {
      type: 'object',
      properties: {
        expenseReportId: { type: 'number', description: 'The expense report ID to add the item to' },
        description: { type: 'string', description: 'Line item description' },
        expenseDate: { type: 'string', description: 'Date of expense (YYYY-MM-DD format)' },
        expenseCategory: { type: 'number', description: 'Expense category picklist ID' },
        amount: { type: 'number', description: 'Expense amount' },
        companyId: { type: 'number', description: 'Associated company ID (0 for internal)' },
        haveReceipt: { type: 'boolean', description: 'Whether a receipt is attached' },
        isBillableToCompany: { type: 'boolean', description: 'Whether billable to company' },
        isReimbursable: { type: 'boolean', description: 'Whether this expense is reimbursable' },
        paymentType: { type: 'number', description: 'Payment type picklist ID' }
      },
      required: ['expenseReportId', 'description', 'expenseDate', 'expenseCategory', 'amount']
    }
  },

  // Quotes tools
  {
    name: 'autotask_get_quote',
    description: 'Get a specific quote by ID',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The quote ID to retrieve'
        }
      },
      required: ['quoteId']
    }
  },
  {
    name: 'autotask_search_quotes',
    description: 'Search for quotes with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        contactId: {
          type: 'number',
          description: 'Filter by contact ID'
        },
        opportunityId: {
          type: 'number',
          description: 'Filter by opportunity ID'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term for quote name or description'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_quote',
    description: 'Create a new quote',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Quote name'
        },
        description: {
          type: 'string',
          description: 'Quote description'
        },
        companyId: {
          type: 'number',
          description: 'Company ID for the quote'
        },
        contactId: {
          type: 'number',
          description: 'Contact ID for the quote'
        },
        opportunityId: {
          type: 'number',
          description: 'Associated opportunity ID'
        },
        effectiveDate: {
          type: 'string',
          description: 'Effective date (YYYY-MM-DD format)'
        },
        expirationDate: {
          type: 'string',
          description: 'Expiration date (YYYY-MM-DD format)'
        }
      },
      required: ['companyId']
    }
  },

  // Opportunity tools
  {
    name: 'autotask_get_opportunity',
    description: 'Get a specific opportunity by ID',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: {
          type: 'number',
          description: 'The opportunity ID to retrieve'
        }
      },
      required: ['opportunityId']
    }
  },
  {
    name: 'autotask_search_opportunities',
    description: 'Search for opportunities with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term for opportunity title'
        },
        status: {
          type: 'number',
          description: 'Filter by status'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },

  {
    name: 'autotask_create_opportunity',
    description: 'Create a new sales opportunity in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Opportunity name/title'
        },
        companyId: {
          type: 'number',
          description: 'Company ID for the opportunity'
        },
        ownerResourceId: {
          type: 'number',
          description: 'Owner resource ID (the sales rep or account manager)'
        },
        status: {
          type: 'number',
          description: 'Status: 0=Not Ready To Buy, 1=Active, 2=Lost, 3=Closed, 4=Implemented'
        },
        stage: {
          type: 'number',
          description: 'Stage picklist value ID (use autotask_get_field_info to find valid values)'
        },
        projectedCloseDate: {
          type: 'string',
          description: 'Projected close date (YYYY-MM-DD)'
        },
        startDate: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD)'
        },
        probability: {
          type: 'number',
          description: 'Win probability percentage (0-100, default: 50)'
        },
        amount: {
          type: 'number',
          description: 'Revenue amount (default: 0, set useQuoteTotals=true to calculate from quotes)'
        },
        cost: {
          type: 'number',
          description: 'Cost amount (default: 0)'
        },
        useQuoteTotals: {
          type: 'boolean',
          description: 'Whether to calculate totals from linked quotes (default: true)'
        },
        totalAmountMonths: {
          type: 'number',
          description: 'Number of months to calculate totals for (e.g., 12 for annual)'
        },
        contactId: {
          type: 'number',
          description: 'Contact ID for the opportunity'
        },
        description: {
          type: 'string',
          description: 'Opportunity description'
        },
        opportunityCategoryID: {
          type: 'number',
          description: 'Opportunity category picklist value ID'
        }
      },
      required: ['title', 'companyId', 'ownerResourceId', 'status', 'stage', 'projectedCloseDate', 'startDate']
    }
  },
  {
    name: 'autotask_update_opportunity',
    description:
      'Update a sales opportunity. Uses the Autotask collection PATCH convention ' +
      '(the item route does not work in the GDS zone). To close an opportunity, ' +
      'set status (e.g. 2=Lost, 3=Closed) — confirm with the user first for an ' +
      'ambiguous request, then read it back with autotask_get_opportunity.',
    annotations: { title: 'Update opportunity', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'number', description: 'Opportunity ID to update' },
        title: { type: 'string', description: 'Opportunity name/title' },
        status: { type: 'number', description: 'Status: 0=Not Ready To Buy, 1=Active, 2=Lost, 3=Closed, 4=Implemented' },
        stage: { type: 'number', description: 'Stage picklist value ID' },
        projectedCloseDate: { type: 'string', description: 'Projected close date (YYYY-MM-DD)' },
        startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        amount: { type: 'number', description: 'Revenue amount' },
        cost: { type: 'number', description: 'Cost amount' },
        probability: { type: 'number', description: 'Win probability percentage (0-100)' },
        contactId: { type: 'number', description: 'Contact ID' },
        description: { type: 'string', description: 'Opportunity description' }
      },
      required: ['opportunityId']
    }
  },

  // Product tools
  {
    name: 'autotask_get_product',
    description: 'Get a specific product by ID',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'number',
          description: 'The product ID to retrieve'
        }
      },
      required: ['productId']
    }
  },
  {
    name: 'autotask_search_products',
    description: 'Search for products with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for product name'
        },
        isActive: {
          type: 'boolean',
          
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_find_product',
    description: "Clean, normalized product search across ALL identifiers — the usable layer over Autotask's weak native search. Matches the query against sku, internalProductID, externalProductID, manufacturerProductName, vendorProductNumber (+ name/description tokens), scores each product, and returns ranked matches with which fields matched. An exact identifier hit ranks highest; token overlap catches e.g. \"cat6 keystone\" → \"Blue Cat6 Keystone\". Use this instead of autotask_search_products when a plain name search misses. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part number, manufacturer/vendor number, or name terms' },
        limit: { type: 'number', description: 'Max matches to return (default 25)', minimum: 1, maximum: 200 },
        activeOnly: { type: 'boolean', description: 'Only active products (default false — dedup/cleanup often needs inactive ones too)' },
        maxProducts: { type: 'number', description: 'Cap on catalog rows scanned (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: ['query']
    },
    annotations: { title: 'Find product (clean search)', readOnlyHint: true }
  },
  {
    name: 'autotask_list_product_categories',
    description: "List the productCategory picklist as a parent→child tree (categories are a hierarchical picklist named 'Parent>Child>Grandchild', not a REST entity). Flags malformed labels (a label that reads like a description, not a name) and, with withCounts, tallies products per category. The map for standardizing/reclassifying the catalog. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        withCounts: { type: 'boolean', description: 'Tally product counts per category (scans the catalog; default false)' },
        maxProducts: { type: 'number', description: 'Cap on products scanned for counts (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'List product categories', readOnlyHint: true }
  },
  {
    name: 'autotask_find_catalog_gaps',
    description: 'Find products with data gaps for cleanup (read-only): missing productCategory, missing MSRP, or a weak description (empty, too short, or identical to the name). Returns counts plus sample product refs per gap type. Scope with activeOnly (default true).',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: { type: 'boolean', description: 'Only active products (default true)' },
        minDescriptionLength: { type: 'number', description: 'Descriptions shorter than this count as weak (default 10)', minimum: 1 },
        maxSamples: { type: 'number', description: 'Sample product refs per gap type (default 25)', minimum: 1 },
        maxProducts: { type: 'number', description: 'Cap on catalog rows scanned (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Find catalog gaps', readOnlyHint: true }
  },
  {
    name: 'autotask_find_duplicate_products',
    description: 'Find duplicate-product candidate groups (read-only): products sharing a normalized identifier (sku, else manufacturerProductName, else name) are grouped, each with a suggested survivor (active > most complete > lowest id) — the item to keep when merging the rest down. Includes inactive products by default so existing dupes surface. Returns groups ranked by size. Use before a Phase B merge.',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: { type: 'boolean', description: 'Only active products (default false)' },
        limit: { type: 'number', description: 'Max duplicate groups to return (default all)', minimum: 1 },
        maxProducts: { type: 'number', description: 'Cap on catalog rows scanned (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Find duplicate products', readOnlyHint: true }
  },
  {
    name: 'autotask_bulk_update_products',
    description: "Bulk-update products for catalog cleanup (dry-run-first). Pass an `updates` array of per-product patches ({ id, plus any of: name, description, sku, internalProductID, manufacturerName, manufacturerProductName, vendorProductNumber, productCategory, unitCost, unitPrice, msrp, isActive, isSerialized, link, defaultVendorID }). Each patch is diffed against current values, so only real changes are written and no-ops are skipped. SAFE BY DEFAULT: unless dryRun:false, nothing is written and the planned before→after changes are returned for review. Returns per-item results with partial-failure reporting. Use for mass reclassify / description / MSRP / part-number standardization.",
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Per-product patches; each needs id + at least one field to change.',
          items: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' }, description: { type: 'string' }, sku: { type: 'string' }, internalProductID: { type: 'string' }, manufacturerName: { type: 'string' }, manufacturerProductName: { type: 'string' }, vendorProductNumber: { type: 'string' }, productCategory: { type: 'number' }, unitCost: { type: 'number' }, unitPrice: { type: 'number' }, msrp: { type: 'number' }, isActive: { type: 'boolean' }, isSerialized: { type: 'boolean' }, link: { type: 'string' }, defaultVendorID: { type: 'number' } }, required: ['id'] }
        },
        dryRun: { type: 'boolean', description: 'When true (DEFAULT) validate + return planned changes without writing. Pass false to apply.', default: true }
      },
      required: ['updates']
    },
    annotations: { title: 'Bulk update products' }
  },
  {
    name: 'autotask_merge_products',
    description: "Merge duplicate products (dry-run-first): keep `survivorId`, enrich it with any fields it's missing from the duplicates (description/MSRP/category/part numbers/pricing), and mark the duplicate products inactive. Never moves inventory — duplicates that still hold on-hand stock are flagged (onHandWarnings) so you reconcile/transfer counts first. SAFE BY DEFAULT: unless dryRun:false, nothing is written and the plan (survivor enrichment + which dups would deactivate + stock warnings) is returned. Get candidate groups from autotask_find_duplicate_products.",
    inputSchema: {
      type: 'object',
      properties: {
        survivorId: { type: 'number', description: 'Product to keep' },
        duplicateIds: { type: 'array', items: { type: 'number' }, description: 'Products to merge into the survivor (deactivated)' },
        enrichSurvivor: { type: 'boolean', description: 'Copy missing fields from dups onto the survivor (default true)' },
        dryRun: { type: 'boolean', description: 'When true (DEFAULT) return the plan without writing. Pass false to apply.', default: true }
      },
      required: ['survivorId', 'duplicateIds']
    },
    annotations: { title: 'Merge duplicate products' }
  },
  {
    name: 'autotask_create_product',
    description: 'Create a product in the catalog. Common fields: name, description, sku, internalProductID, manufacturerName, manufacturerProductName, vendorProductNumber, productCategory (picklist id — see autotask_list_product_categories), unitCost, unitPrice, msrp, isActive, isSerialized, defaultVendorID, link.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Product name' },
        description: { type: 'string' },
        sku: { type: 'string', description: 'Your internal/clean part number' },
        internalProductID: { type: 'string' },
        manufacturerName: { type: 'string' },
        manufacturerProductName: { type: 'string', description: 'Manufacturer part number' },
        vendorProductNumber: { type: 'string', description: 'Supplier part number' },
        productCategory: { type: 'number', description: 'Category picklist id' },
        unitCost: { type: 'number' }, unitPrice: { type: 'number' }, msrp: { type: 'number' },
        isActive: { type: 'boolean' }, isSerialized: { type: 'boolean' },
        defaultVendorID: { type: 'number' }, link: { type: 'string', description: 'Product/reference URL' }
      },
      required: ['name']
    }
  },
  {
    name: 'autotask_update_product',
    description: 'Update a catalog product by id. Pass id plus any fields to change (name, description, sku, internalProductID, manufacturerProductName, vendorProductNumber, productCategory, unitCost, unitPrice, msrp, isActive, link, …). Use to standardize part numbers, fix categories/descriptions, set MSRP, or deactivate a duplicate (isActive:false).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Product id' },
        name: { type: 'string' }, description: { type: 'string' }, sku: { type: 'string' },
        internalProductID: { type: 'string' }, manufacturerName: { type: 'string' }, manufacturerProductName: { type: 'string' },
        vendorProductNumber: { type: 'string' }, productCategory: { type: 'number' },
        unitCost: { type: 'number' }, unitPrice: { type: 'number' }, msrp: { type: 'number' },
        isActive: { type: 'boolean' }, isSerialized: { type: 'boolean' }, link: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_search_inventory_products',
    description: "A product's stock levels per location (InventoryProducts): onHandUnits, availableUnits, reservedUnits, pickedUnits, unitsOnOrder, quantityMinimum/Maximum, bin, referenceNumber. Filter by productID and/or inventoryLocationID.",
    inputSchema: { type: 'object', properties: { productID: { type: 'number' }, inventoryLocationID: { type: 'number' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search inventory products', readOnlyHint: true }
  },
  { name: 'autotask_get_inventory_product', description: 'Get one InventoryProducts record (a product\'s stock at a location) by id.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, annotations: { title: 'Get inventory product', readOnlyHint: true } },
  {
    name: 'autotask_create_inventory_product',
    description: 'Stock a product at a location: create an InventoryProducts record. Required: productID, inventoryLocationID, quantityMinimum, quantityMaximum, availableUnits. Optional: bin, referenceNumber.',
    inputSchema: { type: 'object', properties: { productID: { type: 'number' }, inventoryLocationID: { type: 'number' }, quantityMinimum: { type: 'number' }, quantityMaximum: { type: 'number' }, availableUnits: { type: 'number' }, bin: { type: 'string' }, referenceNumber: { type: 'string' } }, required: ['productID', 'inventoryLocationID', 'quantityMinimum', 'quantityMaximum', 'availableUnits'] }
  },
  {
    name: 'autotask_update_inventory_product',
    description: 'Update an InventoryProducts record (stock levels/min-max/bin) by id. Note: on-hand counts are changed via stock add/remove or transfers, not here — this sets quantityMinimum/Maximum, bin, referenceNumber.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, quantityMinimum: { type: 'number' }, quantityMaximum: { type: 'number' }, bin: { type: 'string' }, referenceNumber: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'autotask_search_inventory_locations',
    description: 'Inventory locations (warehouses / tech vans): locationName, isActive, isDefault, resourceID (a resource-linked location = a tech van). Optionally filter by isActive.',
    inputSchema: { type: 'object', properties: { isActive: { type: 'boolean' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search inventory locations', readOnlyHint: true }
  },
  { name: 'autotask_get_inventory_location', description: 'Get one InventoryLocations record by id.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, annotations: { title: 'Get inventory location', readOnlyHint: true } },
  {
    name: 'autotask_create_inventory_location',
    description: 'Create an inventory location (warehouse or tech van). Required: locationName, isActive. Optional: isDefault, resourceID (link to a resource for a tech-van location).',
    inputSchema: { type: 'object', properties: { locationName: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, resourceID: { type: 'number' } }, required: ['locationName', 'isActive'] }
  },
  {
    name: 'autotask_update_inventory_location',
    description: 'Update an inventory location by id (locationName, isActive, isDefault, resourceID).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, locationName: { type: 'string' }, isActive: { type: 'boolean' }, isDefault: { type: 'boolean' }, resourceID: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'autotask_search_inventory_stocked_items',
    description: 'Individual stocked units (InventoryStockedItems): onHandUnits, availableUnits, serialNumber, statusID, unitCost, currentInventoryLocationID, vendorID, and consumption links (ticketChargeID / projectChargeID / pickedRemovedDateTime). Filter by inventoryProductID, currentInventoryLocationID, and/or serialNumber.',
    inputSchema: { type: 'object', properties: { inventoryProductID: { type: 'number' }, currentInventoryLocationID: { type: 'number' }, serialNumber: { type: 'string' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search stocked items', readOnlyHint: true }
  },
  { name: 'autotask_get_inventory_stocked_item', description: 'Get one InventoryStockedItems record by id.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }, annotations: { title: 'Get stocked item', readOnlyHint: true } },
  {
    name: 'autotask_search_inventory_transfers',
    description: 'Stock transfers between locations (InventoryTransfers): productID, fromLocationID, toLocationID, quantityTransferred, transferDate, notes, serialNumber. Filter by productID / fromLocationID / toLocationID.',
    inputSchema: { type: 'object', properties: { productID: { type: 'number' }, fromLocationID: { type: 'number' }, toLocationID: { type: 'number' }, pageSize: { type: 'number', minimum: 1, maximum: 500 } }, required: [] },
    annotations: { title: 'Search inventory transfers', readOnlyHint: true }
  },
  {
    name: 'autotask_create_inventory_transfer',
    description: 'Move stock between locations (creates an InventoryTransfers record; mutates on-hand at both locations). Required: fromLocationID, toLocationID, productID, quantityTransferred. Optional: serialNumber (serialized), notes, transferByResourceID, transferDate. Inventory-movement — requires confirm:true.',
    inputSchema: { type: 'object', properties: { fromLocationID: { type: 'number' }, toLocationID: { type: 'number' }, productID: { type: 'number' }, quantityTransferred: { type: 'number' }, serialNumber: { type: 'string' }, notes: { type: 'string' }, transferByResourceID: { type: 'number' }, transferDate: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true to execute (inventory movement)' } }, required: ['fromLocationID', 'toLocationID', 'productID', 'quantityTransferred'] }
  },
  {
    name: 'autotask_add_inventory_stock',
    description: 'Add/receive stock — raise on-hand for an inventory product (InventoryStockedItemsAdd). Use to correct a phantom under-count or receive units. Required: inventoryProductID, quantityBeingAdded, vendorID, determineCostUsing. Optional: unitCost, serialNumber, vendorInvoiceNumber, reasonForUpdate. Inventory-movement — requires confirm:true.',
    inputSchema: { type: 'object', properties: { inventoryProductID: { type: 'number' }, quantityBeingAdded: { type: 'number' }, vendorID: { type: 'number' }, determineCostUsing: { type: 'number', description: 'Cost source (Autotask picklist)' }, unitCost: { type: 'number' }, serialNumber: { type: 'string' }, vendorInvoiceNumber: { type: 'string' }, reasonForUpdate: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true to execute (inventory movement)' } }, required: ['inventoryProductID', 'quantityBeingAdded', 'vendorID', 'determineCostUsing'] }
  },
  {
    name: 'autotask_remove_inventory_stock',
    description: '⚠ DESTRUCTIVE/HIGH-IMPACT: Remove stock — lower on-hand for an inventory product (InventoryStockedItemsRemove), a write-down that is not easily reversible. Use to correct a phantom over-count / write off dead stock. Required: quantityBeingRemoved, plus inventoryProductID (or a specific inventoryStockedItemID). Optional: reasonForUpdate. Requires confirm:true.',
    inputSchema: { type: 'object', properties: { inventoryProductID: { type: 'number' }, inventoryStockedItemID: { type: 'number' }, quantityBeingRemoved: { type: 'number' }, reasonForUpdate: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true to execute (destructive stock write-down)' } }, required: ['quantityBeingRemoved'] },
    annotations: { title: 'Remove inventory stock', destructiveHint: true }
  },
  {
    name: 'autotask_report_inventory_reorder',
    description: 'Inventory reorder-control report. Lists stocked products at or below their minimum (across all locations) with a suggested order quantity (up to max, net of on-order) and estimated cost. The monthly "what to order" report. Each line notes whether the location is a warehouse or a resource/tech-van.',
    inputSchema: {
      type: 'object',
      properties: {
        locationID: { type: 'number', description: 'Limit to one inventory location (omit for all)' },
        warehouseOnly: { type: 'boolean', description: 'Exclude resource/tech-van locations (default: false — all locations)' }
      },
      required: []
    },
    annotations: { title: 'Inventory reorder report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_inventory_closeouts',
    description: 'Inventory close-out report. Ticket charges marked to-order (Need to Order / On Order) whose product already has stock on hand — candidates to fulfill from stock and close out instead of ordering. Generic/catch-all products (no SKU, Misc/Equipment/etc.) are flagged because their stock counts are unreliable.',
    inputSchema: {
      type: 'object',
      properties: {
        includeGenerics: { type: 'boolean', description: 'Include generic/catch-all products, flagged (default: true)' }
      },
      required: []
    },
    annotations: { title: 'Inventory close-out report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_inventory_stale',
    description: 'Inventory stale/trending report. On-hand stock aged by receipt date with recent-movement counts, flagging dead stock (in stock longer than the stale threshold with no recent removals) and ranking by tied-up value. Each stale line carries an aging `bucket` (lt90 / d90_180 / d180_365 / d365plus, with per-bucket totals in `byBucket`) and a `classification`: "phantom" = never decremented in Autotask (no removal ever on record — likely a stock-count error to reconcile against physical) vs "dead-stock" = had movement but has stalled (genuine dead inventory). Summary includes phantomCount/phantomValue and deadStockCount/deadStockValue. The "is it selling, rotting on the shelf, or never really there" report.',
    inputSchema: {
      type: 'object',
      properties: {
        staleDays: { type: 'number', description: 'Days on hand before stock is considered stale (default: 180)', minimum: 1 },
        recentDays: { type: 'number', description: 'Window for counting recent movement (default: 180)', minimum: 1 }
      },
      required: []
    },
    annotations: { title: 'Inventory stale-stock report', readOnlyHint: true }
  },

  // Service tools
  {
    name: 'autotask_get_service',
    description: 'Get a specific service by ID',
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'number',
          description: 'The service ID to retrieve'
        }
      },
      required: ['serviceId']
    }
  },
  {
    name: 'autotask_search_services',
    description: 'Search for services with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for service name'
        },
        isActive: {
          type: 'boolean',
          
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },

  // Service Bundle tools
  {
    name: 'autotask_get_service_bundle',
    description: 'Get a specific service bundle by ID',
    inputSchema: {
      type: 'object',
      properties: {
        serviceBundleId: {
          type: 'number',
          description: 'The service bundle ID to retrieve'
        }
      },
      required: ['serviceBundleId']
    }
  },
  {
    name: 'autotask_search_service_bundles',
    description: 'Search for service bundles with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for service bundle name'
        },
        isActive: {
          type: 'boolean',
          
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },

  // Quote Item tools
  {
    name: 'autotask_get_quote_item',
    description: 'Get a specific quote item by ID',
    inputSchema: {
      type: 'object',
      properties: {
        quoteItemId: {
          type: 'number',
          description: 'The quote item ID to retrieve'
        }
      },
      required: ['quoteItemId']
    }
  },
  {
    name: 'autotask_search_quote_items',
    description: 'Search for quote items, typically filtered by quote ID',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'Filter by quote ID (recommended)'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term for quote item name'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 50, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_quote_item',
    description: 'Create a line item on a quote. Set exactly ONE item reference (serviceID, productID, or serviceBundleID). Required: quoteId, quantity. Defaults: unitDiscount=0, lineDiscount=0, percentageDiscount=0, isOptional=false.',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The quote ID to add this item to'
        },
        name: {
          type: 'string',
          description: 'Item name (auto-populated for service/product types)'
        },
        description: {
          type: 'string',
          description: 'Item description'
        },
        quantity: {
          type: 'number',
          description: 'Quantity of the item'
        },
        unitPrice: {
          type: 'number',
          description: 'Unit price for the item'
        },
        unitCost: {
          type: 'number',
          description: 'Unit cost for the item'
        },
        unitDiscount: {
          type: 'number',
          description: 'Per-unit discount amount (default: 0)'
        },
        lineDiscount: {
          type: 'number',
          description: 'Line-level discount amount (default: 0)'
        },
        percentageDiscount: {
          type: 'number',
          description: 'Percentage discount (default: 0)'
        },
        isOptional: {
          type: 'boolean',
          description: 'Whether this is an optional line item (default: false)'
        },
        serviceID: {
          type: 'number',
          description: 'Service ID to link (mutually exclusive with productID/serviceBundleID)'
        },
        productID: {
          type: 'number',
          description: 'Product ID to link (mutually exclusive with serviceID/serviceBundleID)'
        },
        serviceBundleID: {
          type: 'number',
          description: 'Service Bundle ID to link (mutually exclusive with serviceID/productID)'
        },
        sortOrderID: {
          type: 'number',
          description: 'Sort order for display'
        },
        quoteItemType: {
          type: 'number',
          description: 'Quote item type (auto-determined if omitted): 1=Product, 2=Cost, 3=Labor, 4=Expense, 6=Shipping, 11=Service, 12=ServiceBundle'
        }
      },
      required: ['quoteId', 'quantity']
    }
  },
  {
    name: 'autotask_update_quote_item',
    description: 'Update an existing quote item (quantity, price, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        quoteItemId: {
          type: 'number',
          description: 'The quote item ID to update'
        },
        quantity: {
          type: 'number',
          description: 'Updated quantity'
        },
        unitPrice: {
          type: 'number',
          description: 'Updated unit price'
        },
        unitDiscount: {
          type: 'number',
          description: 'Updated per-unit discount'
        },
        lineDiscount: {
          type: 'number',
          description: 'Updated line discount'
        },
        percentageDiscount: {
          type: 'number',
          description: 'Updated percentage discount'
        },
        isOptional: {
          type: 'boolean',
          description: 'Updated optional status'
        },
        sortOrderID: {
          type: 'number',
          description: 'Updated sort order'
        }
      },
      required: ['quoteItemId']
    }
  },
  {
    name: 'autotask_delete_quote_item',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a quote item ' +
      '(line item) from a quote. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete quote item (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The parent quote ID'
        },
        quoteItemId: {
          type: 'number',
          description: 'The quote item ID to delete'
        }
      },
      required: ['quoteId', 'quoteItemId']
    }
  },

  // Configuration Item tools
  {
    name: 'autotask_search_configuration_items',
    description: 'Search configuration items (assets) with optional filters, including native contract/service entitlement links. Combine filters (e.g. contractID + isActive) to find the assets a recurring service covers. Returns full CI records — all entitlement fields (contractID, contractServiceID, serviceID, etc.) are included.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term matched against the CI reference title (name)'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        companyLocationID: {
          type: 'number',
          description: 'Filter by company location ID (the site the asset lives at)'
        },
        contractID: {
          type: 'number',
          description: 'Filter by the contract the asset is entitled through'
        },
        contractServiceID: {
          type: 'number',
          description: 'Filter by the specific contract service line the asset is covered by'
        },
        contractServiceBundleID: {
          type: 'number',
          description: 'Filter by the contract service bundle the asset is covered by'
        },
        serviceID: {
          type: 'number',
          description: 'Filter by the service the asset maps to'
        },
        serviceBundleID: {
          type: 'number',
          description: 'Filter by the service bundle the asset maps to'
        },
        parentConfigurationItemID: {
          type: 'number',
          description: 'Filter by parent CI — returns the child assets of a given configuration item'
        },
        isActive: {
          type: 'boolean',
          description: 'Filter by active state. Set true to exclude sunset/inactive assets from a maintenance run.'
        },
        productID: {
          type: 'number',
          description: 'Filter by product ID'
        },
        configurationItemType: {
          type: 'number',
          description: 'Filter by configuration item type (numeric picklist value)'
        },
        configurationItemCategoryID: {
          type: 'number',
          description: 'Filter by configuration item category ID'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_configuration_item',
    description: 'Create a configuration item (managed asset) for a company. Created through the Companies/{companyID}/ConfigurationItems child route because companyID is read-only on the entity: it is fixed at creation and a CI can never be moved between companies afterwards. productID is required by Autotask. Validates that a referenced contract or parent CI belongs to the same company, since Autotask does not, and a CI covered by another company contract reports false entitlement. Fields Autotask does not accept (the rmm*/ssl* audit surface it populates itself) are dropped with a warning rather than failing the write.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Company that owns this CI. Required, and permanent: companyID is read-only after creation.' },
        isActive: { type: 'boolean', description: 'Active state (default true). There is no separate lifecycle/status field on ConfigurationItems: isActive:false is how a CI is retired.' },
        productID: { type: 'number', description: 'Product this CI is an instance of' },
        companyLocationID: { type: 'number', description: 'Site/location the CI is installed at' },
        contactID: { type: 'number', description: 'Contact who owns or is custodian of this CI' },
        parentConfigurationItemID: { type: 'number', description: 'Parent CI, for child/component relationships. Must belong to the same company.' },
        vendorID: { type: 'number', description: 'Vendor company the CI was supplied by' },
        contractID: { type: 'number', description: 'Contract covering this CI. Must belong to the same company as the CI.' },
        contractServiceID: { type: 'number', description: 'Specific contract service line covering this CI' },
        contractServiceBundleID: { type: 'number', description: 'Contract service bundle covering this CI' },
        serviceID: { type: 'number', description: 'Service this CI is an instance of' },
        serviceBundleID: { type: 'number', description: 'Service bundle this CI belongs to' },
        serviceLevelAgreementID: { type: 'number', description: 'SLA picklist ID. Use autotask_get_field_info (ConfigurationItems, serviceLevelAgreementID) for valid values.' },
        configurationItemCategoryID: { type: 'number', description: 'CI category ID' },
        configurationItemType: { type: 'number', description: 'CI type picklist ID. Use autotask_get_field_info (ConfigurationItems, configurationItemType) for valid values.' },
        referenceNumber: { type: 'string', description: 'Reference number (asset tag)' },
        referenceTitle: { type: 'string', description: 'Reference title / friendly name' },
        serialNumber: { type: 'string', description: 'Serial number' },
        location: { type: 'string', description: 'Free-text location within the site (e.g. MDF rack 3)' },
        notes: { type: 'string', description: 'Notes' },
        installDate: { type: 'string', description: 'Install date (ISO 8601)' },
        warrantyExpirationDate: { type: 'string', description: 'Warranty expiration date (ISO 8601)' },
        numberOfUsers: { type: 'number', description: 'Number of users this CI serves' },
        dailyCost: { type: 'number', description: 'Daily cost' },
        hourlyCost: { type: 'number', description: 'Hourly cost' },
        monthlyCost: { type: 'number', description: 'Monthly cost' },
        perUseCost: { type: 'number', description: 'Per-use cost' },
        setupFee: { type: 'number', description: 'Setup fee' },
      },
      required: ['companyID', 'productID']
    }
  },
  {
    name: 'autotask_update_configuration_item',
    description: 'Update a configuration item: the same lifecycle surface as create, minus companyID, which Autotask will not let you change (a CI cannot be moved between companies; retire it with isActive:false and create a new one under the correct company). Use isActive:false to retire/deactivate and isActive:true to reactivate; there is no separate lifecycle/status field on ConfigurationItems. Use companyLocationID to move a CI between sites, parentConfigurationItemID to re-parent it, and the contract/service fields to change its coverage. Fields Autotask does not accept are dropped with a warning.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The configuration item to update' },
        isActive: { type: 'boolean', description: 'Set false to retire/deactivate the CI, true to reactivate it' },
        productID: { type: 'number', description: 'Product this CI is an instance of' },
        companyLocationID: { type: 'number', description: 'Site/location the CI is installed at' },
        contactID: { type: 'number', description: 'Contact who owns or is custodian of this CI' },
        parentConfigurationItemID: { type: 'number', description: 'Parent CI, for child/component relationships. Must belong to the same company.' },
        vendorID: { type: 'number', description: 'Vendor company the CI was supplied by' },
        contractID: { type: 'number', description: 'Contract covering this CI. Must belong to the same company as the CI.' },
        contractServiceID: { type: 'number', description: 'Specific contract service line covering this CI' },
        contractServiceBundleID: { type: 'number', description: 'Contract service bundle covering this CI' },
        serviceID: { type: 'number', description: 'Service this CI is an instance of' },
        serviceBundleID: { type: 'number', description: 'Service bundle this CI belongs to' },
        serviceLevelAgreementID: { type: 'number', description: 'SLA picklist ID. Use autotask_get_field_info (ConfigurationItems, serviceLevelAgreementID) for valid values.' },
        configurationItemCategoryID: { type: 'number', description: 'CI category ID' },
        configurationItemType: { type: 'number', description: 'CI type picklist ID. Use autotask_get_field_info (ConfigurationItems, configurationItemType) for valid values.' },
        referenceNumber: { type: 'string', description: 'Reference number (asset tag)' },
        referenceTitle: { type: 'string', description: 'Reference title / friendly name' },
        serialNumber: { type: 'string', description: 'Serial number' },
        location: { type: 'string', description: 'Free-text location within the site (e.g. MDF rack 3)' },
        notes: { type: 'string', description: 'Notes' },
        installDate: { type: 'string', description: 'Install date (ISO 8601)' },
        warrantyExpirationDate: { type: 'string', description: 'Warranty expiration date (ISO 8601)' },
        numberOfUsers: { type: 'number', description: 'Number of users this CI serves' },
        dailyCost: { type: 'number', description: 'Daily cost' },
        hourlyCost: { type: 'number', description: 'Hourly cost' },
        monthlyCost: { type: 'number', description: 'Monthly cost' },
        perUseCost: { type: 'number', description: 'Per-use cost' },
        setupFee: { type: 'number', description: 'Setup fee' },
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_get_configuration_item',
    description: 'Get a single configuration item (asset) by ID with all current details, including entitlement fields (companyID, companyLocationID, contractID, contractServiceID, serviceID, isActive, serialNumber, installDate, warrantyExpirationDate). Set enrichReferences=true to also resolve human-readable names for the linked company, contract, service, product, and parent CI.',
    inputSchema: {
      type: 'object',
      properties: {
        configurationItemId: {
          type: 'number',
          description: 'The configuration item (asset) ID to retrieve'
        },
        enrichReferences: {
          type: 'boolean',
          description: 'When true, resolve reference names (companyName, contractName, contractStatus, serviceName, contractServiceName, productName, parentConfigurationItemName) best-effort into an `_enriched` object. Adds extra read calls; default false.'
        }
      },
      required: ['configurationItemId']
    }
  },
  {
    name: 'autotask_get_configuration_item_entitlement',
    description: 'Determine whether a configuration item is entitled to recurring service, and why. Returns { isEntitled, reason, evidence }. Normalized reasons: ACTIVE_CI_ACTIVE_CONTRACT_SERVICE (entitled), ACTIVE_CI_NO_CONTRACT, CONTRACT_EXPIRED, CONTRACT_TERMINATED, CONTRACT_SERVICE_MISMATCH, SERVICE_NOT_MAPPED, CI_INACTIVE. Contract active/expired is judged by the tenant status label + endDate, not a hardcoded value.',
    inputSchema: {
      type: 'object',
      properties: {
        configurationItemId: { type: 'number', description: 'The configuration item (asset) ID to evaluate' }
      },
      required: ['configurationItemId']
    },
    annotations: { title: 'Get configuration item entitlement', readOnlyHint: true }
  },
  {
    name: 'autotask_search_configuration_item_coverage_gaps',
    description: 'List ACTIVE configuration items with no contract coverage (no contractID and no contractServiceID) — the uncovered assets for Sales / Account Management review. Scope to one company or the whole org. Coverage is computed in-memory because Autotask\'s null filters on CI foreign keys are unreliable.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company (omit for the whole org)' },
        pageSize: { type: 'number', description: 'Max active CIs to scan (default 500, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search configuration item coverage gaps', readOnlyHint: true }
  },
  {
    name: 'autotask_create_maintenance_ticket',
    description: 'High-level maintenance-ticket orchestrator. Validates company → contract (active/not-expired) → contract service → CI ownership/activity, checks externalID for an existing occurrence (idempotency — no duplicate), then creates the ticket, links additional CIs, applies a checklist library, and reads everything back. Set dryRun:true to validate and return the plan WITHOUT writing (recommended for pilot/manual-approval runs). The MCP does not own recurrence scheduling — the caller decides when an occurrence is due.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Company the ticket is for' },
        title: { type: 'string', description: 'Ticket title' },
        description: { type: 'string', description: 'Structured ticket description (whitespace preserved verbatim)' },
        configurationItemID: { type: 'number', description: 'Primary configuration item (asset). Validated for company ownership + active state.' },
        additionalConfigurationItemIDs: { type: 'array', items: { type: 'number' }, description: 'Additional CIs to link via TicketAdditionalConfigurationItems' },
        contractID: { type: 'number', description: 'Contract to deliver/bill under. Validated active + not expired.' },
        contractServiceID: { type: 'number', description: 'Contract service line. Validated to belong to contractID.' },
        companyLocationID: { type: 'number', description: 'Site/location for the ticket' },
        externalID: { type: 'string', description: 'Occurrence/idempotency key. If a ticket already exists with it, no duplicate is created (unless allowDuplicate).' },
        checklistLibraryID: { type: 'number', description: 'Checklist library to apply to the created ticket' },
        ticketFields: { type: 'object', description: 'Additional ticket fields to set (queueID, priority, status, ticketType, billingCodeID, dueDateTime, etc.)' },
        dryRun: { type: 'boolean', description: 'Validate only and return the plan without creating anything (default false)' },
        allowDuplicate: { type: 'boolean', description: 'Create even if a ticket with the externalID already exists (default false)' },
        requireEntitlement: { type: 'boolean', description: 'Require the primary CI to be entitled (ACTIVE_CI_ACTIVE_CONTRACT_SERVICE) before creating (default false)' }
      },
      required: ['companyID', 'title', 'description']
    }
  },

  // Contract tools
  {
    name: 'autotask_search_contracts',
    description: 'Search for contracts in Autotask with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for contract name'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        status: {
          type: 'number',
          description: 'Filter by contract status (1=In Effect, 3=Terminated)'
        },
        contractType: {
          type: 'number',
          description: 'Filter by contract type picklist ID'
        },
        endDateFrom: {
          type: 'string',
          description: 'Only contracts ending on or after this date (ISO YYYY-MM-DD)'
        },
        endDateTo: {
          type: 'string',
          description: 'Only contracts ending on or before this date (ISO YYYY-MM-DD)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_contract',
    description: 'Get a single contract by ID (header fields only, no service lines)',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Contract ID'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_list_expiring_contracts',
    description: 'List contracts whose end date falls within the next N days (expiring-contracts report). Optionally include already-expired contracts, and scope to one company or the whole org.',
    inputSchema: {
      type: 'object',
      properties: {
        daysAhead: {
          type: 'number',
          description: 'Look-ahead window in days (default: 60)',
          minimum: 0
        },
        companyID: {
          type: 'number',
          description: 'Limit the report to one company (omit for the whole org)'
        },
        includeExpired: {
          type: 'boolean',
          description: 'Also include contracts whose end date is already in the past (default: false)'
        },
        status: {
          type: 'number',
          description: 'Filter by contract status (1=In Effect, 3=Terminated)'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 100, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_report_block_hour_usage',
    description: 'Block-hour contract usage report. For block-hour contracts (monthly, use-it-or-lose-it), returns per-month allocated vs used hours with billable overage and forfeited (expired) hours, plus contract totals and the current month in progress. Scope to one contract, one company, or all active block-hour contracts (default).',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: {
          type: 'number',
          description: 'Report on a single block-hour contract'
        },
        companyID: {
          type: 'number',
          description: 'Limit to one company (omit for all active block-hour contracts)'
        },
        includeInactive: {
          type: 'boolean',
          description: 'Also include inactive/expired contracts (default: false — active only)'
        }
      },
      required: []
    },
    annotations: { title: 'Block-hour usage report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_ticket_charges',
    description: 'Ticket-charge report. Charges in a recent window with a fulfillment-status breakdown, billed vs unbilled counts, total billable amount, and a per-ticket rollup. Set unbilledOnly to surface the to-bill queue (charges not yet billed). Optional company/status/date-window filters.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceDays: { type: 'number', description: 'Look-back window in days (default: 90)', minimum: 1 },
        unbilledOnly: { type: 'boolean', description: 'Only charges not yet billed — the to-bill queue (default: false)' },
        status: { type: 'number', description: 'Filter by fulfillment status (1=Pending, 3=Need to Order, 4=On Order, 6=Ready to Ship, 7=Delivered, 8=Canceled)' },
        companyID: { type: 'number', description: 'Limit to one company (omit for all)' }
      },
      required: []
    },
    annotations: { title: 'Ticket-charge report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_unbilled',
    description: 'Unbilled-work / revenue-leakage report. Billable work that has been posted but not yet invoiced (uninvoiced billing items — time and charges), aged into 0-30 / 31-60 / 61-90 / 90+ day buckets with an at-risk (>30 days) total and a per-company rollup. Catches billable time and charges that age out unbilled because only recent items get reviewed. Optional company filter and minimum age.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company (omit for all)' },
        minAgeDays: { type: 'number', description: 'Only items at least this many days old (e.g. 30 for the at-risk backlog)', minimum: 0 }
      },
      required: []
    },
    annotations: { title: 'Unbilled-work report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_sla_compliance',
    description: "SLA compliance report (read-only). Classifies each ticket's three SLA stages — Triage/First-Response, Tech-Engagement/Resolution-Plan, Resolved — as met (actual ≤ due) / missed (actual > due) / pending (open, due in future) / breached (open, due passed) / no_target (no SLA due set). Returns per-stage counts + compliance % (met ÷ closed), a breach queue (open+overdue, worst first) for 'what needs attention now', and optional grouping. Scope by createDate window (default last 30 days) + optional company/queue; group by queue, resource, company, week, or month. For n8n/chat dashboards.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Tickets created on/after (YYYY-MM-DD); default 30 days ago' },
        to: { type: 'string', description: 'Tickets created on/before (YYYY-MM-DD)' },
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        openOnly: { type: 'boolean', description: 'Only non-complete tickets (default false)' },
        groupBy: { type: 'string', enum: ['queue', 'resource', 'company', 'week', 'month'], description: 'Break the report down by this dimension' },
        maxTickets: { type: 'number', description: 'Cap on tickets evaluated (default 2000, max 10000)', minimum: 1, maximum: 10000 }
      },
      required: []
    },
    annotations: { title: 'SLA compliance report', readOnlyHint: true }
  },
  {
    name: 'autotask_generate_sla_framework',
    description: "ITIL SLA setup helper (advisory, deterministic, no Autotask writes). Generates the standardized SLA build to ENTER IN THE AUTOTASK UI, because SLA and priority definitions are UI-only (no REST entity for ServiceLevelAgreements; the priority picklist is not API-writable). Output: (1) an Impact × Urgency → Priority matrix (decision guidance — Autotask has no impact/urgency field); (2) a clean P1–P4 (or P5) priority scheme with names/descriptions to replace a drifted picklist; (3) an SLA target matrix — first-response / resolution-plan / resolution per priority × request type (Incident vs Service Request) × customer tier, with 24x7-vs-8x5 coverage; (4) UI steps and caveats. Optionally pass your CURRENT priority values to get a classified migration map (severity → Pn, response-time → SLA, work-type → queue, planned → Change). All numbers are ITIL-typical starting templates — tune via overrides. Pairs with autotask_report_sla_compliance, which measures met/missed once the SLAs are entered and assigned.",
    inputSchema: {
      type: 'object',
      properties: {
        levels: { type: 'number', enum: [4, 5], description: 'Priority levels: 4 (P1–P4, default) or 5 (adds P5 Planning lane)' },
        requestTypes: { type: 'array', items: { type: 'string', enum: ['Incident', 'ServiceRequest'] }, description: 'Request types to generate targets for (default both)' },
        tiers: {
          type: 'array',
          description: 'Customer tiers. Each: { name, multiplier, coverage? }. multiplier scales all target durations (>1 = looser); coverage overrides the level default. Omit for a single Standard tier (×1).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              multiplier: { type: 'number', description: 'Duration multiplier (e.g. 1 premier, 1.5 standard, 2 break-fix)', exclusiveMinimum: 0 },
              coverage: { type: 'string', enum: ['24x7', '8x5'], description: 'Force this tier\'s coverage regardless of priority default' }
            },
            required: ['name', 'multiplier']
          }
        },
        currentPriorities: { type: 'array', items: { type: 'string' }, description: 'Your existing (possibly messy) priority picklist values, to classify and map to the clean scheme' },
        businessHoursPerDay: { type: 'number', description: 'Business hours per working day for business-day math (default 8)', exclusiveMinimum: 0 },
        serviceRequestResolutionMultiplier: { type: 'number', description: 'How much looser Service Request plan/resolution is vs Incident at the same priority (default 2)', exclusiveMinimum: 0 },
        overrides: {
          type: 'object',
          description: 'Override default targets per priority code (P1..P5). Each value: { firstResponse?, resolutionPlan?, resolution? } in MINUTES, and/or { coverage }.',
          additionalProperties: {
            type: 'object',
            properties: {
              firstResponse: { type: 'number', description: 'Minutes' },
              resolutionPlan: { type: 'number', description: 'Minutes' },
              resolution: { type: 'number', description: 'Minutes' },
              coverage: { type: 'string', enum: ['24x7', '8x5'] }
            }
          }
        }
      },
      required: []
    },
    annotations: { title: 'Generate ITIL SLA framework', readOnlyHint: true }
  },
  {
    name: 'autotask_report_sla_coverage',
    description: "SLA coverage / readiness check (read-only, #102). Reports which contracts have NO SLA linked (Contracts.serviceLevelAgreementID empty) and whether any SLA definitions exist at all — the empty serviceLevelAgreementID picklist is the root of a 'no SLAs anywhere' tenant. Returns: the available SLA definitions (picklist values), counts of linked vs unlinked, the unlinked contract list (id, name, company, type, status, endDate), and a readiness verdict (no_sla_definitions | unlinked_contracts | all_linked). Active-status detection is derived from the status picklist labels; scope by company or explicit status, or activeOnly:false for every status. Pairs with autotask_generate_sla_framework (make the spec) and autotask_assign_contract_sla (link them).",
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company' },
        status: { type: 'number', description: 'Limit to one contract status value (overrides activeOnly)' },
        activeOnly: { type: 'boolean', description: 'Only active-status contracts (default true; active values derived from the status picklist labels)' },
        maxContracts: { type: 'number', description: 'Cap on contracts evaluated (default 2000, max 10000)', minimum: 1, maximum: 10000 }
      },
      required: []
    },
    annotations: { title: 'SLA coverage report', readOnlyHint: true }
  },
  {
    name: 'autotask_assign_contract_sla',
    description: "Bulk-assign an SLA to contracts (#102). SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written — it returns the planned assignments for review. serviceLevelAgreementID IS API-writable (unlike SLA definitions, which are UI-only), so this links existing SLAs to contracts. FAILS CLOSED if the tenant has no SLA definitions yet, or if a serviceLevelAgreementID isn't a valid active picklist value (returns the valid values). Skips no-ops (already set) and reports contracts not found. Give either assignments:[{contractID, serviceLevelAgreementID}] or the shorthand serviceLevelAgreementID + contractIDs:[...]. Returns the shared write-plan envelope (status: dry_run | validation_failed | assigned | assigned_with_errors). Reversible — it only sets a picklist link. Use autotask_report_sla_coverage to find the unlinked contracts and autotask_get_field_info('Contracts','serviceLevelAgreementID') to see valid SLA values.",
    inputSchema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          description: 'Explicit per-contract assignments. Each: { contractID, serviceLevelAgreementID }.',
          items: {
            type: 'object',
            properties: {
              contractID: { type: 'number' },
              serviceLevelAgreementID: { type: ['number', 'string'], description: 'A valid active value from the Contracts.serviceLevelAgreementID picklist' }
            },
            required: ['contractID', 'serviceLevelAgreementID']
          }
        },
        serviceLevelAgreementID: { type: ['number', 'string'], description: 'Shorthand: assign this one SLA to every id in contractIDs' },
        contractIDs: { type: 'array', items: { type: 'number' }, description: 'Shorthand: contracts to assign serviceLevelAgreementID to' },
        dryRun: { type: 'boolean', description: 'Default true — plan only, no writes. Pass false to apply.' }
      },
      required: []
    },
    annotations: { title: 'Assign SLA to contracts', readOnlyHint: false }
  },
  {
    name: 'autotask_report_time_entry_compliance',
    description: "Time-entry compliance / team hours (read-only, #100). Answers 'is the team doing real-time time entry, and are the hours there?' from TimeEntries. Per resource × week (or month): hours logged vs EXPECTED (utilization % and billable utilization %), billable vs non-billable split (non-billable is still paid time), APPROVED vs UNAPPROVED hours (billingApprovalDateTime — the timesheet check-and-balance; unapproved can't be billed/applied to contracts), and LATE entries (createDateTime logged > lateThresholdDays after dateWorked — the real-time-discipline signal). Flags resources: no_time, under_logged, low_billable_utilization, chronic_late_entry. Returns per-resource per-bucket rows + totals + overall + a data-quality block. Scope by dateWorked window (default last 4 weeks) + optional resource. For n8n/chat dashboards; no scheduling/notification here.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Work done on/after (YYYY-MM-DD); default 28 days ago' },
        to: { type: 'string', description: 'Work done on/before (YYYY-MM-DD); default today' },
        bucket: { type: 'string', enum: ['week', 'month'], description: 'Aggregation bucket (default week)' },
        resourceID: { type: 'number', description: 'Limit to one resource' },
        expectedHoursPerBucket: { type: 'number', description: 'Expected loggable hours per bucket (overrides expectedHoursPerWeek)', exclusiveMinimum: 0 },
        expectedHoursPerWeek: { type: 'number', description: 'Expected hours per week (default 40); month expected derived from this', exclusiveMinimum: 0 },
        lateThresholdDays: { type: 'number', description: 'Entries created more than this many days after the day worked count as late (default 2)', minimum: 0 },
        maxEntries: { type: 'number', description: 'Cap on time entries evaluated (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Time-entry compliance report', readOnlyHint: true }
  },
  {
    name: 'autotask_report_tickets_needing_scheduling',
    description: "Tickets needing scheduling (read-only, #100). Open tickets that should be on the calendar but aren't — extends the service-call reconciliation in report_service_call_leakage (that fixes leakage on tickets that HAD a service call; this catches the ones that never got one). Classifies each candidate as unscheduled (no service call linked), past_service_call (only stale/past calls — likely needs rescheduling), or scheduled (a future service call; excluded from the list, still counted). By default limits to open tickets with hoursToBeScheduled > 0 (the native 'hours remain to schedule' signal); pass requireHoursToSchedule:false to consider every open ticket, or ticketType to scope to install/project types. Returns the needs-scheduling list (worst backlog first — most hours, then oldest) with age + due date, counts, total hours to schedule, and optional grouping. For n8n/chat dashboards.",
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        ticketType: { type: 'number', description: 'Limit to one ticket type (e.g. install/project)' },
        requireHoursToSchedule: { type: 'boolean', description: 'Only tickets with hoursToBeScheduled > 0 (default true); false = every open ticket' },
        groupBy: { type: 'string', enum: ['queue', 'company', 'resource'], description: 'Summarize the backlog by this dimension' },
        maxTickets: { type: 'number', description: 'Cap on tickets evaluated (default 2000, max 10000)', minimum: 1, maximum: 10000 }
      },
      required: []
    },
    annotations: { title: 'Tickets needing scheduling', readOnlyHint: true }
  },
  {
    name: 'autotask_report_ticket_throughput',
    description: "Ticket throughput / work-queue KPIs (read-only, #100). Two views: FLOW over a window — created vs completed vs completion ratio + net backlog change (is the team keeping up with intake?); and the current BACKLOG snapshot — open tickets by age bucket (default 0-7 / 8-30 / 31-90 / 90+ days), by status (raw value + resolved label; open/waiting/on-hold splits stay tenant-specific), and oldest-open. Optional grouping by queue/resource/company gives per-team throughput (open + created + completed + ratio). Scope by createDate/completedDate window (default last 30 days) + optional company/queue. For n8n/chat dashboards.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Window start (YYYY-MM-DD); bounds created & completed. Default 30 days ago' },
        to: { type: 'string', description: 'Window end (YYYY-MM-DD); default today' },
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        agingThresholds: { type: 'array', items: { type: 'number' }, description: 'Ascending day thresholds for backlog age buckets (default [7,30,90])' },
        groupBy: { type: 'string', enum: ['queue', 'resource', 'company'], description: 'Per-team throughput breakdown' },
        maxTickets: { type: 'number', description: 'Cap per query — created/completed/open each (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Ticket throughput / work-queue KPIs', readOnlyHint: true }
  },
  {
    name: 'autotask_report_request_segmentation',
    description: "Request segmentation dimension (read-only, #100). The 'what kind of work is this?' lens: split tickets into delivery segments — project / install / recurring (managed) / support (reactive), or any scheme you define — and report per-segment KPIs (volume, open backlog, completed, avg open age, share %). Segment RULES are caller-provided because queues/types are tenant-specific: each rule matches when EVERY criterion it lists is satisfied (OR within each value set), first match wins. With NO rules it falls back to the universal ITIL classification by ticketType (Service Request / Incident / Problem / Change / Alert). Scope by createDate window (default 90 days) or openOnly for the current backlog, + optional company/queue. For n8n/chat dashboards and for reading the other #100 reports through a work-type lens.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Created on/after (YYYY-MM-DD); default 90 days ago (ignored when openOnly)' },
        to: { type: 'string', description: 'Created on/before (YYYY-MM-DD); default today (ignored when openOnly)' },
        openOnly: { type: 'boolean', description: 'Segment the current open backlog instead of a created-date window' },
        companyID: { type: 'number', description: 'Limit to one company' },
        queueID: { type: 'number', description: 'Limit to one queue' },
        segments: {
          type: 'array',
          description: 'Ordered segment rules (first match wins). Each rule matches when every criterion it specifies is satisfied.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              ticketType: { type: 'array', items: { type: 'number' }, description: '1=Service Request 2=Incident 3=Problem 4=Change 5=Alert' },
              queueID: { type: 'array', items: { type: 'number' } },
              priority: { type: 'array', items: { type: 'number' } },
              issueType: { type: 'array', items: { type: 'number' } },
              titleContains: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive title substrings (any match)' }
            },
            required: ['name']
          }
        },
        defaultSegmentName: { type: 'string', description: 'Name for tickets matching no rule (default "Unsegmented", or "Other" for the ITIL fallback)' },
        maxTickets: { type: 'number', description: 'Cap on tickets evaluated (default 5000, max 20000)', minimum: 1, maximum: 20000 }
      },
      required: []
    },
    annotations: { title: 'Request segmentation', readOnlyHint: true }
  },
  {
    name: 'autotask_report_project_pl',
    description: "Profitability (P&L) for a project, task, or ticket, bucketed by week or month — real burden cost vs realized revenue, not assumed margins. COST = every time entry's hoursWorked × the resource's burden (Resources.internalCost), billable or not, posted or not — because paid time is a cost the moment it's worked (non-billable hours drag margin). REVENUE = totalAmount of POSTED billing items only (realized). Also reports pendingBillableHours (approved/posted lag = revenue-in-waiting) and a costCoverage flag (hours whose resource has NO burden set → cost understated; also the HR to-fix list). Give exactly one of projectID / taskId / ticketId. Read-only; for review (n8n/chat).",
    inputSchema: {
      type: 'object',
      properties: {
        projectID: { type: 'number', description: 'Report P&L for this project (rolls up its tasks’ time + project billing items)' },
        taskId: { type: 'number', description: 'Report P&L for a single task' },
        ticketId: { type: 'number', description: 'Report P&L for a single ticket' },
        bucket: { type: 'string', enum: ['week', 'month'], description: 'Time bucket (default month)' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD) — bounds time entries + billing items' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD)' }
      },
      required: []
    },
    annotations: { title: 'Project / task / ticket P&L', readOnlyHint: true }
  },

  // Invoice tools
  {
    name: 'autotask_search_invoices',
    description: 'Search for invoices in Autotask with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Filter by company ID'
        },
        invoiceNumber: {
          type: 'string',
          description: 'Filter by invoice number'
        },
        isVoided: {
          type: 'boolean',
          description: 'Filter by voided status'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_invoice_details',
    description: 'Get a single Autotask invoice with its nested line items (billing items posted to the invoice). Use for finance workflows that need to see exactly what an invoice contains.',
    inputSchema: {
      type: 'object',
      properties: {
        invoiceId: {
          type: 'number',
          description: 'The invoice ID to fetch'
        }
      },
      required: ['invoiceId']
    }
  },

  // Task tools
  {
    name: 'autotask_search_tasks',
    description: 'Search for tasks in Autotask. Returns 25 results per page by default. Use page parameter for more results.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Search term for task title'
        },
        projectID: {
          type: 'number',
          description: 'Filter by project ID'
        },
        status: {
          type: 'number',
          description: 'Filter by task status (1=New, 2=In Progress, 5=Complete)'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Filter by assigned resource ID'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_task',
    description: 'Create a new task in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Project ID for the task'
        },
        title: {
          type: 'string',
          description: 'Task title'
        },
        description: {
          type: 'string',
          description: 'Task description'
        },
        phaseID: {
          type: 'number',
          description: 'Phase to associate the task with (for phased project structure)'
        },
        status: {
          type: 'number',
          description: 'Task status ID. Resolve valid values from tenant metadata via autotask_get_field_info(Tasks) — do not assume constants.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Assigned resource ID'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role for the assigned resource'
        },
        departmentID: {
          type: 'number',
          description: 'Department ID'
        },
        billingCodeID: {
          type: 'number',
          description: 'Work type / billing code ID'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours for the task'
        },
        taskType: {
          type: 'number',
          description: 'Task type (1=FixedWork, 2=FixedDuration). Defaults to 1.'
        },
        startDateTime: {
          type: 'string',
          description: 'Task start date/time (ISO format)'
        },
        endDateTime: {
          type: 'string',
          description: 'Task end date/time (ISO format)'
        }
      },
      required: ['projectID', 'title', 'status']
    }
  },
  {
    name: 'autotask_get_task',
    description: 'Get a single project task by ID with its full fields (projectID, phaseID, status, taskType, dates, estimatedHours, assigned resource + role, department, billing code, etc.).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Task ID' } },
      required: ['id']
    },
    annotations: { title: 'Get task', readOnlyHint: true }
  },
  {
    name: 'autotask_update_task',
    description: 'Update a project task. projectID is required (task update is a child-route PATCH). Only provided fields are changed. Supports moving between phases via phaseID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID' },
        projectID: { type: 'number', description: 'Project the task belongs to (required)' },
        phaseID: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'number', description: 'Resolve via autotask_get_field_info(Tasks)' },
        assignedResourceID: { type: 'number' },
        assignedResourceRoleID: { type: 'number' },
        departmentID: { type: 'number' },
        billingCodeID: { type: 'number' },
        estimatedHours: { type: 'number' },
        startDateTime: { type: 'string' },
        endDateTime: { type: 'string' }
      },
      required: ['id', 'projectID']
    }
  },
  {
    name: 'autotask_complete_task',
    description: 'Mark a task complete. Sets the tenant\'s "Complete" status (resolved from metadata, not hard-coded) and completedDateTime. projectID is looked up from the task if not supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID' },
        projectID: { type: 'number', description: 'Optional — looked up from the task if omitted' },
        statusId: { type: 'number', description: 'Optional explicit complete-status id (overrides metadata resolution)' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_list_task_resources',
    description: 'List the secondary (additional crew) resources on a task, with their roles. The primary assignee is the task\'s assignedResourceID.',
    inputSchema: { type: 'object', properties: { taskID: { type: 'number', description: 'Task ID' } }, required: ['taskID'] },
    annotations: { title: 'List task resources', readOnlyHint: true }
  },
  {
    name: 'autotask_add_task_resource',
    description: 'Add a secondary resource (additional crew member) to a task, optionally with a role.',
    inputSchema: {
      type: 'object',
      properties: {
        taskID: { type: 'number', description: 'Task ID' },
        resourceID: { type: 'number', description: 'Resource to add' },
        roleID: { type: 'number', description: 'Optional resource role' }
      },
      required: ['taskID', 'resourceID']
    }
  },
  {
    name: 'autotask_remove_task_resource',
    description: '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a secondary resource from a task by the TaskSecondaryResources row id (from list_task_resources). Re-adding requires autotask_add_task_resource.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'TaskSecondaryResources id' } }, required: ['id'] },
    annotations: { title: 'Remove task resource', destructiveHint: true }
  },
  {
    name: 'autotask_list_task_predecessors',
    description: 'List the predecessor dependencies for a task (tasks that must precede it), with lag days.',
    inputSchema: { type: 'object', properties: { taskID: { type: 'number', description: 'Successor task ID' } }, required: ['taskID'] },
    annotations: { title: 'List task predecessors', readOnlyHint: true }
  },
  {
    name: 'autotask_add_task_predecessor',
    description: 'Add a predecessor dependency: predecessorTaskID must precede successorTaskID, with optional lag days.',
    inputSchema: {
      type: 'object',
      properties: {
        successorTaskID: { type: 'number', description: 'The task that depends on the predecessor' },
        predecessorTaskID: { type: 'number', description: 'The task that must come first' },
        lagDays: { type: 'number', description: 'Optional lag in days' }
      },
      required: ['successorTaskID', 'predecessorTaskID']
    }
  },
  {
    name: 'autotask_remove_task_predecessor',
    description: '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a task predecessor dependency by the TaskPredecessors row id (from list_task_predecessors or search_task_predecessors). Re-adding requires autotask_add_task_predecessor.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'TaskPredecessors id' } }, required: ['id'] },
    annotations: { title: 'Remove task predecessor', destructiveHint: true }
  },
  {
    name: 'autotask_get_task_predecessor',
    description: 'Get a single TaskPredecessors dependency row by its id. Returns { id, predecessorTaskID, successorTaskID, lagDays }.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'TaskPredecessors row id' } }, required: ['id'] },
    annotations: { title: 'Get task predecessor', readOnlyHint: true }
  },
  {
    name: 'autotask_search_task_predecessors',
    description: 'Search task dependency rows by either endpoint. Filter by successorTaskID (what a task waits on) and/or predecessorTaskID (what waits on a task); both may be combined. Provide at least one — an unfiltered search returns nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        successorTaskID: { type: 'number', description: 'Return rows whose successor is this task' },
        predecessorTaskID: { type: 'number', description: 'Return rows whose predecessor is this task' },
        pageSize: { type: 'number', description: 'Max rows to return (default 500)' }
      }
    },
    annotations: { title: 'Search task predecessors', readOnlyHint: true }
  },
  {
    name: 'autotask_update_task_predecessor',
    description: 'Update a task dependency. Only lagDays can be changed — Autotask marks predecessorTaskID and successorTaskID readonly, so to re-point a dependency remove this row and add a new one instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'TaskPredecessors row id' },
        lagDays: { type: 'number', description: 'New lag in days' }
      },
      required: ['id', 'lagDays']
    }
  },

  // Phase tools
  {
    name: 'autotask_list_phases',
    description: 'List phases for a project in Autotask',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Project ID to list phases for'
        },
        page: {
          type: 'number',
          description: 'Page number (1-based, default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['projectID']
    }
  },
  {
    name: 'autotask_create_phase',
    description: 'Create a new phase in an Autotask project',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Project ID for the phase'
        },
        title: {
          type: 'string',
          description: 'Phase title'
        },
        description: {
          type: 'string',
          description: 'Phase description'
        },
        startDate: {
          type: 'string',
          description: 'Phase start date (ISO format)'
        },
        dueDate: {
          type: 'string',
          description: 'Phase due date (ISO format)'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours for the phase'
        },
        parentPhaseID: {
          type: 'number',
          description: 'Parent phase ID to nest this phase under (Autotask supports nested phases)'
        },
        phaseNumber: {
          type: 'string',
          description: 'Phase number / external ordering label'
        }
      },
      required: ['projectID', 'title']
    }
  },
  {
    name: 'autotask_get_phase',
    description: 'Get a single project phase by ID with its full fields (parentPhaseID, title, description, start/due dates, estimatedHours, phaseNumber, isScheduled).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Phase ID' } },
      required: ['id']
    },
    annotations: { title: 'Get phase', readOnlyHint: true }
  },
  {
    name: 'autotask_update_phase',
    description: 'Update a project phase. Only provided fields are changed. Supports re-parenting via parentPhaseID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Phase ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        startDate: { type: 'string', description: 'ISO date' },
        dueDate: { type: 'string', description: 'ISO date' },
        estimatedHours: { type: 'number' },
        parentPhaseID: { type: 'number', description: 'Parent phase ID (nest/re-parent)' },
        phaseNumber: { type: 'string' }
      },
      required: ['id']
    }
  },

  // Picklist / Queue tools
  {
    name: 'autotask_list_queues',
    description: 'List all available ticket queues in Autotask. Use this to find queue IDs for filtering tickets by queue.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_ticket_statuses',
    description: 'List all available ticket statuses in Autotask. Use this to find status values for filtering or creating tickets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_ticket_priorities',
    description: 'List all available ticket priorities in Autotask. Use this to find priority values for filtering or creating tickets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_get_field_info',
    description: 'Get field definitions for an Autotask entity type, including picklist values. Useful for discovering valid values for any picklist field.',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          description: 'The Autotask entity type (e.g., "Tickets", "Companies", "Contacts", "Projects", "ProjectTasks", "TicketNotes"). Note: project tasks use "ProjectTasks" (or "Tasks" which auto-maps). See Autotask REST API entity names.'
        },
        fieldName: {
          type: 'string',
          description: 'Optional: filter to a specific field name'
        }
      },
      required: ['entityType']
    }
  },
  {
    name: 'autotask_resolve_picklist_value',
    description: 'Resolve a picklist label to its tenant-specific value id for any entity/field (e.g. Tasks/status/"Complete", Projects/status/"In Progress", Tickets/queueID). Use this instead of hard-coding status/type/department/role/billing-code ids. Returns matched / ambiguous / not-found (with suggestions and the full active value list).',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Autotask entity (e.g. "Tasks", "Projects", "Tickets")' },
        field: { type: 'string', description: 'Picklist field name (e.g. "status", "taskType", "departmentID")' },
        label: { type: 'string', description: 'The label to resolve (case-insensitive)' }
      },
      required: ['entity', 'field', 'label']
    },
    annotations: { title: 'Resolve picklist value', readOnlyHint: true }
  },

  {
    name: 'autotask_resolve_record_reference',
    description:
      'READ-ONLY. Resolve a canonical Autotask display reference like ' +
      '"T20260825.0006" to a single Ticket or Task. Tickets and project Tasks ' +
      'share the same T… form, so this searches BOTH and never infers the type ' +
      'from the prefix. Returns { status: "matched" | "ambiguous" | "not-found" }: ' +
      'on "matched" it includes entityType ("ticket"|"task"), id, and title; on ' +
      '"ambiguous" it lists every candidate and selects nothing. Use it before ' +
      'building UI links or performing any write keyed off a T… reference.',
    annotations: {
      title: 'Resolve canonical record reference',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description: 'The canonical display reference to resolve, e.g. "T20260825.0006".',
        },
      },
      required: ['reference'],
    }
  },
  {
    name: 'autotask_whoami',
    description:
      'READ-ONLY. Resolve the calling user to their Autotask resource — used for ' +
      'permissions and as the acting/proxy resource for data input (time entries, ' +
      'To-Dos, assignments). Resolves from the caller context (ChatGPT / Hermes-Teams ' +
      '/ Telegram email or mapped handle) or an explicit resourceId / resourceEmail / ' +
      'resourceName. Returns { status: "resolved", resource } or { status: ' +
      '"user_identification_required", reason, candidates?, message }. When ' +
      'identification is required, ask the user who they are and call again with ' +
      'resourceId / resourceEmail / resourceName.',
    annotations: { title: 'Resolve calling user to Autotask resource', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'number', description: 'Explicit Autotask resource ID to identify as' },
        resourceEmail: { type: 'string', description: 'Resolve by resource email' },
        resourceName: { type: 'string', description: 'Resolve by resource name' }
      },
      required: []
    }
  },

  // Billing Items tools (Approve and Post workflow)
  {
    name: 'autotask_search_billing_items',
    description: 'Search for billing items in Autotask. Billing items represent approved and posted billable items from the "Approve and Post" workflow. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID'
        },
        projectId: {
          type: 'number',
          description: 'Filter by project ID'
        },
        contractId: {
          type: 'number',
          description: 'Filter by contract ID'
        },
        invoiceId: {
          type: 'number',
          description: 'Filter by invoice ID'
        },
        isInvoiced: {
          type: 'boolean',
          description: 'If true, only return billing items that have been attached to an invoice (invoiceID is set). If false, only return items that have not yet been invoiced. Answers "what has and hasn\'t been invoiced yet".'
        },
        dateFrom: {
          type: 'string',
          description: 'Filter billing items with itemDate on or after this date (ISO format, e.g. 2026-01-01)'
        },
        dateTo: {
          type: 'string',
          description: 'Filter billing items with itemDate on or before this date (ISO format)'
        },
        postedAfter: {
          type: 'string',
          description: 'Filter items posted on or after this date (ISO format, e.g. 2026-01-01)'
        },
        postedBefore: {
          type: 'string',
          description: 'Filter items posted on or before this date (ISO format)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_billing_item',
    description: 'Get detailed information for a specific billing item by ID',
    inputSchema: {
      type: 'object',
      properties: {
        billingItemId: {
          type: 'number',
          description: 'The billing item ID to retrieve'
        }
      },
      required: ['billingItemId']
    }
  },

  // Billing Item Approval Levels tools
  {
    name: 'autotask_search_billing_item_approval_levels',
    description: 'Search for billing item approval levels. These describe multi-level approval records for Autotask time entries, enabling visibility into tiered approval workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        timeEntryId: {
          type: 'number',
          description: 'Filter by time entry ID'
        },
        approvalResourceId: {
          type: 'number',
          description: 'Filter by approver resource ID'
        },
        approvalLevel: {
          type: 'number',
          description: 'Filter by approval level (1, 2, 3, etc.)'
        },
        approvedAfter: {
          type: 'string',
          description: 'Filter approvals on or after this date (ISO format)'
        },
        approvedBefore: {
          type: 'string',
          description: 'Filter approvals on or before this date (ISO format)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Time Entries search tool
  {
    name: 'autotask_search_time_entries',
    description: 'Search for time entries in Autotask. Returns 25 results per page by default. Time entries can be filtered by resource, ticket, project, task, date range, or approval status. Use approvalStatus="unapproved" to find entries not yet posted. Common fan-out target — scope by date range first to avoid Autotask\'s API threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'number',
          description: 'Filter by resource (user) ID'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID'
        },
        projectId: {
          type: 'number',
          description: 'Filter by project ID'
        },
        taskId: {
          type: 'number',
          description: 'Filter by task ID'
        },
        approvalStatus: {
          type: 'string',
          enum: ['unapproved', 'approved', 'all'],
          description: 'Filter by approval status: "unapproved" = not yet posted (billingApprovalDateTime is null), "approved" = already posted, "all" = no filter (default)'
        },
        billable: {
          type: 'boolean',
          description: 'Filter by billable status (true = billable only, false = non-billable only)'
        },
        dateWorkedAfter: {
          type: 'string',
          description: 'Filter entries worked on or after this date (ISO format, e.g. 2026-01-01)'
        },
        dateWorkedBefore: {
          type: 'string',
          description: 'Filter entries worked on or before this date (ISO format)'
        },
        page: {
          type: 'number',
          
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Max 500',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // === Meta-tools for progressive discovery (lazy loading mode) ===
  {
    name: 'autotask_list_categories',
    description: 'List available tool categories. Use this to discover what types of Autotask operations are available before loading specific tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_category_tools',
    description: 'List tools in a specific category with full schemas. Use after autotask_list_categories to see available tools and their parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Category name from autotask_list_categories (e.g., "tickets", "financial", "companies")'
        }
      },
      required: ['category']
    }
  },
  {
    name: 'autotask_execute_tool',
    description: 'Execute any Autotask tool by name. Use after discovering tools via autotask_list_category_tools.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'The tool name to execute (e.g., "autotask_search_tickets")'
        },
        arguments: {
          type: 'object',
          description: 'Arguments to pass to the tool'
        }
      },
      required: ['toolName']
    }
  },
  {
    name: 'autotask_router',
    description: 'Intelligent tool router - describe what you want to do and get the right tool suggestion with pre-filled parameters. Use this when unsure which tool to call.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'Natural language description of what you want to do (e.g., "find tickets for Acme Corp", "log 2 hours on ticket 12345", "create a quote for client")'
        }
      },
      required: ['intent']
    }
  },

  // Service Call tools
  {
    name: 'autotask_get_service_call',
    description: 'Get a specific service call by ID',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'The service call ID to retrieve'
        }
      },
      required: ['serviceCallId']
    }
  },
  {
    name: 'autotask_search_service_calls',
    description: 'Search for service calls in Autotask. Filter by company, status, or date range.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company ID'
        },
        status: {
          type: 'number',
          description: 'Filter by status picklist ID (use autotask_get_field_info with entityType "ServiceCalls" to find valid values)'
        },
        startAfter: {
          type: 'string',
          description: 'Filter service calls starting on or after this date/time (ISO 8601 format)'
        },
        startBefore: {
          type: 'string',
          description: 'Filter service calls starting on or before this date/time (ISO 8601 format)'
        },
        page: {
          type: 'number',
          description: 'Page number (1-based, default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_reconcile_service_call',
    description: "Reconcile ONE service call against its linked ticket to catch billing leakage (read-only). Detects: done-not-closed (open service call, scheduled window in the past, time logged on the ticket in that window — techs recovered from ticket history if the assignment was later cleared by an owner change); no-time-logged (past-scheduled, no time in window); parts-unfulfilled (ticket charges still 'Need to Order/Fulfill', i.e. not pulled from inventory, with $ value); and unbilled-time (billable time not yet approved/posted, in hours). Give a serviceCallId, or a ticketId (uses the first service call linked to it). Returns per-flag evidence + an `issues` list.",
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: { type: 'number', description: 'Service call to reconcile' },
        ticketId: { type: 'number', description: 'Alternatively, a ticket — reconciles the first service call linked to it' }
      }
    },
    annotations: { title: 'Reconcile service call', readOnlyHint: true }
  },
  {
    name: 'autotask_report_service_call_leakage',
    description: "Weekly billing-leakage sweep (read-only): scans past-scheduled service calls in a look-back window and reconciles each, returning the ones with issues plus a digest — counts of done-not-closed / no-time-logged / parts-unfulfilled / unbilled-time, total parts $ at risk, and total unbilled hours. By default only OPEN calls are scanned (prevention — catch orphans before they close); set includeCompleted to also scan COMPLETED calls, whose ticket-level leakage (parts never pulled from inventory, billable time never approved) persists after close (recovery). Canceled calls are always excluded. Built for a scheduled run (e.g. an n8n weekly cron): bounded by maxServiceCalls so cost is predictable. Scope with lookbackDays and optional companyID.",
    inputSchema: {
      type: 'object',
      properties: {
        lookbackDays: { type: 'number', description: 'How many days back to scan service calls by scheduled start date (default 30)', minimum: 1 },
        companyID: { type: 'number', description: 'Limit the sweep to one company (omit for all)' },
        maxServiceCalls: { type: 'number', description: 'Cap on service calls examined (default 100, max 500) — keeps a scheduled run bounded', minimum: 1, maximum: 500 },
        includeCompleted: { type: 'boolean', description: 'Also scan COMPLETED service calls (closed work) for parts-unfulfilled / unbilled-time — the recovery pass (default false = open calls only). done-not-closed / no-time-logged never fire for completed calls.' },
        includeClean: { type: 'boolean', description: 'Include reconciled calls with no issues in `items` (default false — only flagged)' }
      },
      required: []
    },
    annotations: { title: 'Service-call billing leakage sweep', readOnlyHint: true }
  },
  {
    name: 'autotask_analyze_ticket_billing_gaps',
    description: "Ticket-anchored billing-completeness check for review (read-only). For one ticket, flags: work-not-logged (a tech email-reply note or a completed ticket but ZERO time entries); note-without-time (a tech reply landed as an Email Note but no time entry by that tech on the same day — the classic 'CC'd the ticket, note added, time never finished'); and billable-marked-non-billable (a non-billable time entry that looks billable — its work type is client labor / not a Non-Billable code, and/or the contract is Time & Materials, and/or the ticket also has billable time). Returns per-entry evidence + which signals fired, for a human to decide. Use autotask_report_ticket_billing_gaps to sweep many tickets.",
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'number', description: 'Ticket to analyze' } },
      required: ['ticketId']
    },
    annotations: { title: 'Ticket billing gaps', readOnlyHint: true }
  },
  {
    name: 'autotask_report_ticket_billing_gaps',
    description: "Weekly ticket billing-gaps sweep for review (read-only). Scans tickets active in a look-back window — OPEN and (default on) COMPLETED, so 'all tickets' are covered — and returns the ones with gaps plus a digest: counts of work-not-logged / note-without-time / billable-marked-non-billable, total suspect non-billable hours, and total uncaptured notes. This is a REVIEW report — no changes are made; you decide. Built for a scheduled run (n8n weekly cron); bounded by maxTickets. Scope with lookbackDays and optional companyID.",
    inputSchema: {
      type: 'object',
      properties: {
        lookbackDays: { type: 'number', description: 'Scan tickets with activity in the last N days (default 14)', minimum: 1 },
        companyID: { type: 'number', description: 'Limit to one company (omit for all)' },
        maxTickets: { type: 'number', description: 'Cap on tickets examined (default 100, max 500) — keeps a scheduled run bounded', minimum: 1, maximum: 500 },
        includeCompleted: { type: 'boolean', description: 'Also scan COMPLETED tickets (default true — "all tickets"). Set false for open-only.' },
        includeClean: { type: 'boolean', description: 'Include tickets with no gaps in `items` (default false — only flagged)' }
      },
      required: []
    },
    annotations: { title: 'Ticket billing-gaps sweep', readOnlyHint: true }
  },
  {
    name: 'autotask_create_service_call',
    description: 'Create a new service call in Autotask. Service calls are used to schedule and plan work on tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Description of the service call'
        },
        status: {
          type: 'number',
          description: 'Status picklist ID (use autotask_get_field_info with entityType "ServiceCalls" to find valid values)'
        },
        startDateTime: {
          type: 'string',
          description: 'Scheduled start date/time (ISO 8601 format, e.g. 2026-03-22T09:00:00Z)'
        },
        endDateTime: {
          type: 'string',
          description: 'Scheduled end date/time (ISO 8601 format)'
        },
        companyID: {
          type: 'number',
          description: 'Company ID this service call is for'
        },
        companyLocationID: {
          type: 'number',
          description: 'Company location ID (optional)'
        },
        complete: {
          type: 'boolean',
          description: 'Whether this service call is complete (default: false)'
        }
      },
      required: ['description', 'startDateTime', 'endDateTime']
    }
  },
  {
    name: 'autotask_update_service_call',
    description: 'Update an existing service call. Use this to change status, times, or description. To complete/close a service call, set complete: true or update the status.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'The service call ID to update'
        },
        description: {
          type: 'string',
          description: 'Updated description'
        },
        status: {
          type: 'number',
          description: 'Updated status picklist ID'
        },
        startDateTime: {
          type: 'string',
          description: 'Updated start date/time (ISO 8601 format)'
        },
        endDateTime: {
          type: 'string',
          description: 'Updated end date/time (ISO 8601 format)'
        },
        complete: {
          type: 'boolean',
          description: 'Set to true to mark the service call as complete/closed'
        }
      },
      required: ['serviceCallId']
    }
  },
  {
    name: 'autotask_delete_service_call',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a service call ' +
      'and all associated data. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'The service call ID to delete'
        }
      },
      required: ['serviceCallId']
    }
  },

  // ServiceCallTicket tools
  {
    name: 'autotask_search_service_call_tickets',
    description: 'Search for ticket associations on service calls. Use this to find which tickets are linked to a service call, or which service calls contain a specific ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: {
          type: 'number',
          description: 'Filter by service call ID'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket ID'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_ticket',
    description: 'Link a ticket to a service call. This associates the ticket with the service call for scheduling purposes.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallID: {
          type: 'number',
          description: 'The service call ID to link the ticket to'
        },
        ticketID: {
          type: 'number',
          description: 'The ticket ID to link to the service call'
        }
      },
      required: ['serviceCallID', 'ticketID']
    }
  },
  {
    name: 'autotask_delete_service_call_ticket',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a ticket ' +
      'association from a service call. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call ticket association (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketId: {
          type: 'number',
          description: 'The service call ticket record ID to delete'
        }
      },
      required: ['serviceCallTicketId']
    }
  },

  // ServiceCallTicketResource tools
  {
    name: 'autotask_search_service_call_ticket_resources',
    description: 'Search for resource (technician) assignments on service call tickets.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketId: {
          type: 'number',
          description: 'Filter by service call ticket ID'
        },
        resourceId: {
          type: 'number',
          description: 'Filter by resource (technician) ID'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_ticket_resource',
    description: 'Assign a resource (technician) to a service call ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketID: {
          type: 'number',
          description: 'The service call ticket ID to assign the resource to'
        },
        resourceID: {
          type: 'number',
          description: 'The resource (technician) ID to assign'
        },
        roleID: {
          type: 'number',
          description: 'The role ID for the resource on this service call (optional)'
        }
      },
      required: ['serviceCallTicketID', 'resourceID']
    }
  },
  {
    name: 'autotask_delete_service_call_ticket_resource',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a resource ' +
      'assignment from a service call ticket. This action cannot be undone. ' +
      'Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call ticket resource assignment (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTicketResourceId: {
          type: 'number',
          description: 'The service call ticket resource record ID to delete'
        }
      },
      required: ['serviceCallTicketResourceId']
    }
  },

  // ServiceCallTask tools — attach a service call to a PROJECT TASK so scheduled
  // work (e.g. a recurring meeting task) carries its resources onto the calendar.
  {
    name: 'autotask_search_service_call_tasks',
    description: 'Search service-call ↔ project-task associations. Use to find which service call schedules a task, or which task a service call is for.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallId: { type: 'number', description: 'Filter by service call ID' },
        taskId: { type: 'number', description: 'Filter by project task ID' },
        pageSize: { type: 'number', description: 'Number of results to return (default: 25)', minimum: 1, maximum: 100 }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_task',
    description: 'Link a PROJECT TASK to a service call — the task equivalent of autotask_create_service_call_ticket. This schedules the task on the Autotask dispatch calendar so its assigned resources (added via autotask_create_service_call_task_resource) appear there. Lets scheduled project work (e.g. a recurring meeting task) go on the calendar directly, without a placeholder scheduling ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallID: { type: 'number', description: 'The service call ID to link the task to' },
        taskID: { type: 'number', description: 'The project task ID to link to the service call' }
      },
      required: ['serviceCallID', 'taskID']
    }
  },
  {
    name: 'autotask_delete_service_call_task',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a task association from a ' +
      'service call. This action cannot be undone. Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call task association (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskId: { type: 'number', description: 'The service call task record ID to delete' }
      },
      required: ['serviceCallTaskId']
    }
  },
  {
    name: 'autotask_search_service_call_task_resources',
    description: 'Search for resource (technician/attendee) assignments on service-call tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskId: { type: 'number', description: 'Filter by service call task ID' },
        resourceId: { type: 'number', description: 'Filter by resource ID' },
        pageSize: { type: 'number', description: 'Number of results to return (default: 25)', minimum: 1, maximum: 100 }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_service_call_task_resource',
    description: 'Assign a resource (technician/attendee) to a service-call task — the task equivalent of autotask_create_service_call_ticket_resource. Repeat to put multiple resources (e.g. all four meeting attendees) on the calendar for the scheduled task.',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskID: { type: 'number', description: 'The service call task ID to assign the resource to' },
        resourceID: { type: 'number', description: 'The resource ID to assign' },
        roleID: { type: 'number', description: 'The role ID for the resource on this service call (optional)' }
      },
      required: ['serviceCallTaskID', 'resourceID']
    }
  },
  {
    name: 'autotask_delete_service_call_task_resource',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently removes a resource assignment from a ' +
      'service call task. This action cannot be undone. Confirm with the user before invoking.',
    annotations: {
      title: 'Delete service call task resource assignment (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        serviceCallTaskResourceId: { type: 'number', description: 'The service call task resource record ID to delete' }
      },
      required: ['serviceCallTaskResourceId']
    }
  },

  // Company To-Dos (CRM calendar follow-ups) — brief §4.1
  {
    name: 'autotask_get_company_todo',
    description:
      'READ-ONLY. Get a Company To-Do (CRM calendar follow-up) by ID. A Company ' +
      'To-Do is NOT a ticket checklist item, project task, time entry, ' +
      'appointment, or service call. `completedDate == null` means it is still open.',
    annotations: { title: 'Get Company To-Do', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The CompanyToDo ID' } },
      required: ['id']
    }
  },
  {
    name: 'autotask_search_company_todos',
    description:
      'READ-ONLY. Search Company To-Dos (CRM calendar follow-ups). Set openOnly ' +
      'to return only incomplete To-Dos (completedDate is null).',
    annotations: { title: 'Search Company To-Dos', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Filter by company' },
        assignedToResourceID: { type: 'number', description: 'Filter by assigned resource' },
        ticketID: { type: 'number', description: 'Filter by associated ticket' },
        contactID: { type: 'number', description: 'Filter by associated contact' },
        opportunityID: { type: 'number', description: 'Filter by associated opportunity' },
        contractID: { type: 'number', description: 'Filter by associated contract' },
        openOnly: { type: 'boolean', description: 'When true, return only To-Dos with no completedDate (open)' },
        pageSize: { type: 'number', description: 'Results per page (default 25, max 200)', minimum: 1, maximum: 200 }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_company_todo',
    description:
      'Create a Company To-Do (CRM calendar follow-up) via the company child ' +
      'route. Provide exactly one of actionType (numeric) or actionTypeName ' +
      '(e.g. "Sales", "Phone Call", "Meeting", resolved case-insensitively from ' +
      'live metadata); if neither is given it defaults to General. All ' +
      'associated contact/contract/opportunity/ticket records must belong to the ' +
      'same company.',
    annotations: { title: 'Create Company To-Do', readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        companyID: { type: 'number', description: 'Owning company (required)' },
        assignedToResourceID: { type: 'number', description: 'Resource the To-Do is assigned to. Provide this, or set currentUser to assign it to the calling user.' },
        currentUser: { type: 'boolean', description: 'Assign the To-Do to the calling user (resolves the caller to their Autotask resource). Alternative to assignedToResourceID.' },
        actionType: { type: 'number', description: 'Numeric action type ID. Provide this OR actionTypeName, not both.' },
        actionTypeName: { type: 'string', description: 'Action type label resolved from metadata (e.g. "Sales"). Provide this OR actionType.' },
        activityDescription: { type: 'string', description: 'Free-text description' },
        startDateTime: { type: 'string', description: 'Start (ISO 8601, required)' },
        endDateTime: { type: 'string', description: 'End (ISO 8601, required)' },
        contactID: { type: 'number', description: 'Associated contact (same company)' },
        contractID: { type: 'number', description: 'Associated contract (same company)' },
        opportunityID: { type: 'number', description: 'Associated opportunity (same company)' },
        ticketID: { type: 'number', description: 'Associated ticket (same company)' }
      },
      required: ['companyID', 'startDateTime', 'endDateTime']
    }
  },
  {
    name: 'autotask_update_company_todo',
    description:
      'Update a Company To-Do via the company child route. companyID is resolved ' +
      'from the record if not supplied. Use actionTypeName to change the action ' +
      'type by label. To mark a To-Do complete, prefer autotask_complete_company_todo.',
    annotations: { title: 'Update Company To-Do', readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The CompanyToDo ID (required)' },
        companyID: { type: 'number', description: 'Owning company (optional; resolved from the record if omitted)' },
        actionType: { type: 'number', description: 'Numeric action type ID' },
        actionTypeName: { type: 'string', description: 'Action type label resolved from metadata' },
        activityDescription: { type: 'string', description: 'Free-text description' },
        startDateTime: { type: 'string', description: 'Start (ISO 8601)' },
        endDateTime: { type: 'string', description: 'End (ISO 8601)' },
        contactID: { type: 'number', description: 'Associated contact' },
        contractID: { type: 'number', description: 'Associated contract' },
        opportunityID: { type: 'number', description: 'Associated opportunity' },
        ticketID: { type: 'number', description: 'Associated ticket' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_complete_company_todo',
    description:
      'Complete a Company To-Do by setting its completedDate to now (there is no ' +
      'isComplete field). companyID is resolved from the record if not supplied. ' +
      'After this, open-only searches exclude the To-Do.',
    annotations: { title: 'Complete Company To-Do', readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The CompanyToDo ID (required)' },
        companyID: { type: 'number', description: 'Owning company (optional; resolved from the record if omitted)' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_delete_company_todo',
    description:
      '⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a Company To-Do. This ' +
      'cannot be undone. Confirm with the user before invoking. companyID is ' +
      'resolved from the record if not supplied.',
    annotations: {
      title: 'Delete Company To-Do (irreversible)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The CompanyToDo ID to delete (required)' },
        companyID: { type: 'number', description: 'Owning company (optional; resolved from the record if omitted)' }
      },
      required: ['id']
    }
  },

  // Contracts (write) and ContractServices CRUD
  {
    name: 'autotask_create_contract',
    description: 'Create a new Contract in Autotask. Field names match the Autotask REST API exactly. status: 1=In Effect, 0=Inactive. Dates are ISO format (YYYY-MM-DD).',
    inputSchema: {
      type: 'object',
      properties: CONTRACT_SHELL_PROPERTIES,
      required: CONTRACT_SHELL_REQUIRED
    }
  },
  {
    name: 'autotask_create_contracts_bulk',
    description: 'Create multiple contract shells (header records, no service lines) in one call — e.g. onboarding a customer with several location-based contracts. Shells are created one at a time; a failure on one shell does not stop the rest, and each item reports its own success or error.',
    inputSchema: {
      type: 'object',
      properties: {
        contracts: {
          type: 'array',
          description: 'Contract shells to create, in order. Same fields as autotask_create_contract.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: CONTRACT_SHELL_PROPERTIES,
            required: CONTRACT_SHELL_REQUIRED
          }
        }
      },
      required: ['contracts']
    }
  },
  {
    name: 'autotask_update_contract',
    description: 'Update an existing Contract in Autotask (PATCH). Pass only fields you want to change; everything except id is optional. status: 1=In Effect, 0=Inactive.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Contract ID to update' },
        companyID: { type: 'number', description: 'Company ID' },
        contractName: { type: 'string', description: 'Contract name' },
        contractType: { type: 'number', description: 'Contract type picklist ID' },
        contractCategory: { type: 'number', description: 'Contract category picklist ID' },
        startDate: { type: 'string', description: 'Contract start date (ISO YYYY-MM-DD)' },
        endDate: { type: 'string', description: 'Contract end date (ISO YYYY-MM-DD)' },
        contactID: { type: 'number', description: 'Primary contact ID' },
        contractNumber: { type: 'string', description: 'External-facing contract number' },
        contractPeriodType: { type: 'number', description: 'Period type picklist ID' },
        description: { type: 'string', description: 'Contract description / notes' },
        estimatedCost: { type: 'number', description: 'Estimated cost' },
        estimatedHours: { type: 'number', description: 'Estimated hours' },
        estimatedRevenue: { type: 'number', description: 'Estimated revenue' },
        setupFee: { type: 'number', description: 'Setup fee amount' },
        overageBillingRate: { type: 'number', description: 'Overage billing rate' },
        serviceLevelAgreementID: { type: 'number', description: 'SLA ID' },
        purchaseOrderNumber: { type: 'string', description: 'Customer purchase order number' },
        opportunityID: { type: 'number', description: 'Originating opportunity ID' },
        billingPreference: { type: 'number', description: 'Billing preference picklist ID' },
        billToCompanyID: { type: 'number', description: 'Bill-to company ID' },
        billToCompanyContactID: { type: 'number', description: 'Bill-to contact ID' },
        exclusionContractID: { type: 'number', description: 'Exclusion contract ID' },
        isDefaultContract: { type: 'boolean', description: 'Whether this is the default contract for the company' },
        internalCurrencySetupFee: { type: 'number', description: 'Setup fee in internal currency' },
        internalCurrencyOverageBillingRate: { type: 'number', description: 'Overage rate in internal currency' },
        organizationalLevelAssociationID: { type: 'number', description: 'Org level association ID' },
        contractExclusionSetID: { type: 'number', description: 'Contract exclusion set ID' },
        renewedContractID: { type: 'number', description: 'ID of the contract this renewed' },
        setupFeeBillingCodeID: { type: 'number', description: 'Billing code ID for the setup fee' },
        status: { type: 'number', description: 'Contract status (1=In Effect, 0=Inactive)' },
        timeReportingRequiresStartAndStopTimes: { type: 'number', description: 'Whether time entries require start/stop times' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_create_contract_service',
    description: 'Add a ContractService (service line item) to an existing Contract.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Parent Contract ID' },
        serviceID: { type: 'number', description: 'Service catalog ID being attached to the contract' },
        unitPrice: { type: 'number', description: 'Unit price for the service line' },
        unitCost: { type: 'number', description: 'Unit cost for the service line' },
        quoteItemID: { type: 'number', description: 'Originating quote item ID, if any' },
        internalCurrencyUnitPrice: { type: 'number', description: 'Unit price in internal currency' },
        adjustedPrice: { type: 'number', description: 'Adjusted price' },
        invoiceDescription: { type: 'string', description: 'Override invoice description for this line' }
      },
      required: ['contractID', 'serviceID', 'unitPrice']
    }
  },
  {
    name: 'autotask_update_contract_service',
    description: 'Update an existing ContractService line on a Contract. Pass only fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ContractService record ID to update' },
        contractID: { type: 'number', description: 'Parent Contract ID' },
        serviceID: { type: 'number', description: 'Service catalog ID' },
        unitPrice: { type: 'number', description: 'Unit price for the service line' },
        unitCost: { type: 'number', description: 'Unit cost for the service line' },
        quoteItemID: { type: 'number', description: 'Originating quote item ID' },
        internalCurrencyUnitPrice: { type: 'number', description: 'Unit price in internal currency' },
        adjustedPrice: { type: 'number', description: 'Adjusted price' },
        invoiceDescription: { type: 'string', description: 'Override invoice description for this line' }
      },
      required: ['id', 'contractID']
    }
  },
  {
    name: 'autotask_get_contract_service',
    description: 'Get a single ContractService line by ID — the service entitlement on a contract (contractID, serviceID, quoteItemID, unitPrice, unitCost, internalDescription, invoiceDescription). Used to confirm a configuration item is still entitled through an active contract service.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'ContractService record ID' } },
      required: ['id']
    },
    annotations: { title: 'Get contract service', readOnlyHint: true }
  },
  {
    name: 'autotask_search_contract_services',
    description: 'Search ContractService lines (service entitlements on contracts). Filter by contractID (all service lines on a contract), serviceID, and/or quoteItemID. Answers "which services does this contract cover?" and "is this service entitled on any contract?". With no filter, returns the first page of contract services.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Return service lines on this contract' },
        serviceID: { type: 'number', description: 'Return service lines for this service' },
        quoteItemID: { type: 'number', description: 'Return the service line originating from this quote item' },
        pageSize: { type: 'number', description: 'Max rows to return (default 25, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Search contract services', readOnlyHint: true }
  },
  {
    name: 'autotask_get_contract_billed_units',
    description: 'Billed units per contract service line (read-only). Returns the actual per-period ContractServiceUnits rows (and, unless excluded, ContractServiceBundleUnits) for a contract: units, price (the prorated amount billed for that period — partial first/last months are prorated), cost, and the period start/end. Service/bundle names are attached. Scope to a whole contract (contractID), a single line (contractServiceID), and/or a start-date window (startAfter/startBefore). Use this for "what was actually billed on this contract per month?"; for a summarized monthly/annual recurring total use autotask_report_contract_recurring_revenue.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Return billed-unit rows for this contract' },
        contractServiceID: { type: 'number', description: 'Return billed-unit rows for a single ContractService line (bundle units are omitted when set)' },
        startAfter: { type: 'string', description: 'Only periods starting on/after this date (YYYY-MM-DD)' },
        startBefore: { type: 'string', description: 'Only periods starting on/before this date (YYYY-MM-DD)' },
        includeBundles: { type: 'boolean', description: 'Include ContractServiceBundleUnits (default true; ignored when contractServiceID is set)' },
        pageSize: { type: 'number', description: 'Max rows per entity (default 100, max 500)', minimum: 1, maximum: 500 }
      }
    },
    annotations: { title: 'Contract billed units', readOnlyHint: true }
  },
  {
    name: 'autotask_report_contract_recurring_revenue',
    description: "Recurring-revenue roll-up for a contract (read-only): monthly (MRR) and annual (ARR) recurring revenue from its recurring service + bundle lines as of a date. Per line, monthly = current units × rate (adjustedPrice, else unitPrice); the prorated per-period billed amount is reported per line but is NOT what MRR sums, so partial first/last months don't distort the steady-state figure. Lines with no allocation covering the date are listed as inactive and excluded from MRR. Use asOfDate to value the contract at a point in time (default today).",
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Contract to roll up' },
        asOfDate: { type: 'string', description: 'Value recurring lines active on this date (YYYY-MM-DD; default today)' }
      },
      required: ['contractID']
    },
    annotations: { title: 'Contract recurring revenue (MRR/ARR)', readOnlyHint: true }
  },
  {
    name: 'autotask_get_contract_milestone',
    description: 'Get a single ContractMilestone by id — a commercial milestone payment on a contract (title, amount, dateDue, status, description, billingCodeID, isInitialPayment).',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'ContractMilestone id' } }, required: ['id'] },
    annotations: { title: 'Get contract milestone', readOnlyHint: true }
  },
  {
    name: 'autotask_search_contract_milestones',
    description: 'Search contract milestones, primarily by contractID (all milestones on a contract). Optionally narrow by status. Provide at least one filter — an unfiltered search returns nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Return milestones on this contract' },
        status: { type: 'number', description: 'Optional status picklist id to filter by (tenant-specific — see autotask_get_field_info entityType "ContractMilestones" fieldName "status")' },
        pageSize: { type: 'number', description: 'Max rows to return (default 500)' }
      }
    },
    annotations: { title: 'Search contract milestones', readOnlyHint: true }
  },
  {
    name: 'autotask_create_contract_milestone',
    description: 'Create a ContractMilestone on a contract. contractID is required and immutable after create. status is a tenant-specific picklist — resolve the id with autotask_get_field_info (entityType "ContractMilestones", fieldName "status") or autotask_resolve_picklist_value.',
    inputSchema: {
      type: 'object',
      properties: {
        contractID: { type: 'number', description: 'Parent Contract ID (immutable after create)' },
        title: { type: 'string', description: 'Milestone title' },
        amount: { type: 'number', description: 'Milestone amount' },
        dateDue: { type: 'string', description: 'Due date (ISO 8601, e.g. 2026-09-18)' },
        status: { type: 'number', description: 'Status picklist id (tenant-specific)' },
        isInitialPayment: { type: 'boolean', description: 'Whether this is the initial payment' },
        description: { type: 'string', description: 'Optional description' },
        billingCodeID: { type: 'number', description: 'Optional billing/labor code id' }
      },
      required: ['contractID', 'title', 'amount', 'dateDue', 'status', 'isInitialPayment']
    }
  },
  {
    name: 'autotask_update_contract_milestone',
    description: 'Update a ContractMilestone. Pass only fields to change. contractID is readonly and ignored if sent. (Autotask does not support deleting milestones — set status or amount instead.)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ContractMilestone id to update' },
        title: { type: 'string', description: 'Milestone title' },
        amount: { type: 'number', description: 'Milestone amount' },
        dateDue: { type: 'string', description: 'Due date (ISO 8601)' },
        status: { type: 'number', description: 'Status picklist id (tenant-specific)' },
        isInitialPayment: { type: 'boolean', description: 'Whether this is the initial payment' },
        description: { type: 'string', description: 'Description' },
        billingCodeID: { type: 'number', description: 'Billing/labor code id' }
      },
      required: ['id']
    }
  },
  {
    name: 'autotask_raw_request',
    description: 'Escape hatch for Autotask REST endpoints not yet wrapped by a typed tool. Use sparingly — typed tools are preferred for safety. The existing Content-Type, Accept, ApiIntegrationcode, UserName, Secret headers are added automatically. The path is resolved against the zone-resolved base URL (https://webservices<N>.autotask.net/ATServicesRest/v1.0). Pass queryParams as a flat object of string/number/boolean values; they will be URL-encoded and appended to the path.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
          description: 'HTTP method'
        },
        path: {
          type: 'string',
          description: 'Path under the Autotask REST v1.0 base (e.g. "/Companies/175" or "/Companies/query")'
        },
        body: {
          type: 'object',
          description: 'Optional JSON body for POST/PATCH requests',
          additionalProperties: true
        },
        queryParams: {
          type: 'object',
          description: 'Optional flat key-value query parameters (e.g. { includeFields: "id,name" })',
          additionalProperties: true
        }
      },
      required: ['method', 'path']
    }
  },
  // Webhook management (#23 §16) — read/discovery layer
  {
    name: 'autotask_list_webhook_entities',
    description: "Prerequisite/discovery for webhook management (read-only, no I/O): lists the Autotask entities that support outbound webhooks (tickets, companies, contacts, configurationItems, ticketNotes) and the REST entity names behind each — the parent `<Entity>Webhooks` record and its child collections for monitored fields, UDF fields, and EXCLUDED RESOURCES. The excluded-resources child is the loop-prevention hook: exclude the MCP integration user's resourceID so the MCP's own writes don't trigger the webhook back into itself. Call this first to know which `entity` values the other webhook tools accept.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { title: 'List webhook-capable entities', readOnlyHint: true }
  },
  {
    name: 'autotask_search_webhooks',
    description: "List existing webhooks configured on a webhook-capable entity (read-only). Pass `entity` (tickets / companies / contacts / configurationItems / ticketNotes — see autotask_list_webhook_entities). Returns the parent webhook records (name, URL, active flag, event subscriptions). Use activeOnly to see only enabled ones.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key (tickets/companies/contacts/configurationItems/ticketNotes)' },
        activeOnly: { type: 'boolean', description: 'Only active webhooks' },
        pageSize: { type: 'number', description: 'Max webhooks to return (default 100, max 500)', minimum: 1, maximum: 500 }
      },
      required: ['entity']
    },
    annotations: { title: 'Search webhooks', readOnlyHint: true }
  },
  {
    name: 'autotask_get_webhook',
    description: "Get one webhook with its full configuration (read-only): the parent record plus its monitored standard fields, UDF fields, and EXCLUDED RESOURCES (the resources whose changes don't fire it — the loop-prevention list). Pass `entity` and the webhook `id`.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key (see autotask_list_webhook_entities)' },
        id: { type: 'number', description: 'Webhook id' }
      },
      required: ['entity', 'id']
    },
    annotations: { title: 'Get webhook', readOnlyHint: true }
  },
  {
    name: 'autotask_create_webhook',
    description: "Create an outbound webhook on a webhook-capable entity (STANDING CONFIGURATION). SAFE BY DEFAULT: unless you pass dryRun:false, NOTHING is written — it returns the planned webhook, fields, and excluded resources. Creates the parent webhook then its monitored `fields` and `excludedResourceIDs`. IMPORTANT (loop prevention): put the MCP integration user's resourceID in `excludedResourceIDs` so the MCP's own writes don't re-trigger the webhook. Autotask REQUIRES name, https webhookUrl, https deactivationUrl (called if the webhook auto-deactivates), secretKey (signs the payload), and at least one event subscription. Returns the write-plan envelope (status: dry_run | validation_failed | created | created_with_errors).",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key (see autotask_list_webhook_entities)' },
        name: { type: 'string', description: 'Webhook name' },
        webhookUrl: { type: 'string', description: 'The https:// callback URL (e.g. an n8n webhook node)' },
        deactivationUrl: { type: 'string', description: 'REQUIRED https:// URL Autotask calls if it auto-deactivates the webhook' },
        secretKey: { type: 'string', description: 'REQUIRED secret used to sign (HMAC) the webhook payload' },
        isActive: { type: 'boolean', description: 'Active on create (default true)' },
        subscribeCreate: { type: 'boolean', description: 'Fire on record create' },
        subscribeUpdate: { type: 'boolean', description: 'Fire on record update' },
        subscribeDelete: { type: 'boolean', description: 'Fire on record delete' },
        sendThresholdExceededNotification: { type: 'boolean', description: 'Default false' },
        notificationEmailAddress: { type: 'string' },
        fields: {
          type: 'array', description: 'Standard fields to monitor. Each: { fieldID, isSubscribedField?, isDisplayAlwaysField? } (isSubscribedField default true).',
          items: { type: 'object', properties: { fieldID: { type: 'number' }, isSubscribedField: { type: 'boolean' }, isDisplayAlwaysField: { type: 'boolean' } }, required: ['fieldID'] }
        },
        excludedResourceIDs: { type: 'array', items: { type: 'number' }, description: 'Resource ids whose changes do NOT fire the webhook — include the MCP integration user to avoid loops' },
        dryRun: { type: 'boolean', description: 'Default true — plan only, no writes. Pass false to create.' }
      },
      required: ['entity', 'name', 'webhookUrl', 'deactivationUrl', 'secretKey']
    },
    annotations: { title: 'Create webhook' }
  },
  {
    name: 'autotask_update_webhook',
    description: "Update a webhook's parent settings — activate/deactivate (isActive), change webhookUrl, toggle event subscriptions, notifications, owner, or secret (STANDING CONFIGURATION). SAFE BY DEFAULT (dryRun:true) — returns the planned patch and writes nothing until dryRun:false. Manage monitored fields / excluded resources with their own tools. Returns the write-plan envelope.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key' },
        id: { type: 'number', description: 'Webhook id' },
        name: { type: 'string' },
        webhookUrl: { type: 'string', description: 'New https:// callback URL' },
        deactivationUrl: { type: 'string', description: 'New https:// auto-deactivation URL' },
        isActive: { type: 'boolean', description: 'Enable/disable the webhook' },
        subscribeCreate: { type: 'boolean' },
        subscribeUpdate: { type: 'boolean' },
        subscribeDelete: { type: 'boolean' },
        sendThresholdExceededNotification: { type: 'boolean' },
        notificationEmailAddress: { type: 'string' },
        secretKey: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Default true — plan only. Pass false to apply.' }
      },
      required: ['entity', 'id']
    },
    annotations: { title: 'Update webhook' }
  },
  {
    name: 'autotask_delete_webhook',
    description: "⚠ DESTRUCTIVE: Permanently delete a webhook (STANDING CONFIGURATION — cannot be undone). Requires confirm:true. The callback stops firing immediately for everyone. Prefer autotask_update_webhook with isActive:false to disable without deleting.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key' },
        id: { type: 'number', description: 'Webhook id to delete' }
      },
      required: ['entity', 'id']
    },
    annotations: { title: 'Delete webhook', destructiveHint: true }
  },
  {
    name: 'autotask_set_webhook_excluded_resources',
    description: "Manage a webhook's excluded resources — the loop-prevention list (resources whose changes do NOT fire the webhook). mode: 'add' (create missing), 'remove' (delete matching), or 'replace' (make the set exactly match resourceIDs). SAFE BY DEFAULT (dryRun:true) — returns what would change and writes nothing until dryRun:false. Use this to exclude the MCP integration user so its own writes don't re-trigger the webhook.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Webhook-capable entity key' },
        webhookID: { type: 'number', description: 'The webhook to modify' },
        resourceIDs: { type: 'array', items: { type: 'number' }, description: 'Resource ids to add/remove (or the exact set for replace)' },
        mode: { type: 'string', enum: ['add', 'remove', 'replace'], description: 'Default add' },
        dryRun: { type: 'boolean', description: 'Default true — plan only. Pass false to apply.' }
      },
      required: ['entity', 'webhookID', 'resourceIDs']
    },
    annotations: { title: 'Set webhook excluded resources' }
  }
];

export const TOOL_CATEGORIES: Record<string, { description: string; tools: string[] }> = {
  utility: {
    description: 'Connection testing and field/picklist discovery',
    tools: ['autotask_test_connection', 'autotask_list_queues', 'autotask_list_ticket_statuses', 'autotask_list_ticket_priorities', 'autotask_get_field_info', 'autotask_resolve_picklist_value', 'autotask_resolve_record_reference', 'autotask_whoami']
  },
  companies: {
    description: 'Search, create, and update companies',
    tools: ['autotask_search_companies', 'autotask_create_company', 'autotask_update_company', 'autotask_get_company_site_configuration', 'autotask_update_company_site_configuration']
  },
  contacts: {
    description: 'Search and create contacts',
    tools: ['autotask_search_contacts', 'autotask_create_contact', 'autotask_update_contact', 'autotask_find_or_create_contact']
  },
  tickets: {
    description: 'Search, create, update tickets and manage ticket notes, attachments, charges, and audit history',
    tools: ['autotask_search_tickets', 'autotask_get_ticket_details', 'autotask_create_ticket', 'autotask_update_ticket', 'autotask_move_ticket_to_company', 'autotask_find_ticket_by_external_id', 'autotask_search_ticket_configuration_items', 'autotask_add_ticket_configuration_item', 'autotask_remove_ticket_configuration_item', 'autotask_get_ticket_note', 'autotask_search_ticket_notes', 'autotask_create_ticket_note', 'autotask_get_ticket_attachment', 'autotask_search_ticket_attachments', 'autotask_create_ticket_attachment', 'autotask_get_ticket_charge', 'autotask_search_ticket_charges', 'autotask_create_ticket_charge', 'autotask_update_ticket_charge', 'autotask_delete_ticket_charge', 'autotask_get_ticket_history', 'autotask_search_ticket_history', 'autotask_report_ticket_throughput', 'autotask_report_request_segmentation', 'autotask_search_checklist_libraries', 'autotask_get_checklist_library', 'autotask_apply_checklist_library_to_ticket', 'autotask_create_maintenance_ticket', 'autotask_search_ticket_checklist_items', 'autotask_create_ticket_checklist_item', 'autotask_update_ticket_checklist_item', 'autotask_delete_ticket_checklist_item']
  },
  projects: {
    description: 'Search and create projects, tasks, phases, and project notes',
    tools: ['autotask_search_projects', 'autotask_get_project', 'autotask_update_project', 'autotask_get_project_structure', 'autotask_get_complete_project_context', 'autotask_get_project_labor_summary', 'autotask_export_project_blueprint', 'autotask_calculate_project_schedule', 'autotask_extract_project_scope', 'autotask_classify_project', 'autotask_calculate_bom_labor', 'autotask_generate_project_labor_plan', 'autotask_build_project_from_plan', 'autotask_extend_project', 'autotask_create_project', 'autotask_link_project_commercial', 'autotask_search_tasks', 'autotask_get_task', 'autotask_create_task', 'autotask_update_task', 'autotask_complete_task', 'autotask_list_task_resources', 'autotask_add_task_resource', 'autotask_remove_task_resource', 'autotask_list_task_predecessors', 'autotask_add_task_predecessor', 'autotask_remove_task_predecessor', 'autotask_get_task_predecessor', 'autotask_search_task_predecessors', 'autotask_update_task_predecessor', 'autotask_list_phases', 'autotask_create_phase', 'autotask_get_phase', 'autotask_update_phase', 'autotask_get_project_note', 'autotask_search_project_notes', 'autotask_create_project_note', 'autotask_get_task_note', 'autotask_search_task_notes', 'autotask_create_task_note', 'autotask_search_project_attachments', 'autotask_search_task_attachments', 'autotask_get_project_attachment', 'autotask_create_project_attachment', 'autotask_get_task_attachment', 'autotask_create_task_attachment']
  },
  time_and_billing: {
    description: 'Time entries, billing items, and expense management',
    tools: ['autotask_create_time_entry', 'autotask_log_my_time', 'autotask_get_my_day', 'autotask_search_time_entries', 'autotask_get_time_entry', 'autotask_update_time_entry', 'autotask_search_billing_items', 'autotask_get_billing_item', 'autotask_search_billing_item_approval_levels', 'autotask_report_time_entry_compliance', 'autotask_get_expense_report', 'autotask_search_expense_reports', 'autotask_create_expense_report', 'autotask_create_expense_item']
  },
  financial: {
    description: 'Quotes, quote items, opportunities, invoices, and contracts',
    tools: ['autotask_get_quote', 'autotask_search_quotes', 'autotask_create_quote', 'autotask_get_quote_item', 'autotask_search_quote_items', 'autotask_create_quote_item', 'autotask_update_quote_item', 'autotask_delete_quote_item', 'autotask_get_opportunity', 'autotask_search_opportunities', 'autotask_create_opportunity', 'autotask_update_opportunity', 'autotask_search_invoices', 'autotask_get_invoice_details', 'autotask_search_contracts', 'autotask_get_contract', 'autotask_list_expiring_contracts', 'autotask_create_contract', 'autotask_create_contracts_bulk', 'autotask_update_contract', 'autotask_create_contract_service', 'autotask_update_contract_service', 'autotask_get_contract_service', 'autotask_search_contract_services', 'autotask_get_contract_billed_units', 'autotask_report_contract_recurring_revenue', 'autotask_get_contract_milestone', 'autotask_search_contract_milestones', 'autotask_create_contract_milestone', 'autotask_update_contract_milestone', 'autotask_report_block_hour_usage', 'autotask_report_ticket_charges', 'autotask_report_unbilled', 'autotask_report_project_pl', 'autotask_report_sla_compliance', 'autotask_generate_sla_framework', 'autotask_report_sla_coverage', 'autotask_assign_contract_sla', 'autotask_analyze_ticket_billing_gaps', 'autotask_report_ticket_billing_gaps']
  },
  products_and_services: {
    description: 'Products, services, and service bundles catalog',
    tools: ['autotask_get_product', 'autotask_search_products', 'autotask_find_product', 'autotask_list_product_categories', 'autotask_find_catalog_gaps', 'autotask_find_duplicate_products', 'autotask_bulk_update_products', 'autotask_merge_products', 'autotask_create_product', 'autotask_update_product', 'autotask_search_inventory_products', 'autotask_get_inventory_product', 'autotask_create_inventory_product', 'autotask_update_inventory_product', 'autotask_search_inventory_locations', 'autotask_get_inventory_location', 'autotask_create_inventory_location', 'autotask_update_inventory_location', 'autotask_search_inventory_stocked_items', 'autotask_get_inventory_stocked_item', 'autotask_search_inventory_transfers', 'autotask_create_inventory_transfer', 'autotask_add_inventory_stock', 'autotask_remove_inventory_stock', 'autotask_report_inventory_reorder', 'autotask_report_inventory_closeouts', 'autotask_report_inventory_stale', 'autotask_get_service', 'autotask_search_services', 'autotask_get_service_bundle', 'autotask_search_service_bundles']
  },
  resources: {
    description: 'Search Autotask resources (technicians/staff) and roles (for assignment / time entries)',
    tools: ['autotask_search_resources', 'autotask_search_roles', 'autotask_get_resource_roles']
  },
  configuration_items: {
    description: 'Search and read configuration items (assets/devices), including contract/service entitlement links and coverage gaps',
    tools: ['autotask_search_configuration_items', 'autotask_get_configuration_item', 'autotask_create_configuration_item', 'autotask_update_configuration_item', 'autotask_get_configuration_item_entitlement', 'autotask_search_configuration_item_coverage_gaps']
  },
  company_notes: {
    description: 'Get, search, and create company notes',
    tools: ['autotask_get_company_note', 'autotask_search_company_notes', 'autotask_create_company_note']
  },
  service_calls: {
    description: 'Service call dispatching, ticket linking, and resource assignments',
    tools: ['autotask_reconcile_service_call', 'autotask_report_service_call_leakage', 'autotask_report_tickets_needing_scheduling', 'autotask_search_service_calls', 'autotask_get_service_call', 'autotask_create_service_call', 'autotask_update_service_call', 'autotask_delete_service_call', 'autotask_search_service_call_tickets', 'autotask_create_service_call_ticket', 'autotask_delete_service_call_ticket', 'autotask_search_service_call_ticket_resources', 'autotask_create_service_call_ticket_resource', 'autotask_delete_service_call_ticket_resource', 'autotask_search_service_call_tasks', 'autotask_create_service_call_task', 'autotask_delete_service_call_task', 'autotask_search_service_call_task_resources', 'autotask_create_service_call_task_resource', 'autotask_delete_service_call_task_resource']
  },
  company_todos: {
    description: 'Company To-Dos — CRM calendar follow-ups (distinct from tasks, checklist items, time entries, appointments, and service calls)',
    tools: ['autotask_get_company_todo', 'autotask_search_company_todos', 'autotask_create_company_todo', 'autotask_update_company_todo', 'autotask_complete_company_todo', 'autotask_delete_company_todo']
  },
  webhooks: {
    description: 'Autotask outbound webhook management — discover webhook-capable entities and inspect existing webhooks (read/discovery)',
    tools: ['autotask_list_webhook_entities', 'autotask_search_webhooks', 'autotask_get_webhook', 'autotask_create_webhook', 'autotask_update_webhook', 'autotask_delete_webhook', 'autotask_set_webhook_excluded_resources']
  }
};
