import { describe, expect, it } from 'vitest';
import { acceptResult, classify, executeRun, RunError } from '../src/client.js';
import { noSleep, okBody, reply, scriptedFetch } from './helpers.js';

const RUN = 'b'.repeat(32);
const params = (fetch, extra = {}) => ({
  baseUrl: 'https://broker.cleanedweb.com',
  apiKey: 'sk-secret',
  apiId: 'generated_abc',
  endpointId: 'generated_abc_search',
  idempotencyKey: 'key-1',
  input: { sort: 'desc_stars' },
  maxItems: 25,
  waitTimeout: 1800,
  fetch,
  sleep: noSleep(),
  ...extra,
});
const pending = (extra = {}) => reply(202, { run_id: RUN, status: 'running', ...extra }, { 'retry-after': '7', location: `/v1/runs/${RUN}` });

describe('executeRun', () => {
  it('sends the documented request and returns a 200 body', async () => {
    const fetch = scriptedFetch([reply(200, okBody([{ title: 'a' }]))]);
    const { body } = await executeRun(params(fetch));
    expect(body.records).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://broker.cleanedweb.com/v1/catalog/public/apis/generated_abc/endpoints/generated_abc_search/run');
    expect(call.headers).toMatchObject({ Authorization: 'Bearer sk-secret', 'Idempotency-Key': 'key-1', 'Content-Type': 'application/json' });
    expect(call.body).toEqual({ input: { sort: 'desc_stars' }, max_items: 25, timeout_seconds: 1800, wait_seconds: 90 });
  });

  it('pins a version and omits max_items when unset', async () => {
    const fetch = scriptedFetch([reply(200, okBody([]))]);
    await executeRun(params(fetch, { maxItems: undefined, version: 2, waitTimeout: 60 }));
    expect(fetch.calls[0].body).toEqual({ input: { sort: 'desc_stars' }, version: 2, timeout_seconds: 60, wait_seconds: 60 });
  });

  it('on 202 waits Retry-After and reads /result with the same key, never re-POSTing', async () => {
    const sleep = noSleep();
    const fetch = scriptedFetch([pending(), pending(), reply(200, okBody([{ title: 'a' }]))]);
    const { body, runId } = await executeRun(params(fetch, { sleep }));
    expect(body.records).toHaveLength(1);
    expect(runId).toBe('a'.repeat(32));
    expect(fetch.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET']);
    expect(fetch.calls[1].url).toMatch(/endpoints\/generated_abc_search\/result$/);
    expect(fetch.calls[1].headers).toMatchObject({ Authorization: 'Bearer sk-secret', 'Idempotency-Key': 'key-1' });
    expect(fetch.calls[1].body).toBeUndefined();
    expect(sleep.sleeps).toEqual([7000, 7000]);
  });

  it('falls back to poll_after_seconds when there is no Retry-After header', async () => {
    const sleep = noSleep();
    const fetch = scriptedFetch([reply(202, { run_id: RUN, poll_after_seconds: 11 }), reply(200, okBody([1]))]);
    await executeRun(params(fetch, { sleep }));
    expect(sleep.sleeps).toEqual([11000]);
  });

  it('gives up with a timeout error that names the run and the key', async () => {
    let t = 0;
    const fetch = scriptedFetch(Array.from({ length: 10 }, () => pending()));
    const error = await executeRun(params(fetch, { waitTimeout: 60, now: () => (t += 20_000) })).catch((e) => e);
    expect(error).toBeInstanceOf(RunError);
    expect(error.kind).toBe('timeout');
    expect(error.runId).toBe(RUN);
    expect(error.message).toMatch(/key-1/);
  });

  it.each([
    [401, { detail: 'Invalid API key' }, 'auth', /rejected the API key/],
    [403, {}, 'forbidden', /`run` scope/],
    [402, { detail: { code: 'insufficient_units', required: 25, available: 3 } }, 'credit', /needs 25 Units.*has 3/],
    [409, { detail: { code: 'usage_budget_exceeded' } }, 'budget', /monthly usage budget/],
    [409, { detail: { code: 'delivery_identity_conflict' } }, 'conflict', /different request/],
    [404, {}, 'not_found', /api-id/],
    [422, { detail: { code: 'source_input_invalid', message: 'bad input' } }, 'invalid', /source_input_invalid: bad input/],
  ])('maps HTTP %i to a clear %s error without retrying', async (status, body, kind, pattern) => {
    const fetch = scriptedFetch([reply(status, body)]);
    const error = await executeRun(params(fetch)).catch((e) => e);
    expect(error.kind).toBe(kind);
    expect(error.message).toMatch(pattern);
    expect(fetch.calls).toHaveLength(1);
  });

  it('never repeats the API key in an error', async () => {
    const fetch = scriptedFetch([reply(401, { detail: 'bad credential sk-secret' })]);
    const error = await executeRun(params(fetch)).catch((e) => e);
    expect(error.message).not.toContain('sk-secret');
  });

  it('treats a failed-run marker as final and names the run', async () => {
    const fetch = scriptedFetch([reply(502, { detail: { error_code: 'run_failed', run_id: RUN, replayed: false, code: 'source_blocked' } })]);
    const error = await executeRun(params(fetch)).catch((e) => e);
    expect(error.kind).toBe('run_failed');
    expect(error.runId).toBe(RUN);
    expect(error.message).toMatch(/new .*key|new workflow run/);
    expect(fetch.calls).toHaveLength(1);
  });

  it('honors Retry-After on 429 and retries with the same key', async () => {
    const sleep = noSleep();
    const fetch = scriptedFetch([reply(429, {}, { 'retry-after': '12' }), reply(200, okBody([1]))]);
    await executeRun(params(fetch, { sleep }));
    expect(sleep.sleeps).toEqual([12000]);
    expect(fetch.calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['key-1', 'key-1']);
    expect(fetch.calls.map((c) => c.method)).toEqual(['POST', 'POST']);
  });

  it('stops after repeated 429s', async () => {
    const fetch = scriptedFetch(Array.from({ length: 6 }, () => reply(429, {}, { 'retry-after': '1' })));
    const error = await executeRun(params(fetch)).catch((e) => e);
    expect(error.kind).toBe('rate_limit');
    expect(error.message).toMatch(/Rate limited/);
  });

  it('after a lost connection reads /result with the same key instead of re-POSTing', async () => {
    const fetch = scriptedFetch([new TypeError('fetch failed'), pending(), reply(200, okBody([1]))]);
    await executeRun(params(fetch));
    expect(fetch.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it('after a 503 reads /result; a 404 there means the POST never landed, so it is sent again with the same key', async () => {
    const fetch = scriptedFetch([reply(503, 'upstream down'), reply(404, {}), reply(200, okBody([1]))]);
    await executeRun(params(fetch));
    expect(fetch.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
    expect(new Set(fetch.calls.map((c) => c.headers['Idempotency-Key']))).toEqual(new Set(['key-1']));
  });

  it('stops after repeated unusable answers and says the run may have started', async () => {
    const fetch = scriptedFetch(Array.from({ length: 12 }, () => reply(503, 'down')));
    const error = await executeRun(params(fetch)).catch((e) => e);
    expect(error.kind).toBe('unavailable');
    expect(error.message).toMatch(/may have started.*key-1/);
  });

  it('refuses a 200 without a JSON body', async () => {
    const fetch = scriptedFetch([reply(200, 'not json')]);
    const error = await executeRun(params(fetch)).catch((e) => e);
    expect(error.kind).toBe('bad_response');
  });
});

describe('classify', () => {
  it('returns null for an unknown outcome (5xx without a marker)', () => {
    expect(classify(500, new Headers(), { detail: 'boom' })).toBeNull();
    expect(classify(504, new Headers(), null)).toBeNull();
  });
});

describe('acceptResult', () => {
  it('accepts completed and bounded results', () => {
    expect(acceptResult(okBody([{ a: 1 }])).records).toEqual([{ a: 1 }]);
    const bounded = okBody([{ a: 1 }]);
    bounded.summary.status = 'bounded';
    bounded.run.stop_reason = 'max_items';
    expect(acceptResult(bounded).stopReason).toBe('max_items');
  });

  it('rejects partial results and results outside their scope', () => {
    const partial = okBody([{ a: 1 }]);
    partial.summary.status = 'partial';
    expect(() => acceptResult(partial)).toThrow(/needs review.*partial/);
    const out = okBody([{ a: 1 }]);
    out.summary.within_scope_passed = false;
    expect(() => acceptResult(out)).toThrow(/within_scope_passed is false/);
    expect(() => acceptResult({ records: [] })).toThrow(/needs review/);
  });
});
