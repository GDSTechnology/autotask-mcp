// #23 §16 slice 2 — webhook writes (guarded). Pure payload/validation +
// dry-run-first create/update/excluded-resources + delete, service mocked.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { buildWebhookPayload, validateWebhookCreate } from '../src/utils/webhook-entities';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

describe('webhook payload + validation (pure)', () => {
  test('buildWebhookPayload maps friendly params → Autotask fields, only provided keys', () => {
    const p = buildWebhookPayload({ name: 'W', webhookUrl: 'https://x', subscribeCreate: true, subscribeUpdate: false, ownerResourceID: 5 });
    expect(p).toEqual({ name: 'W', webhookUrl: 'https://x', isSubscribedToCreateEvents: true, isSubscribedToUpdateEvents: false, ownerResourceID: 5 });
    expect(p).not.toHaveProperty('isSubscribedToDeleteEvents'); // not supplied
  });

  test('validateWebhookCreate enforces name, https url, ≥1 event', () => {
    expect(validateWebhookCreate({ name: 'W', webhookUrl: 'https://x', subscribeCreate: true })).toEqual([]);
    expect(validateWebhookCreate({ webhookUrl: 'https://x', subscribeCreate: true })).toContain('name is required');
    expect(validateWebhookCreate({ name: 'W', webhookUrl: 'http://x', subscribeCreate: true })).toContain('webhookUrl must be an https:// URL');
    expect(validateWebhookCreate({ name: 'W', webhookUrl: 'https://x' }).some((e) => /at least one event/.test(e))).toBe(true);
  });
});

describe('service webhook writes', () => {
  const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
  const mk = () => new AutotaskService(config, new Logger('error'));

  test('createWebhook dry-run: nothing written, plan returned', async () => {
    const s = mk();
    const create = jest.fn();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    const r = await s.createWebhook('tickets', { name: 'W', webhookUrl: 'https://n8n/x', subscribeUpdate: true, excludedResourceIDs: [30683829] });
    expect(r.status).toBe('dry_run');
    expect(r.plannedExcludedResources).toEqual([30683829]);
    expect(create).not.toHaveBeenCalled();
  });

  test('createWebhook validation_failed on bad input, nothing written', async () => {
    const s = mk();
    const create = jest.fn();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    const r = await s.createWebhook('tickets', { name: '', webhookUrl: 'http://x', dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(create).not.toHaveBeenCalled();
  });

  test('createWebhook execute: creates parent then fields + excluded resources', async () => {
    const s = mk();
    const ids = [900, 901, 902];
    const create = jest.fn().mockImplementation(async () => ids.shift());
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create });
    const r = await s.createWebhook('tickets', {
      name: 'W', webhookUrl: 'https://n8n/x', subscribeCreate: true,
      fields: [{ fieldID: 3 }], excludedResourceIDs: [30683829], dryRun: false,
    });
    expect(r.status).toBe('created');
    expect(r.webhookID).toBe(900);
    expect(create).toHaveBeenNthCalledWith(1, 'TicketWebhooks', expect.objectContaining({ name: 'W', isSubscribedToCreateEvents: true, isActive: true }));
    expect(create).toHaveBeenNthCalledWith(2, 'TicketWebhookFields', expect.objectContaining({ webhookID: 900, fieldID: 3 }));
    expect(create).toHaveBeenNthCalledWith(3, 'TicketWebhookExcludedResources', { webhookID: 900, resourceID: 30683829 });
  });

  test('updateWebhook dry-run then execute maps fields', async () => {
    const s = mk();
    const update = jest.fn();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ update });
    const dry = await s.updateWebhook('tickets', 7, { isActive: false });
    expect(dry.status).toBe('dry_run');
    expect(update).not.toHaveBeenCalled();

    const done = await s.updateWebhook('tickets', 7, { isActive: false }, false);
    expect(done.status).toBe('updated');
    expect(update).toHaveBeenCalledWith('TicketWebhooks', 7, { isActive: false });
  });

  test('updateWebhook rejects a non-https url', async () => {
    const s = mk();
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ update: jest.fn() });
    const r = await s.updateWebhook('tickets', 7, { webhookUrl: 'http://x' }, false);
    expect(r.status).toBe('validation_failed');
  });

  test('deleteWebhook calls http.delete on the parent entity', async () => {
    const s = mk();
    const del = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ delete: del });
    await s.deleteWebhook('tickets', 7);
    expect(del).toHaveBeenCalledWith('TicketWebhooks', 7);
  });

  test('setWebhookExcludedResources add: only creates missing', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    const query = jest.fn().mockResolvedValue([{ id: 50, resourceID: 111 }]); // 111 already excluded
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create, query, delete: jest.fn() });
    const r = await s.setWebhookExcludedResources('tickets', 7, [111, 222], 'add', false);
    expect(r.status).toBe('updated');
    expect(create).toHaveBeenCalledTimes(1); // only 222
    expect(create).toHaveBeenCalledWith('TicketWebhookExcludedResources', { webhookID: 7, resourceID: 222 });
  });

  test('setWebhookExcludedResources replace: adds new, removes stale rows', async () => {
    const s = mk();
    const create = jest.fn().mockResolvedValue(1);
    const del = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn().mockResolvedValue([{ id: 50, resourceID: 111 }, { id: 51, resourceID: 999 }]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create, delete: del, query });
    const r = await s.setWebhookExcludedResources('tickets', 7, [111, 222], 'replace', false);
    expect(create).toHaveBeenCalledWith('TicketWebhookExcludedResources', { webhookID: 7, resourceID: 222 }); // add 222
    expect(del).toHaveBeenCalledWith('TicketWebhookExcludedResources', 51); // remove stale 999
    expect(r.status).toBe('updated');
  });

  test('setWebhookExcludedResources dry-run writes nothing', async () => {
    const s = mk();
    const create = jest.fn();
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ create, query, delete: jest.fn() });
    const r = await s.setWebhookExcludedResources('tickets', 7, [222], 'add');
    expect(r.status).toBe('dry_run');
    expect(r.wouldAddResourceIDs).toEqual([222]);
    expect(create).not.toHaveBeenCalled();
  });
});
