import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey, InputError, readInputs } from '../src/inputs.js';

const base = { 'api-key': 'k', 'api-id': 'generated_abc' };
const get = (extra = {}) => (name) => ({ ...base, ...extra })[name] ?? '';
const env = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };

describe('readInputs', () => {
  it('applies defaults', () => {
    const i = readInputs(get(), env);
    expect(i).toMatchObject({
      endpointId: 'generated_abc_search',
      input: {},
      format: 'json',
      outputPath: 'data/generated_abc.json',
      waitTimeout: 1800,
      baseUrl: 'https://api.cleanedweb.com',
      allowEmpty: false,
    });
    expect(i.maxItems).toBeUndefined();
  });

  it('uses the format as the default file extension', () => {
    expect(readInputs(get({ format: 'csv' }), env).outputPath).toBe('data/generated_abc.csv');
    expect(readInputs(get({ format: 'jsonl' }), env).outputPath).toBe('data/generated_abc.jsonl');
  });

  it('requires the key and the api id', () => {
    expect(() => readInputs(get({ 'api-key': '' }), env)).toThrow(/api-key.*empty/);
    expect(() => readInputs(get({ 'api-id': '' }), env)).toThrow(/api-id/);
  });

  it('rejects an api id that could alter the URL', () => {
    expect(() => readInputs(get({ 'api-id': '../x' }), env)).toThrow(InputError);
  });

  it('parses and validates input JSON', () => {
    expect(readInputs(get({ input: '{"sort":"desc_stars"}' }), env).input).toEqual({ sort: 'desc_stars' });
    expect(() => readInputs(get({ input: '{nope' }), env)).toThrow(/not valid JSON/);
    expect(() => readInputs(get({ input: '[1]' }), env)).toThrow(/JSON object/);
  });

  it('validates numbers and format', () => {
    expect(readInputs(get({ 'max-items': '25' }), env).maxItems).toBe(25);
    expect(() => readInputs(get({ 'max-items': '0' }), env)).toThrow(/at least 1/);
    expect(() => readInputs(get({ 'max-items': 'ten' }), env)).toThrow(/whole number/);
    expect(() => readInputs(get({ 'wait-timeout': '5' }), env)).toThrow(/between 60 and 86400/);
    expect(() => readInputs(get({ format: 'xml' }), env)).toThrow(/json, jsonl, csv/);
  });

  it('only sends the key to https (or localhost) origins', () => {
    expect(() => readInputs(get({ 'base-url': 'http://example.com' }), env)).toThrow(/https/);
    expect(readInputs(get({ 'base-url': 'http://localhost:8080/' }), env).baseUrl).toBe('http://localhost:8080');
  });
});

describe('idempotency key', () => {
  it('is derived from run id, attempt and a request fingerprint', () => {
    const key = readInputs(get(), env).idempotencyKey;
    expect(key).toMatch(/^gh-123-2-[0-9a-f]{12}$/);
  });

  it('is stable for the same request and differs for another request or attempt', () => {
    const a = readInputs(get({ input: '{"a":1,"b":2}' }), env).idempotencyKey;
    const b = readInputs(get({ input: '{"b":2,"a":1}' }), env).idempotencyKey;
    const c = readInputs(get({ input: '{"a":1}' }), env).idempotencyKey;
    const d = readInputs(get({ input: '{"a":1,"b":2}' }), { ...env, GITHUB_RUN_ATTEMPT: '3' }).idempotencyKey;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('keeps a valid explicit key and rejects an invalid one', () => {
    expect(readInputs(get({ 'idempotency-key': 'nightly:2026-11-20' }), env).idempotencyKey).toBe('nightly:2026-11-20');
    expect(() => readInputs(get({ 'idempotency-key': 'has space' }), env)).toThrow(/1-200 characters/);
    expect(() => readInputs(get({ 'idempotency-key': 'x'.repeat(201) }), env)).toThrow(/1-200/);
  });

  it('needs an explicit key outside GitHub Actions', () => {
    expect(() => deriveIdempotencyKey({}, {})).toThrow(/Set `idempotency-key`/);
  });
});
