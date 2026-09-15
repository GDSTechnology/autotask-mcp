// #42 slice 2 — trusted gateway impersonation (Teams handoff). The acting
// identity comes from a gateway header read only in gateway mode behind the S2S
// gate; it outranks the (spoofable) payload email but not an explicit in-call
// resource. Mocked service.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { parseActingHeaders, ACTING_RESOURCE_ID_HEADER, ACTING_USER_EMAIL_HEADER } from '../src/utils/impersonation';
import type { CallerContext } from '../src/types/context';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const baseCtx = (over: Partial<CallerContext> = {}): CallerContext => ({ source: 'hermes-teams', correlationId: 'c1', timestamp: 'now', ...over });
afterEach(() => jest.restoreAllMocks());

describe('parseActingHeaders', () => {
  test('parses resource id and email (case-insensitive, array-tolerant)', () => {
    expect(parseActingHeaders({ [ACTING_RESOURCE_ID_HEADER]: '5' })).toEqual({ resourceId: 5 });
    expect(parseActingHeaders({ [ACTING_USER_EMAIL_HEADER]: 'me@x.com' })).toEqual({ email: 'me@x.com' });
    expect(parseActingHeaders({ 'X-Acting-Resource-Id': ['7', '8'] } as any)).toEqual({ resourceId: 7 });
  });
  test('returns undefined when absent or invalid', () => {
    expect(parseActingHeaders({})).toBeUndefined();
    expect(parseActingHeaders({ [ACTING_RESOURCE_ID_HEADER]: 'abc' })).toBeUndefined();
  });
});

describe('resolveCaller honors trusted acting identity (#42)', () => {
  test('trusted resource id resolves directly (via gateway-impersonation)', async () => {
    const service = new AutotaskService(config, logger);
    const handler = new AutotaskToolHandler(service, logger);
    const r = await handler.resolveCaller(baseCtx({ trustedActingResourceId: 5 }));
    expect(r).toMatchObject({ status: 'resolved', via: 'gateway-impersonation', resource: { id: 5 } });
  });

  test('trusted acting outranks the payload email', async () => {
    const service = new AutotaskService(config, logger);
    const byEmail = jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([]);
    const handler = new AutotaskToolHandler(service, logger);
    const r = await handler.resolveCaller(baseCtx({ trustedActingResourceId: 5, requestingUserEmail: 'other@x.com' }));
    expect(r).toMatchObject({ resource: { id: 5 } });
    expect(byEmail).not.toHaveBeenCalled(); // never fell through to payload email
  });

  test('trusted acting email is matched live against Resources', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'searchResourcesByEmail').mockResolvedValue([{ id: 9, firstName: 'A', lastName: 'B', email: 'me@x.com' } as any]);
    const handler = new AutotaskToolHandler(service, logger);
    const r = await handler.resolveCaller(baseCtx({ trustedActingUserEmail: 'me@x.com' }));
    expect(r).toMatchObject({ status: 'resolved', via: 'gateway-impersonation', resource: { id: 9 } });
  });

  test('an explicit in-call resource still wins over the trusted header', async () => {
    const service = new AutotaskService(config, logger);
    const handler = new AutotaskToolHandler(service, logger);
    const r = await handler.resolveCaller(baseCtx({ trustedActingResourceId: 5 }), { resourceId: 42 });
    expect(r).toMatchObject({ via: 'explicit-id', resource: { id: 42 } });
  });
});

describe('callTool applies the trusted acting context end-to-end (#42)', () => {
  test('currentUser assigns the impersonated resource; extractCallerContext never sets it from payload', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    const create = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    const handler = new AutotaskToolHandler(service, logger);
    handler.setTrustedActingContext({ resourceId: 5 });
    await handler.callTool('autotask_create_ticket', { companyID: 1, title: 'T', description: 'D', currentUser: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assignedResourceID: 5, assignedResourceRoleID: 99 }));
  });

  test('a client cannot self-impersonate via _context (payload autotaskResourceId is not trusted)', async () => {
    const service = new AutotaskService(config, logger);
    const create = jest.spyOn(service, 'createTicket').mockResolvedValue(1);
    jest.spyOn(service, 'resolveResourceDefaultRole').mockResolvedValue(99);
    const handler = new AutotaskToolHandler(service, logger);
    // No setTrustedActingContext — payload carries autotaskResourceId, which must
    // NOT resolve the caller (resolveCaller ignores it; no email either).
    const result = await handler.callTool('autotask_create_ticket', {
      companyID: 1, title: 'T', description: 'D', currentUser: true,
      _context: { autotaskResourceId: 7, source: 'chatgpt' },
    });
    // currentUser could not resolve → identification required, ticket not created.
    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).data).toMatchObject({ status: 'user_identification_required' });
  });
});
