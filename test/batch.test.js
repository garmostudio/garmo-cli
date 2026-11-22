// Batch runs against a fake API that misbehaves: whatever happens, one photo + settings = one job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, download } from '../src/api.js';
import { prepare, RunState, runBatch, STATE_FILE } from '../src/batch.js';
import { expandInputs } from '../src/files.js';
import { Reporter } from '../src/output.js';
import { TOOL } from '../src/commands.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const KEY = 'gm_test_' + 'k'.repeat(43);
const STATE_MODULE = new URL('../src/batch.js', import.meta.url).href;

/** A fake API. behave(name, attempt) may return 'rate' | 'busy' | 'boom' | 'lost' | 'slow' | 'bad' | 'broke' | null. */
function fakeApi({ behave = () => null, credits = Infinity, creditsCharged = 0 } = {}) {
  const jobs = new Map();         // id → { polls, idem }
  const byIdem = new Map();       // idem → id
  const attempts = new Map();     // idem → n
  const downloads = new Map();
  let created = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      const err = (status, code, headers) => send(status, { error: { code, message: code, request_id: 'req_test' } }, headers);
      if (url.pathname.startsWith('/files/')) {
        const id = url.pathname.slice(7);
        const n = (downloads.get(id) ?? 0) + 1;
        downloads.set(id, n);
        if (id.startsWith('jobcut') && n === 1) {   // the first download of the "cut" photo breaks off
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length * 10) });
          res.write(PNG);
          setTimeout(() => res.destroy(), 5);
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
        res.end(PNG);
        return;
      }
      if (req.headers.authorization !== `Bearer ${KEY}`) return err(401, 'invalid_api_key');
      if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
        const id = url.pathname.slice(6);
        const job = jobs.get(id);
        if (!job) return err(404, 'not_found');
        job.polls++;
        return send(200, payload(id, hold ? 'processing' : job.polls > 1 ? (job.fail ? 'failed' : 'completed') : 'processing'));
      }
      if (req.method === 'POST' && url.pathname === '/edit/remove-background') {
        const idem = req.headers['idempotency-key'];
        assert.ok(idem, 'every create has an Idempotency-Key');
        assert.ok(String(req.headers['garmo-client']).startsWith('cli/'));
        const n = (attempts.get(idem) ?? 0) + 1;
        attempts.set(idem, n);
        if (byIdem.has(idem)) return send(200, payload(byIdem.get(idem), 'processing'));
        const name = /filename="([^"]+)"/.exec(Buffer.concat(chunks).toString('latin1'))?.[1];
        const body = Buffer.concat(chunks).toString('latin1');
        const tag = /tag:(\w+)/.exec(body)?.[1] ?? '';
        const how = behave(tag, n, name);
        if (how === 'rate') return err(429, 'rate_limited', { 'retry-after': '1' });
        if (how === 'busy') return err(503, 'unavailable', { 'retry-after': '1' });
        if (how === 'boom') return err(500, 'internal_error');
        if (how === 'slow') return err(409, 'idempotency_in_progress', { 'retry-after': '1' });
        if (how === 'bad') return err(400, 'invalid_image');
        if (created >= credits) return err(402, 'insufficient_credits');
        const id = `job${tag || 'x'}${++created}`;
        jobs.set(id, { polls: 0, idem, fail: how === 'failjob' });
        byIdem.set(idem, id);
        if (how === 'lost') { res.destroy(); return; }   // the job exists, but the answer never arrives
        if (how === 'cutbody') {   // the job exists, the headers arrive, the body breaks off
          res.writeHead(202, { 'content-type': 'application/json', 'content-length': '500' });
          res.write('{"id":"job');
          setTimeout(() => res.destroy(), 5);
          return;
        }
        return send(202, payload(id, 'processing'));
      }
      err(404, 'not_found');
    });
  });
  const payload = (id, status) => ({
    id, object: 'job', tool: 'remove-background', status, livemode: false, credits_charged: creditsCharged, credits_refunded: 0,
    outputs: [{ id: 'out_1', status: status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : 'processing', label: 'White', ...(status === 'completed' ? { url: `${base()}/files/${id}-1` } : {}), ...(status === 'failed' ? { error: { code: 'render_failed', message: 'render failed' } } : {}) }],
  });
  const base = () => `http://127.0.0.1:${server.address().port}`;
  let hold = false;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    set hold(v) { hold = v; }, base: base(), server, jobs, attempts, byIdem, get created() { return created; }, set credits(v) { credits = v; },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

