/**
 * Run a CleanedWeb catalog API and wait for its result.
 *
 * Protocol (https://cleanedweb.com/docs/run-catalog-api/):
 *   POST {base}/v1/catalog/public/apis/{api}/endpoints/{endpoint}/run
 *     Authorization: Bearer <key>, Idempotency-Key: <key>
 *     200 -> final body; 202 -> run still going, read GET .../result with the same
 *     API key and Idempotency-Key after Retry-After seconds.
 *
 * The POST is never blindly re-sent. If an answer proves nothing (timeout, lost
 * connection, 5xx without a failed-run marker), the same key is used to read
 * /result; only a 404 there (the key is unknown, so the POST never landed) lets
 * the same request be sent again with the same key.
 */

export class RunError extends Error {
  /**
   * @param {string} kind auth | forbidden | credit | budget | not_found | invalid | conflict |
   *   rate_limit | run_failed | unavailable | timeout | review | bad_response
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'RunError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const BILLING_URL = 'https://cleanedweb.com/docs/billing/';
const MAX_UNSURE = 5;
const MAX_RATE_LIMITED = 5;
const REQUEST_TIMEOUT_MS = 120_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function text(value, limit = 300) {
  const s = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

/** Pull the documented fields out of an error body without echoing the whole body. */
export function errorDetail(body) {
  const detail = body && typeof body === 'object' ? body.detail ?? body.error ?? body : undefined;
  if (typeof detail === 'string') return { message: text(detail) };
  if (!detail || typeof detail !== 'object') return {};
  const out = {};
  const code = detail.code ?? detail.error_code_name;
  if (typeof code === 'string') out.code = text(code, 80);
  if (typeof detail.error_code === 'string') out.errorCode = detail.error_code;
  if (typeof detail.run_id === 'string') out.runId = detail.run_id;
  if (typeof detail.message === 'string') out.message = text(detail.message);
  else if (typeof detail.detail === 'string') out.message = text(detail.detail);
  if (detail.required !== undefined) out.required = detail.required;
  if (detail.available !== undefined) out.available = detail.available;
  if (detail.retry_after !== undefined) out.retryAfter = Number(detail.retry_after);
  return out;
}

export function retryAfterSeconds(headers, body, fallback) {
  const header = headers.get('retry-after');
  if (header !== null) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  const poll = Number(body?.poll_after_seconds);
  if (Number.isFinite(poll) && poll >= 0) return poll;
  const retry = Number(body?.detail?.retry_after);
  if (Number.isFinite(retry) && retry >= 0) return retry;
  return fallback;
}

/** Turn a non-2xx answer into a RunError, or return null when the answer proves nothing. */
export function classify(status, headers, body) {
  const d = errorDetail(body);
  const where = `HTTP ${status}${d.code ? ` ${d.code}` : ''}`;
  const location = headers.get('location');
  const runId = d.runId ?? location?.match(/\/v1\/runs\/([0-9a-f]+)/)?.[1];

  if (d.errorCode === 'run_failed' || d.errorCode === 'failed_run_replayed') {
    return new RunError(
      'run_failed',
      `The run failed${runId ? ` (run ${runId})` : ''}: ${where}${d.message ? `, ${d.message}` : ''}. A failed run is final for its idempotency key for 7 days; start a new workflow run (a new attempt gets a new key) or set a different \`idempotency-key\`. Records saved before the failure stay readable at /v1/runs/{run_id}/items.`,
      { status, runId, code: d.code },
    );
  }
  if (status === 401) {
    return new RunError(
      'auth',
      'CleanedWeb rejected the API key (HTTP 401). Check that the secret exists and is passed to `api-key`, that the key was not revoked or expired, and that it was created for this workspace. Secrets are not available to workflows triggered from forks.',
      { status },
    );
  }
  if (status === 403) {
    return new RunError(
      'forbidden',
      'This API key may not run the API (HTTP 403). Use a workspace API key with the `run` scope.',
      { status },
    );
  }
  if (status === 402 || d.code === 'insufficient_units') {
    const amounts =
      d.required !== undefined || d.available !== undefined
        ? ` The run needs ${d.required ?? '?'} Units and the workspace has ${d.available ?? '?'}.`
        : '';
    return new RunError(
      'credit',
      `Not enough credit to run this API (insufficient_units, HTTP ${status}).${amounts} Add credit (${BILLING_URL}) and run again; if a run had started and failed, use a new idempotency key.`,
      { status, runId },
    );
  }
  if (d.code === 'usage_budget_exceeded') {
    return new RunError(
      'budget',
      "The workspace's monthly usage budget cannot cover this run (usage_budget_exceeded, HTTP 409). Ask the workspace Owner to review the Billing settings.",
      { status },
    );
  }
  if (d.code === 'delivery_identity_conflict') {
    return new RunError(
      'conflict',
      'The idempotency key was already used for a different request or endpoint (delivery_identity_conflict, HTTP 409). Use a new `idempotency-key`, or leave it unset so the action derives one.',
      { status },
    );
  }
  if (status === 404) {
    return new RunError(
      'not_found',
      `API, endpoint or delivery not found (HTTP 404${d.code ? ` ${d.code}` : ''}). Check \`api-id\` and \`endpoint-id\` against the live catalog (https://app.cleanedweb.com/api/catalog/apis); the API may have been unpublished or the pinned \`version\` may not exist.`,
      { status },
    );
  }
  if (status === 422) {
    return new RunError(
      'invalid',
      `The API rejected the request (HTTP 422${d.code ? ` ${d.code}` : ''}${d.message ? `: ${d.message}` : ''}). Check \`input\`, \`max-items\` and \`wait-timeout\` against the API's contract.json; unknown inputs are rejected. Do not retry unchanged.`,
      { status, code: d.code },
    );
  }
  if (status === 429) return new RunError('rate_limit', `Rate limited (HTTP 429${d.code ? ` ${d.code}` : ''}).`, { status });
  if (status >= 500 || status === 408) return null; // proves nothing: read /result with the same key
  return new RunError('bad_response', `Unexpected answer: ${where}${d.message ? `, ${d.message}` : ''}.`, { status });
}

async function readJson(response) {
  const raw = await response.text().catch(() => '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {string} p.apiKey
 * @param {string} p.apiId
 * @param {string} p.endpointId
 * @param {string} p.idempotencyKey
 * @param {object} p.input
 * @param {number} [p.maxItems]
 * @param {number} [p.version]
 * @param {number} p.waitTimeout seconds to wait for the run; also the run's own time budget
 * @param {typeof fetch} [p.fetch]
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @param {() => number} [p.now]
 * @param {(line: string) => void} [p.log]
 * @returns {Promise<{ body: object, runId: string | undefined }>}
 */
export async function executeRun(p) {
  const fetchImpl = p.fetch ?? fetch;
  const sleep = p.sleep ?? defaultSleep;
  const now = p.now ?? Date.now;
  const log = p.log ?? (() => {});

  const root = `${p.baseUrl}/v1/catalog/public/apis/${encodeURIComponent(p.apiId)}/endpoints/${encodeURIComponent(p.endpointId)}`;
  const deadline = now() + p.waitTimeout * 1000;
  const waitSeconds = Math.min(90, p.waitTimeout);
  const requestBody = {
    input: p.input,
    ...(p.maxItems !== undefined ? { max_items: p.maxItems } : {}),
    ...(p.version !== undefined ? { version: p.version } : {}),
    // The run's own budget follows the time this step is willing to wait, so a run
    // cannot keep going (and charging) long after the workflow stopped caring.
    timeout_seconds: Math.max(60, p.waitTimeout),
    wait_seconds: waitSeconds,
  };
  const authHeaders = { Authorization: `Bearer ${p.apiKey}`, 'Idempotency-Key': p.idempotencyKey };

  /** @returns {Promise<{status:number, headers:Headers, body:any} | {networkError: string}>} */
  async function send(method) {
    const post = method === 'POST';
    try {
      const response = await fetchImpl(`${root}/${post ? 'run' : 'result'}`, {
        method,
        headers: post ? { ...authHeaders, 'Content-Type': 'application/json' } : authHeaders,
        body: post ? JSON.stringify(requestBody) : undefined,
        redirect: 'error', // a redirect means the wrong origin; nothing ran
        signal: AbortSignal.timeout(post ? (waitSeconds + 30) * 1000 : REQUEST_TIMEOUT_MS),
      });
      return { status: response.status, headers: response.headers, body: await readJson(response) };
    } catch (error) {
      return { networkError: text(error?.cause?.code ?? error?.message ?? error, 120) };
    }
  }

  let next = 'POST';
  let runId;
  let unsure = 0;
  let rateLimited = 0;

  for (;;) {
    if (now() > deadline) {
      throw new RunError(
        'timeout',
        `Stopped waiting after ${p.waitTimeout} seconds (\`wait-timeout\`). ${
          runId ? `The run ${runId} may still be going on the server and ends by itself at its time budget.` : 'The run may have started.'
        } Its result stays readable with the same API key and idempotency key (${p.idempotencyKey}); do not create a new key for it. Records already saved remain charged.`,
        { runId },
      );
    }

    const answer = await send(next);

    if ('networkError' in answer) {
      unsure += 1;
      log(`No usable answer (${answer.networkError}); checking the run with the same idempotency key.`);
      if (unsure > MAX_UNSURE) {
        throw new RunError('unavailable', `CleanedWeb did not answer after ${MAX_UNSURE} attempts (${answer.networkError}). The run may have started: its result stays readable with idempotency key ${p.idempotencyKey}.`, { runId });
      }
      await sleep(Math.min(30_000, 2000 * 2 ** (unsure - 1)));
      next = 'GET';
      continue;
    }

    const { status, headers, body } = answer;

    if (status === 200) {
      if (!body || typeof body !== 'object') throw new RunError('bad_response', 'HTTP 200 without a JSON body.', { status, runId });
      return { body, runId: body.delivery?.runId ?? body.run?.run_id ?? runId };
    }

    if (status === 202) {
      unsure = 0;
      runId = body?.run_id ?? body?.run?.run_id ?? headers.get('location')?.match(/\/v1\/runs\/([0-9a-f]+)/)?.[1] ?? runId;
      const wait = Math.min(retryAfterSeconds(headers, body, 30), Math.max(1, (deadline - now()) / 1000));
      log(`Run ${runId ?? '(id not returned)'} is ${body?.status ?? 'running'}${body?.progress?.items !== undefined ? `, ${body.progress.items} records so far` : ''}; reading the result again in ${Math.ceil(wait)}s.`);
      await sleep(wait * 1000);
      next = 'GET';
      continue;
    }

    // Reading /result with a key the server has never seen: the POST never landed.
    if (next === 'GET' && status === 404 && runId === undefined) {
      unsure += 1;
      if (unsure > MAX_UNSURE) throw new RunError('unavailable', 'The run could not be started: the request never reached CleanedWeb.', {});
      log('The key is unknown to CleanedWeb, so the request did not land; sending it again with the same key.');
      await sleep(Math.min(30_000, 2000 * 2 ** (unsure - 1)));
      next = 'POST';
      continue;
    }

    const error = classify(status, headers, body);
    if (error) {
      if (error.kind === 'rate_limit') {
        rateLimited += 1;
        if (rateLimited > MAX_RATE_LIMITED) {
          throw new RunError('rate_limit', `Rate limited by CleanedWeb (HTTP 429) ${MAX_RATE_LIMITED} times in a row. Run this step less often, or spread the steps out.`, { status });
        }
        const wait = Math.min(retryAfterSeconds(headers, body, 30), 300);
        log(`Rate limited (HTTP 429); waiting ${wait}s (Retry-After) before trying again with the same key.`);
        await sleep(wait * 1000);
        continue; // same step again
      }
      error.runId ??= runId;
      throw error;
    }

    // 5xx/408 without a failed-run marker: unknown outcome, ask for the result.
    unsure += 1;
    log(`HTTP ${status} proves nothing about the run; checking it with the same idempotency key.`);
    if (unsure > MAX_UNSURE) {
      throw new RunError('unavailable', `CleanedWeb answered HTTP ${status} ${MAX_UNSURE} times. The run may have started: its result stays readable with idempotency key ${p.idempotencyKey}.`, { status, runId });
    }
    await sleep(Math.max(retryAfterSeconds(headers, body, 0) * 1000, Math.min(30_000, 2000 * 2 ** (unsure - 1))));
    next = 'GET';
  }
}

/** Accept the result only when the docs say it is usable: summary completed or bounded, scope passed. */
export function acceptResult(body, runId) {
  const summary = body.summary ?? {};
  const run = body.run ?? {};
  const id = body.delivery?.runId ?? run.run_id ?? runId;
  const finished = run.status === undefined || run.status === 'finished';
  const ok = ['completed', 'bounded'].includes(summary.status) && summary.within_scope_passed === true && finished;
  if (!ok) {
    throw new RunError(
      'review',
      `The result needs review and was not written: summary.status is ${summary.status ?? 'missing'}, within_scope_passed is ${summary.within_scope_passed ?? 'missing'}, run.status is ${run.status ?? 'missing'}, stop_reason is ${run.stop_reason ?? 'missing'}${id ? ` (run ${id})` : ''}. HTTP 200 alone does not make a result usable.`,
      { runId: id },
    );
  }
  if (!Array.isArray(body.records)) {
    throw new RunError('bad_response', `The result has no records array${id ? ` (run ${id})` : ''}.`, { runId: id });
  }
  return {
    records: body.records,
    runId: id,
    status: summary.status,
    stopReason: run.stop_reason,
    unitsCharged: run.units_charged,
    summaryRecords: summary.records,
  };
}
