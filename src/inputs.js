import { createHash } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://broker.cleanedweb.com';
export const FORMATS = ['json', 'jsonl', 'csv'];
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;

const ID_RE = /^[A-Za-z0-9_-]+$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export class InputError extends Error {}

function integer(name, raw, { min, max }) {
  if (!/^\d+$/.test(raw)) throw new InputError(`\`${name}\` must be a whole number, got "${raw}".`);
  const value = Number(raw);
  if (value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `at least ${min}` : `between ${min} and ${max}`;
    throw new InputError(`\`${name}\` must be ${range}, got ${value}.`);
  }
  return value;
}

function bool(name, raw) {
  if (raw === '') return false;
  const v = raw.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new InputError(`\`${name}\` must be true or false, got "${raw}".`);
}

/** Stable JSON: object keys sorted, so equal requests hash equally. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Derive an idempotency key for this step. It always starts with the workflow run
 * and attempt, and ends with a fingerprint of the request, so two steps of one job
 * that run different requests never share a key (a shared key would answer 409).
 * A re-run of the workflow (new attempt) is a new key and so a new, charged run.
 */
export function deriveIdempotencyKey(env, request) {
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT || '1';
  if (!runId) {
    throw new InputError(
      'Set `idempotency-key`: outside GitHub Actions there is no GITHUB_RUN_ID to derive one from.',
    );
  }
  const fingerprint = createHash('sha256').update(canonicalJson(request)).digest('hex').slice(0, 12);
  return `gh-${runId}-${attempt}-${fingerprint}`;
}

/**
 * Read and validate the action inputs.
 * @param {(name: string) => string} get returns the raw input ('' when unset)
 * @param {Record<string, string | undefined>} env
 */
export function readInputs(get, env = {}) {
  const apiKey = get('api-key');
  if (!apiKey) {
    throw new InputError(
      '`api-key` is empty. Create a key with the `run` scope in the CleanedWeb console, store it as a repository secret, and pass `api-key: ${{ secrets.CLEANEDWEB_API_KEY }}`. Secrets are not passed to workflows triggered from forks.',
    );
  }

  const apiId = get('api-id');
  if (!apiId) throw new InputError('`api-id` is required (for example generated_047a8ebb25911ccf62f4a212).');
  if (!ID_RE.test(apiId)) throw new InputError('`api-id` may only contain letters, numbers, `_` and `-`.');

  const endpointId = get('endpoint-id') || `${apiId}_search`;
  if (!ID_RE.test(endpointId)) throw new InputError('`endpoint-id` may only contain letters, numbers, `_` and `-`.');

  const rawInput = get('input') || '{}';
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (error) {
    throw new InputError(`\`input\` is not valid JSON: ${error.message}`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('`input` must be a JSON object, for example {"sort":"desc_stars"}.');
  }

  const rawMax = get('max-items');
  const maxItems = rawMax === '' ? undefined : integer('max-items', rawMax, { min: 1 });

  const rawVersion = get('version');
  const version = rawVersion === '' ? undefined : integer('version', rawVersion, { min: 1 });

  const format = (get('format') || 'json').toLowerCase();
  if (!FORMATS.includes(format)) throw new InputError(`\`format\` must be one of ${FORMATS.join(', ')}, got "${format}".`);

  const waitTimeout = get('wait-timeout')
    ? integer('wait-timeout', get('wait-timeout'), { min: 60, max: 86400 })
    : DEFAULT_WAIT_TIMEOUT_SECONDS;

  const baseUrl = (get('base-url') || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new InputError(`\`base-url\` is not a URL: ${baseUrl}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new InputError('`base-url` must be https (the API key is sent to it).');
  }

  let idempotencyKey = get('idempotency-key');
  if (idempotencyKey) {
    if (!KEY_RE.test(idempotencyKey)) {
      throw new InputError('`idempotency-key` must be 1-200 characters: letters, numbers, `.`, `_`, `:`, `-`.');
    }
  } else {
    idempotencyKey = deriveIdempotencyKey(env, { apiId, endpointId, input, maxItems, version, waitTimeout });
  }

  const outputPath = get('output-path') || `data/${apiId}.${format === 'jsonl' ? 'jsonl' : format}`;

  return {
    apiKey,
    apiId,
    endpointId,
    input,
    maxItems,
    version,
    format,
    outputPath,
    waitTimeout,
    baseUrl,
    idempotencyKey,
    allowEmpty: bool('allow-empty', get('allow-empty')),
  };
}
