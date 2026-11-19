import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acceptResult, executeRun, RunError } from './client.js';
import { serialize } from './format.js';
import { InputError, readInputs } from './inputs.js';

/** Resolve the output path inside the workspace; refuse anything that leaves it. */
export function resolveOutputPath(outputPath, workspace) {
  const root = path.resolve(workspace);
  const target = path.resolve(root, outputPath);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InputError(`\`output-path\` must be a file inside the workspace, got "${outputPath}".`);
  }
  return { target, relative: relative.split(path.sep).join('/') };
}

/**
 * @param {object} deps
 * @param {object} deps.core the parts of @actions/core used here
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 */
export async function run({ core, env = process.env, fetch: fetchImpl, sleep, now }) {
  let inputs;
  let runId;
  try {
    inputs = readInputs((name) => core.getInput(name).trim(), env);
    core.setSecret(inputs.apiKey); // mask before anything is logged
    const { target, relative } = resolveOutputPath(inputs.outputPath, env.GITHUB_WORKSPACE || process.cwd());

    core.setOutput('idempotency-key', inputs.idempotencyKey);
    if (inputs.maxItems === undefined) {
      core.info('No `max-items` set: the run continues until the source has no more records or the time budget ends, and every record delivered is charged.');
    }
    core.info(`Running ${inputs.apiId} / ${inputs.endpointId} (idempotency key ${inputs.idempotencyKey}).`);

    const { body, runId: answeredRunId } = await executeRun({
      baseUrl: inputs.baseUrl,
      apiKey: inputs.apiKey,
      apiId: inputs.apiId,
      endpointId: inputs.endpointId,
      idempotencyKey: inputs.idempotencyKey,
      input: inputs.input,
      maxItems: inputs.maxItems,
      version: inputs.version,
      waitTimeout: inputs.waitTimeout,
      fetch: fetchImpl,
      sleep,
      now,
      log: (line) => core.info(line),
    });
    runId = answeredRunId;

    const result = acceptResult(body, runId);
    runId = result.runId;
    if (runId) core.setOutput('run-id', runId);

    if (typeof result.summaryRecords === 'number' && result.summaryRecords !== result.records.length) {
      core.warning(`summary.records is ${result.summaryRecords} but the response holds ${result.records.length} records.`);
    }
    if (result.records.length === 0 && !inputs.allowEmpty) {
      throw new RunError(
        'review',
        `The run returned 0 records (run ${runId ?? 'unknown'}), so ${relative} was left untouched. An empty result is more often a changed filter or a source problem than an empty source; set \`allow-empty: true\` to write it anyway.`,
        { runId },
      );
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, serialize(result.records, inputs.format), 'utf8');

    core.setOutput('record-count', String(result.records.length));
    core.setOutput('output-path', relative);
    if (result.stopReason) core.setOutput('stop-reason', result.stopReason);
    if (result.unitsCharged !== undefined) core.setOutput('units-charged', String(result.unitsCharged));

    core.info(
      `Run ${runId ?? '(id not returned)'} ended (${result.status}, stop_reason ${result.stopReason ?? 'n/a'}): wrote ${result.records.length} records to ${relative} as ${inputs.format}.` +
        (result.unitsCharged !== undefined ? ` Units charged: ${result.unitsCharged}.` : ''),
    );
    return { recordCount: result.records.length, runId, outputPath: relative };
  } catch (error) {
    if (error instanceof RunError && (error.runId ?? runId)) core.setOutput('run-id', error.runId ?? runId);
    const message = error instanceof InputError || error instanceof RunError ? error.message : `Unexpected error: ${error?.message ?? error}`;
    core.setFailed(message);
    return undefined;
  }
}