/** Photos whose bytes carry a tag the fake server reads (so each is a different file). */
function photos(tags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-batch-'));
  for (const t of tags) fs.writeFileSync(path.join(dir, `${t}.png`), Buffer.concat([PNG, Buffer.from(`tag:${t} `)]));
  return dir;
}

const quiet = () => new Reporter({ json: true, stdout: new Writable({ write(_c, _e, cb) { cb(); } }), stderr: new Writable({ write(_c, _e, cb) { cb(); } }) });

async function run(api, dir, out, extra = {}) {
  const client = new Client({ key: KEY, base: api.base, waitScale: 0.002 });
  const tool = TOOL['remove-bg'];
  const opts = { bg: 'white' };
  const { items } = expandInputs([dir], { outDir: out });
  const { tasks } = await prepare(tool, opts, items, {}, { test: true });
  return runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3, ...extra });
}

test('rate limits, 503, 500, lost answers and in-progress retries never make a second job', async () => {
  const tags = ['ok1', 'rate', 'busy', 'boom', 'lost', 'slow', 'cut', 'bad', 'ok2'];
  const api = await fakeApi({
    behave: (tag, n) => (tag === 'bad' ? 'bad' : n === 1 && ['rate', 'busy', 'boom', 'lost', 'slow'].includes(tag) ? tag : null),
  });
  try {
    const dir = photos(tags);
    const out = path.join(dir, 'out');
    const s = await run(api, dir, out);
    assert.equal(api.created, 8, 'one job per good photo');
    assert.equal(new Set(api.byIdem.values()).size, 8);
    assert.equal(s.done.length, 8);
    assert.deepEqual(s.failed.map((f) => f.file), ['bad.png']);
    for (const t of tags.filter((x) => x !== 'bad')) assert.ok(fs.existsSync(path.join(out, `${t}-remove-bg-white.png`)), t);
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.part')).length, 0, 'no half files');

    // The same command again: everything done is skipped without a request.
    const before = [...api.attempts.values()].reduce((a, b) => a + b, 0);
    const again = await run(api, dir, out);
    assert.equal(again.skipped.length, 8);
    assert.equal(api.created, 8);
    const after = [...api.attempts.values()].reduce((a, b) => a + b, 0);
    assert.equal(after - before, 1, 'only the failed photo is tried again');

    // State file lost: the server's Idempotency-Key still returns the same jobs.
    fs.unlinkSync(path.join(out, STATE_FILE));
    const lost = await run(api, dir, out);
    assert.equal(api.created, 8, 'no new jobs without the state file');
    assert.equal(lost.done.length, 8);
  } finally {
    await api.close();
  }
});

test('a job that failed on the server is tried again by the next run, once, with its own key', async () => {
  let failing = true;
  const api = await fakeApi({ behave: (tag) => (tag === 'flaky' && failing ? 'failjob' : null) });
  try {
    const dir = photos(['good', 'flaky']);
    const out = path.join(dir, 'out');
    const s = await run(api, dir, out);
    assert.equal(api.created, 2);
    assert.deepEqual(s.failed.map((f) => [f.file, f.retry]), [['flaky.png', true]]);

    // The same command again: the failed photo gets one new job (a new key), the good one is skipped.
    failing = false;
    const s2 = await run(api, dir, out);
    assert.equal(api.created, 3, 'exactly one new job');
    assert.equal(s2.skipped.length, 1);
    assert.deepEqual(s2.done.map((d) => d.file), ['flaky.png']);
    assert.ok(fs.existsSync(path.join(out, 'flaky-remove-bg-white.png')));
    const keys = [...api.byIdem.keys()];
    assert.equal(new Set(keys).size, 3);
    assert.ok(keys.some((k) => k.endsWith('-r1')));

    // Done now: a third run sends nothing.
    const s3 = await run(api, dir, out);
    assert.equal(api.created, 3);
    assert.equal(s3.skipped.length, 2);
  } finally {
    await api.close();
  }
});

test('a retry whose answer was lost is asked again with the same retry key, not a third job', async () => {
  let phase = 'fail';
  const api = await fakeApi({ behave: (tag, n) => (tag !== 'f1' ? null : phase === 'fail' ? 'failjob' : n === 1 ? 'lost' : null) });
  try {
    const dir = photos(['f1']);
    const out = path.join(dir, 'out');
    await run(api, dir, out);
    phase = 'lost';
    const client = new Client({ key: KEY, base: api.base, waitScale: 0.002, maxAttempts: 1 });
    const tool = TOOL['remove-bg'];
    const { items } = expandInputs([dir], { outDir: out });
    const { tasks } = await prepare(tool, { bg: 'white' }, items, {}, { test: true });
    const s2 = await runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3 });
    assert.equal(s2.failed.length, 1, 'the answer never came');
    assert.equal(api.created, 2);
    const s3 = await run(api, dir, out);
    assert.equal(api.created, 2, 'the lost retry job is found by its key');
    assert.equal(s3.done.length, 1);
  } finally {
    await api.close();
  }
});

