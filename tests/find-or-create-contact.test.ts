// find-or-create contact — idempotent contact resolution (n8n contact-race fix).

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' },
};

afterEach(() => jest.restoreAllMocks());

describe('findOrCreateContact', () => {
  test('existing email → returns match, does not create', async () => {
    const service = new AutotaskService(config, logger);
    const fakeHttp = { query: jest.fn().mockResolvedValue([{ id: 42 }]) };
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fakeHttp);
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(999);

    const r = await service.findOrCreateContact(1, { emailAddress: 'x@y.com' });
    expect(r).toEqual({ id: 42, created: false });
    expect(createSpy).not.toHaveBeenCalled();
    expect(fakeHttp.query).toHaveBeenCalledTimes(1);
  });

  test('no match → creates with companyID', async () => {
    const service = new AutotaskService(config, logger);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query: jest.fn().mockResolvedValue([]) });
    const createSpy = jest.spyOn(service, 'createContact').mockResolvedValue(999);

    const r = await service.findOrCreateContact(7, { emailAddress: 'new@y.com', firstName: 'A', lastName: 'B' });
    expect(r).toEqual({ id: 999, created: true });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ companyID: 7, emailAddress: 'new@y.com' }));
  });

  test('no email → creates directly (no lookup)', async () => {
    const service = new AutotaskService(config, logger);
    const fakeHttp = { query: jest.fn() };
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue(fakeHttp);
    jest.spyOn(service, 'createContact').mockResolvedValue(555);

    const r = await service.findOrCreateContact(3, { firstName: 'A', lastName: 'B' });
    expect(r).toEqual({ id: 555, created: true });
    expect(fakeHttp.query).not.toHaveBeenCalled();
  });

  test('missing companyID throws', async () => {
    const service = new AutotaskService(config, logger);
    await expect(service.findOrCreateContact(undefined as any, { emailAddress: 'x@y.com' })).rejects.toThrow(/companyID/);
  });
});
