// The n8n signature-check snippet in docs/N8N_WEBHOOKS.md is the tested code:
// extract it from the doc and run it the way an n8n Code node does (an async
// function with `this.helpers`, `$input`, `$env`, `require`) against payloads
// signed exactly as Autotask signs them: "sha1=" + base64(HMAC-SHA1(secret, raw body)).

import { readFileSync } from 'fs';
import { createHmac } from 'crypto';
import { join } from 'path';

const DOC = readFileSync(join(__dirname, '..', 'docs', 'N8N_WEBHOOKS.md'), 'utf8');
const SNIPPET = (() => {
  const m = DOC.match(/<!-- n8n-code-node:start -->\s*```js\r?\n([\s\S]*?)```\s*<!-- n8n-code-node:end -->/);
  if (!m) throw new Error('n8n Code node snippet markers not found in docs/N8N_WEBHOOKS.md');
  return m[1]!;
})();

const SECRET = 'e48eee6c-test-secret-0123456789abcdef';
const sign = (body: string | Buffer, secret = SECRET) => 'sha1=' + createHmac('sha1', secret).update(body).digest('base64');

interface Delivery { body?: string | Buffer; headers?: Record<string, string> }

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runNode(deliveries: Delivery[], env: Record<string, string | undefined> = { AUTOTASK_WEBHOOK_SECRET: SECRET }) {
  const items = deliveries.map((d) => ({
    json: { headers: d.headers ?? {} },
    ...(d.body !== undefined ? { binary: { data: { data: 'filesystem-v2', mimeType: 'application/json' } } } : {}),
  }));
  const ctx = {
    helpers: {
      // n8n returns the stored bytes regardless of binary mode; the snippet must use this.
      getBinaryDataBuffer: async (i: number, prop: string) => {
        expect(prop).toBe('data');
        return Buffer.isBuffer(deliveries[i]!.body) ? deliveries[i]!.body : Buffer.from(String(deliveries[i]!.body), 'utf8');
      },
    },
  };
  const allowedRequire = (name: string) => {
    if (name !== 'crypto') throw new Error(`module ${name} not allowed`);
    return require('crypto');
  };
  const fn = new AsyncFunction('require', '$env', '$input', SNIPPET);
  return fn.call(ctx, allowedRequire, env, { all: () => items }) as Promise<Array<{ json: { signatureValid: boolean; reason: string; payload: unknown } }>>;
}

const BODY = JSON.stringify({ Action: 'Update', Guid: '6f1c…', EntityType: 'Ticket', Id: 208847, Fields: { status: 8, title: 'Café printer — ünïcode' }, EventTime: '2026-10-02T14:00:00Z' });

describe('docs/N8N_WEBHOOKS.md Code node snippet', () => {
  test('a correctly signed delivery is valid and its payload parsed', async () => {
    const [r] = await runNode([{ body: BODY, headers: { 'x-hook-signature': sign(BODY) } }]);
    expect(r!.json).toEqual({ signatureValid: true, reason: 'ok', payload: JSON.parse(BODY) });
  });

  test('signature is over the RAW bytes: re-serialized JSON (spacing) does not verify', async () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    const [r] = await runNode([{ body: pretty, headers: { 'x-hook-signature': sign(BODY) } }]);
    expect(r!.json).toMatchObject({ signatureValid: false, reason: 'signature mismatch', payload: null });
  });

  test('tampered body, wrong secret, missing header → invalid, payload never parsed', async () => {
    const tampered = BODY.replace('208847', '208848');
    const out = await runNode([
      { body: tampered, headers: { 'x-hook-signature': sign(BODY) } },
      { body: BODY, headers: { 'x-hook-signature': sign(BODY, 'some-other-secret-value') } },
      { body: BODY, headers: {} },
    ]);
    expect(out.map((o) => o.json.signatureValid)).toEqual([false, false, false]);
    expect(out.map((o) => o.json.payload)).toEqual([null, null, null]);
    expect(out[2]!.json.reason).toBe('missing X-Hook-Signature header');
  });

  test('a length-mismatched header is rejected without throwing (timingSafeEqual guard)', async () => {
    const [r] = await runNode([{ body: BODY, headers: { 'x-hook-signature': 'sha1=short' } }]);
    expect(r!.json.signatureValid).toBe(false);
  });

  test('multi-byte UTF-8 bodies verify on the bytes (Buffer body)', async () => {
    const bytes = Buffer.from(BODY, 'utf8');
    const [r] = await runNode([{ body: bytes, headers: { 'x-hook-signature': sign(bytes) } }]);
    expect(r!.json.signatureValid).toBe(true);
  });

  test('setup errors are explicit: no secret visible, raw body off', async () => {
    await expect(runNode([{ body: BODY, headers: {} }], {})).rejects.toThrow(/AUTOTASK_WEBHOOK_SECRET is not visible/);
    await expect(runNode([{ headers: { 'x-hook-signature': sign(BODY) } }])).rejects.toThrow(/Raw Body/);
  });

  test('the snippet only needs the crypto builtin (NODE_FUNCTION_ALLOW_BUILTIN=crypto)', () => {
    const required = [...SNIPPET.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required).toEqual(['crypto']);
  });
});