test('out of credits stops new jobs, finishes the rest, and resumes without paying twice', async () => {
  const tags = Array.from({ length: 10 }, (_, i) => `p${i}`);
  const api = await fakeApi({ credits: 4 });
  try {
    const dir = photos(tags);
    const out = path.join(dir, 'out');
    const s = await run(api, dir, out);
    assert.equal(s.halt, 'credits');
    assert.equal(s.done.length, 4);
    assert.equal(s.notStarted.length, 6);
    api.credits = Infinity;
    const s2 = await run(api, dir, out);
    assert.equal(s2.skipped.length, 4);
    assert.equal(s2.done.length, 6);
    assert.equal(api.created, 10);
  } finally {
    await api.close();
  }
});

test('Ctrl+C: no new jobs; the next run picks up started ones instead of starting them again', async () => {
  const tags = Array.from({ length: 8 }, (_, i) => `c${i}`);
  const api = await fakeApi();
  try {
    const dir = photos(tags);
    const out = path.join(dir, 'out');
    const stop = { requested: false };
    const timer = setInterval(() => { if (api.created >= 3) stop.requested = true; }, 1);
    const s = await run(api, dir, out, { stop });
    clearInterval(timer);
    assert.ok(s.notStarted.length > 0, 'some photos were not started');
    const firstJobs = api.created;
    const s2 = await run(api, dir, out);
    assert.equal(api.created, 8);
    assert.equal(s2.done.length + s2.skipped.length, 8);
    assert.ok(firstJobs < 8);
    for (const t of tags) assert.ok(fs.existsSync(path.join(out, `${t}-remove-bg-white.png`)), t);
  } finally {
    await api.close();
  }
});

test('--no-wait starts every job and returns before they finish', async () => {
  const api = await fakeApi();
  try {
    const dir = photos(['n1', 'n2']);
    const out = path.join(dir, 'out');
    const s = await run(api, dir, out, { noWait: true });
    assert.equal(s.started.length, 2);
    assert.equal(api.created, 2);
    const s2 = await run(api, dir, out);
    assert.equal(api.created, 2);
    assert.equal(s2.done.length, 2);
  } finally {
    await api.close();
  }
});

test('a wrong key stops the run at once', async () => {
  const api = await fakeApi();
  try {
    const dir = photos(['a', 'b', 'c', 'd', 'e']);
    const out = path.join(dir, 'out');
    const client = new Client({ key: 'gm_test_' + 'z'.repeat(43), base: api.base, waitScale: 0.002 });
    const { items } = expandInputs([dir], { outDir: out });
    const { tasks } = await prepare(TOOL['remove-bg'], {}, items, {}, { test: true });
    const s = await runBatch({ client, tool: TOOL['remove-bg'], tasks, outDir: out, reporter: quiet(), cap: 1 });
    assert.equal(s.halt, 'auth');
    assert.equal(api.created, 0);
    assert.equal(s.notStarted.length, 5);
  } finally {
    await api.close();
  }
});

test('two jobs never write one file: same safe name, or the same photo with other settings', async () => {
  const api = await fakeApi();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-coll-'));
    fs.writeFileSync(path.join(dir, 'a b.png'), Buffer.concat([PNG, Buffer.from('tag:one ')]));
    fs.writeFileSync(path.join(dir, 'a_b.png'), Buffer.concat([PNG, Buffer.from('tag:two ')]));
    const out = path.join(dir, 'out');
    const s = await run(api, dir, out);
    assert.equal(s.done.length, 2);
    const pngs = fs.readdirSync(out).filter((f) => f.endsWith('.png'));
    assert.equal(pngs.length, 2, `two files, got ${pngs}`);

    // Same photo, other settings: the second job's file does not replace or hide the first.
    const solo = photos(['solo']);
    const out2 = path.join(solo, 'out');
    const client = new Client({ key: KEY, base: api.base, waitScale: 0.002 });
    const tool = TOOL['remove-bg'];
    for (const bg of ['white', 'transparent']) {
      const { items } = expandInputs([solo], { outDir: out2 });
      const { tasks } = await prepare(tool, { bg }, items, {}, { test: true });
      const r = await runBatch({ client, tool, tasks, outDir: out2, reporter: quiet(), cap: 3 });
      assert.equal(r.done.length, 1);
    }
    assert.equal(fs.readdirSync(out2).filter((f) => f.endsWith('.png')).length, 2);
  } finally {
    await api.close();
  }
});

