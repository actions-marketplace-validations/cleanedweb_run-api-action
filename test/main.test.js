import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveOutputPath, run } from '../src/main.js';
import { fakeCore, noSleep, okBody, reply, scriptedFetch } from './helpers.js';

let workspace;
let env;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'run-api-action-'));
  env = { GITHUB_WORKSPACE: workspace, GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1' };
});

const inputs = (extra = {}) => ({ 'api-key': 'sk-secret', 'api-id': 'generated_abc', 'max-items': '2', ...extra });
const records = [
  { title: 'one', n: 1 },
  { title: 'two, with comma', n: 2 },
];

describe('run', () => {
  it('writes the file, sets outputs and masks the key', async () => {
    const core = fakeCore(inputs());
    const fetch = scriptedFetch([reply(200, okBody(records))]);
    const result = await run({ core, env, fetch, sleep: noSleep() });
    expect(core.out.failed).toBeUndefined();
    expect(core.out.secrets).toEqual(['sk-secret']);
    expect(core.out.outputs).toMatchObject({
      'record-count': '2',
      'run-id': 'a'.repeat(32),
      'output-path': 'data/generated_abc.json',
      'stop-reason': 'source_exhausted',
      'units-charged': '2',
    });
    expect(core.out.outputs['idempotency-key']).toMatch(/^gh-99-1-/);
    expect(JSON.parse(await readFile(path.join(workspace, 'data/generated_abc.json'), 'utf8'))).toEqual(records);
    expect(result.recordCount).toBe(2);
  });

  it('writes jsonl and csv', async () => {
    for (const [format, expected] of [
      ['jsonl', '{"title":"one","n":1}\n{"title":"two, with comma","n":2}\n'],
      ['csv', 'title,n\r\none,1\r\n"two, with comma",2\r\n'],
    ]) {
      const core = fakeCore(inputs({ format, 'output-path': `out/r.${format}` }));
      await run({ core, env, fetch: scriptedFetch([reply(200, okBody(records))]), sleep: noSleep() });
      expect(core.out.failed).toBeUndefined();
      expect(await readFile(path.join(workspace, `out/r.${format}`), 'utf8')).toBe(expected);
    }
  });

  it('polls a 202 to completion', async () => {
    const core = fakeCore(inputs());
    const fetch = scriptedFetch([
      reply(202, { run_id: 'c'.repeat(32), status: 'queued' }, { 'retry-after': '3' }),
      reply(200, okBody(records)),
    ]);
    await run({ core, env, fetch, sleep: noSleep() });
    expect(core.out.failed).toBeUndefined();
    expect(core.out.outputs['record-count']).toBe('2');
  });

  it('fails with a clear message on a bad key and writes nothing', async () => {
    const core = fakeCore(inputs());
    await run({ core, env, fetch: scriptedFetch([reply(401, { detail: 'nope' })]), sleep: noSleep() });
    expect(core.out.failed).toMatch(/rejected the API key/);
    await expect(stat(path.join(workspace, 'data'))).rejects.toThrow();
  });

  it('fails on insufficient credit', async () => {
    const core = fakeCore(inputs());
    await run({ core, env, fetch: scriptedFetch([reply(402, { detail: { code: 'insufficient_units', required: 5, available: 0 } })]), sleep: noSleep() });
    expect(core.out.failed).toMatch(/Not enough credit/);
  });

  it('does not overwrite the data file with a partial result', async () => {
    const body = okBody(records);
    body.summary.status = 'partial';
    const core = fakeCore(inputs());
    await run({ core, env, fetch: scriptedFetch([reply(200, body)]), sleep: noSleep() });
    expect(core.out.failed).toMatch(/needs review/);
    expect(core.out.outputs['run-id']).toBe('a'.repeat(32));
    await expect(stat(path.join(workspace, 'data'))).rejects.toThrow();
  });

  it('fails on an empty result unless allow-empty is set', async () => {
    const core = fakeCore(inputs());
    await run({ core, env, fetch: scriptedFetch([reply(200, okBody([]))]), sleep: noSleep() });
    expect(core.out.failed).toMatch(/0 records/);
    const core2 = fakeCore(inputs({ 'allow-empty': 'true' }));
    await run({ core: core2, env, fetch: scriptedFetch([reply(200, okBody([]))]), sleep: noSleep() });
    expect(core2.out.failed).toBeUndefined();
    expect(core2.out.outputs['record-count']).toBe('0');
  });

  it('rejects an output path outside the workspace', async () => {
    const core = fakeCore(inputs({ 'output-path': '../escape.json' }));
    await run({ core, env, fetch: scriptedFetch([]), sleep: noSleep() });
    expect(core.out.failed).toMatch(/inside the workspace/);
  });

  it('reports input errors before any request', async () => {
    const fetch = scriptedFetch([]);
    const core = fakeCore(inputs({ input: '{bad' }));
    await run({ core, env, fetch, sleep: noSleep() });
    expect(core.out.failed).toMatch(/not valid JSON/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('warns when summary.records disagrees with the array', async () => {
    const body = okBody(records);
    body.summary.records = 5;
    const core = fakeCore(inputs());
    await run({ core, env, fetch: scriptedFetch([reply(200, body)]), sleep: noSleep() });
    expect(core.out.warnings.join(' ')).toMatch(/summary.records is 5/);
  });

  it('does not log record values', async () => {
    const core = fakeCore(inputs());
    await run({ core, env, fetch: scriptedFetch([reply(200, okBody(records))]), sleep: noSleep() });
    expect(core.out.info.join('\n')).not.toContain('with comma');
  });
});

describe('resolveOutputPath', () => {
  it('keeps paths inside the workspace', () => {
    expect(resolveOutputPath('a/b.json', '/ws').relative).toBe('a/b.json');
    expect(() => resolveOutputPath('../x', '/ws')).toThrow();
    expect(() => resolveOutputPath('/etc/passwd', '/ws')).toThrow();
    expect(() => resolveOutputPath('.', '/ws')).toThrow();
  });
});
