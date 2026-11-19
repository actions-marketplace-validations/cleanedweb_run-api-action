/** Test helpers: a fake @actions/core and a scripted fetch. */
export function fakeCore(inputs = {}) {
  const out = { outputs: {}, info: [], warnings: [], failed: undefined, secrets: [] };
  return {
    out,
    getInput: (name) => inputs[name] ?? '',
    setOutput: (k, v) => {
      out.outputs[k] = v;
    },
    setSecret: (s) => out.secrets.push(s),
    info: (m) => out.info.push(m),
    warning: (m) => out.warnings.push(m),
    setFailed: (m) => {
      out.failed = m;
    },
  };
}

export function reply(status, body, headers = {}) {
  return () =>
    new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

/** A fetch that answers from a queue of reply functions (or thrown errors) and records the calls. */
export function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected request ${init?.method} ${url}`);
    if (step instanceof Error) throw step;
    return step();
  };
  fn.calls = calls;
  return fn;
}

export const okBody = (records, extra = {}) => ({
  records,
  summary: { status: 'completed', within_scope_passed: true, records: records.length },
  run: { run_id: 'a'.repeat(32), status: 'finished', stop_reason: 'source_exhausted', units_charged: records.length },
  delivery: { runId: 'a'.repeat(32), recordCount: records.length },
  ...extra,
});

export const noSleep = () => {
  const sleeps = [];
  const fn = async (ms) => {
    sleeps.push(ms);
  };
  fn.sleeps = sleeps;
  return fn;
};