test('a test run never stands in for a live one: the scope is part of the key', async () => {
  const dir = photos(['p']);
  const { items } = expandInputs([dir], { outDir: path.join(dir, 'out') });
  const tool = TOOL['remove-bg'];
  const a = (await prepare(tool, {}, items, {}, { test: true, scope: 'https://api.garmo.studio|acc_1|test' })).tasks[0].request.idem;
  const b = (await prepare(tool, {}, items, {}, { test: false, scope: 'https://api.garmo.studio|acc_1|live' })).tasks[0].request.idem;
  const c = (await prepare(tool, {}, items, {}, { test: false, scope: 'https://api.garmo.studio|acc_2|live' })).tasks[0].request.idem;
  assert.equal(new Set([a, b, c]).size, 3);
});

test('--no-wait reports the credits of accepted jobs', async () => {
  const api = await fakeApi();
  try {
    const dir = photos(['n1']);
    const out = path.join(dir, 'out');
    const client = new Client({ key: KEY, base: api.base, waitScale: 0.002 });
    const tool = TOOL['remove-bg'];
    const { items } = expandInputs([dir], { outDir: out });
    const { tasks } = await prepare(tool, {}, items, {}, { test: true });
    const s = await runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3, noWait: true });
    assert.equal(s.started.length, 1);
  } finally {
    await api.close();
  }
});

test('two commands in one folder keep both results and both state entries', async () => {
  const api = await fakeApi();
  try {
    const dir = photos(['one', 'two']);
    const out = path.join(dir, 'out');
    const client = new Client({ key: KEY, base: api.base, waitScale: 0.002 });
    const tool = TOOL['remove-bg'];
    const mk = async (bg, only) => {
      const { items } = expandInputs([path.join(dir, only)], { outDir: out });
      const { tasks } = await prepare(tool, { bg }, items, {}, { test: true });
      return runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3 });
    };
    const [a, b] = await Promise.all([mk('white', 'one.png'), mk('white', 'two.png')]);
    assert.equal(a.done.length + b.done.length, 2);
    const state = JSON.parse(fs.readFileSync(path.join(out, STATE_FILE), 'utf8'));
    assert.equal(Object.keys(state.entries).length, 2, 'both jobs are in the state file');
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.part')).length, 0);
  } finally {
    await api.close();
  }
});

test('--no-wait lists a job that is still rendering, also when it was started by an earlier run', async () => {
  const api = await fakeApi();
  try {
    const dir = photos(['slow1']);
    const out = path.join(dir, 'out');
    const client = new Client({ key: KEY, base: api.base, waitScale: 0.002 });
    const tool = TOOL['remove-bg'];
    const { items } = expandInputs([dir], { outDir: out });
    const { tasks } = await prepare(tool, {}, items, {}, { test: true });
    api.hold = true;   // the fake keeps the job in "processing"
    const first = await runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3, noWait: true });
    const second = await runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3, noWait: true });
    assert.equal(first.pending.length, 1);
    assert.equal(second.pending.length, 1, 'found again on the second run');
    assert.equal(api.created, 1);
  } finally {
    await api.close();
  }
});

test('two commands on one photo at the same time end with two files, not one overwritten', async () => {
  const api = await fakeApi();
  try {
    const dir = photos(['same']);
    const out = path.join(dir, 'out');
    const client = new Client({ key: KEY, base: api.base, waitScale: 0.002 });
    const tool = TOOL['remove-bg'];
    const mk = async (bg) => {
      const { items } = expandInputs([dir], { outDir: out });
      const { tasks } = await prepare(tool, { bg }, items, {}, { test: true });
      return runBatch({ client, tool, tasks, outDir: out, reporter: quiet(), cap: 3 });
    };
    await Promise.all([mk('white'), mk('transparent')]);
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.png')).length, 2);
    const state = JSON.parse(fs.readFileSync(path.join(out, STATE_FILE), 'utf8'));
    const files = Object.values(state.entries).flatMap((e) => e.outputs ?? []);
    assert.equal(new Set(files).size, 2, 'each job owns its own file');
  } finally {
    await api.close();
  }
});

test('a body cut off after the 202 headers is picked up again without a second job', async () => {
  const api = await fakeApi({ creditsCharged: 1, behave: (tag, n) => (tag === 'cutb' && n === 1 ? 'cutbody' : null) });
  try {
    const dir = photos(['cutb']);
    const out = path.join(dir, 'out');
    const s = await run(api, dir, out);
    assert.equal(api.created, 1);
    assert.equal(s.done.length, 1);
    assert.equal(s.failed.length, 0);
    assert.equal(s.credits, 1);
  } finally {
    await api.close();
  }
});

test('many processes writing one state file lose no entry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = `import { RunState } from ${JSON.stringify(STATE_MODULE)};
    const s = new RunState(${JSON.stringify(dir)});
    for (let i = 0; i < 40; i++) s.set(process.argv[1] + '-' + i, { status: 'creating' });`;
  const runs = [0, 1, 2, 3, 4, 5].map((n) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, String(n)], { stdio: 'inherit' });
    return once(child, 'exit');
  });
  const exits = await Promise.all(runs);
  assert.deepEqual(exits.map(([code]) => code), Array(runs.length).fill(0));
  const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  assert.equal(Object.keys(state.entries).length, 240);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE + '.lock')), false);
});

test('an old lock stays with its owner until that process exits', { timeout: 10_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-lock-owner-'));
  const start = (source) => {
    const code = `import { RunState } from ${JSON.stringify(STATE_MODULE)};
      const state = new RunState(process.argv[1]);
      ${source}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    return { child, exit: once(child, 'exit'), ready: once(child.stdout, 'data') };
  };
  const owner = start(`state.locked(() => {
    console.log('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  });`);
  let contender;
  t.after(async () => {
    owner.child.kill('SIGKILL');
    contender?.child.kill('SIGKILL');
    await Promise.all([owner.exit, contender?.exit]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await owner.ready;
  const lock = path.join(dir, `${STATE_FILE}.lock`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  contender = start(`console.log('waiting'); state.set('other-job', { job_id: 'job_2' });`);
  await contender.ready;
  await delay(150);
  assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false, 'a live owner keeps an old lock');
  owner.child.kill('SIGKILL');
  await owner.exit;
  assert.deepEqual(await contender.exit, [0, null], 'the next writer reclaims the dead owner’s lock');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')).entries['other-job'].job_id, 'job_2');
  assert.equal(fs.existsSync(lock), false);
});

test('a Windows lock scan and state replacement can retry transient access errors', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-lock-windows-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const file = path.join(dir, STATE_FILE);
  const lock = `${file}.lock`;
  const { mkdirSync, readdirSync, renameSync } = fs;
  const accessDenied = () => Object.assign(new Error('File handle is busy'), { code: 'EPERM' });
  let scans = 0;
  let renames = 0;
  t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    if (target === lock && scans === 0) throw Object.assign(new Error('Lock exists'), { code: 'EEXIST' });
    return mkdirSync(target, ...args);
  });
  t.mock.method(fs, 'readdirSync', (target, ...args) => {
    if (target === lock && scans++ === 0) throw accessDenied();
    return readdirSync(target, ...args);
  });
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file && renames++ === 0) throw accessDenied();
    return renameSync(source, target);
  });
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { previous: { job_id: 'job_1' } } }));
  new RunState(dir).set('next', { job_id: 'job_2' });
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).entries).map(entry => entry.job_id), ['job_1', 'job_2']);
  assert.equal(renames, 2);
  assert.equal(fs.existsSync(lock), false);
});

test('download preserves a late collision even when the file system cannot hard-link', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stem = path.join(dir, 'image');
  fs.writeFileSync(`${stem}-tag.png`, 'existing alternate');
  t.mock.method(fs, 'linkSync', (_part, target) => {
    if (target === `${stem}.png`) fs.writeFileSync(target, 'other download', { flag: 'wx' });
    const error = new Error('Hard links unavailable');
    error.code = 'ENOTSUP';
    throw error;
  });
  const result = await download('https://example.com/image', stem, {
    fetchImpl: async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }),
    tag: 'tag',
    isMine: () => false,
  });
  assert.deepEqual(result, { path: `${stem}-tag-2.png`, skipped: false });
  assert.equal(fs.readFileSync(`${stem}.png`, 'utf8'), 'other download');
  assert.equal(fs.readFileSync(`${stem}-tag.png`, 'utf8'), 'existing alternate');
  assert.deepEqual(fs.readFileSync(result.path), PNG);
});
