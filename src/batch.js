// Many photos through one tool: never a second job (and charge) for the same photo and settings,
// resumable after Ctrl+C or a crash, and within the key's limits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError, download } from './api.js';
import { checkImage, sha256File, outputStem, slug } from './files.js';

export const STATE_FILE = '.garmo-run.json';
const POLL_MS = 4000;
const LOCK_HOST = crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
const FILE_WAIT = new Int32Array(new SharedArrayBuffer(4));

/* ------------------------------------------------------------------ state file */

/** .garmo-run.json in the output folder: per photo + settings (its Idempotency-Key) the job and the files written. */
export class RunState {
  constructor(outDir) {
    this.file = path.join(outDir, STATE_FILE);
    this.data = { version: 1, entries: {} };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (loaded?.version === 1 && loaded.entries && typeof loaded.entries === 'object') this.data = loaded;
    } catch { /* new run */ }
  }
  get(idem) { return this.data.entries[idem] ?? null; }
  set(idem, patch) {
    // Another command may share this folder. Under a lock: read the file again, change only our own entry, write it
    // back. Neither command can then lose the other's jobs, whatever the timing.
    this.locked(() => {
      let entries = this.data.entries;
      try {
        const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (disk?.version === 1 && disk.entries && typeof disk.entries === 'object') entries = disk.entries;
      } catch { /* first write, or unreadable: keep what we have */ }
      this.data.entries = entries;
      this.data.entries[idem] = { ...(entries[idem] ?? {}), ...patch, updated_at: new Date().toISOString() };
      this.save();
    });
  }
  /** One writer at a time. Only a contender that removes the dead owner's unique marker can remove the lock. */
  locked(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const owner = path.join(lock, `${LOCK_HOST}-${process.pid}-${crypto.randomUUID()}`);
    const until = performance.now() + 15_000;
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (error) {
        if (error.code !== 'EEXIST' && !windowsFileBusy(error)) throw error;
      }
      if (performance.now() >= until) throw new Error(`Timed out waiting to write ${this.file}. If no Garmo command is using this folder, remove ${lock} and try again.`);
      if (clearDeadLock(lock)) continue;
      waitForFile();
    }
    try {
      retryWindowsFile(() => fs.mkdirSync(owner));
      try { return fn(); } finally { retryWindowsFile(() => fs.rmdirSync(owner)); }
    } finally {
      retryWindowsFile(() => fs.rmdirSync(lock));
    }
  }
  /** Written to a temporary file and renamed, so a crash never leaves a broken state file. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1) + '\n');
    retryWindowsFile(() => fs.renameSync(tmp, this.file));
  }
}

const windowsFileBusy = (error) => process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
const waitForFile = () => Atomics.wait(FILE_WAIT, 0, 0, 10 + Math.floor(Math.random() * 20));

/** Windows can briefly deny access while another process closes a handle to the file or directory. */
function retryWindowsFile(operation) {
  const until = performance.now() + 2_000;
  for (;;) {
    try { return operation(); } catch (error) {
      if (!windowsFileBusy(error) || performance.now() >= until) throw error;
      waitForFile();
    }
  }
}

function clearDeadLock(lock) {
  let entries;
  try { entries = fs.readdirSync(lock); } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (windowsFileBusy(error)) return false;
    throw error;
  }
  // An empty directory can belong to a writer that is about to publish its marker, including older CLI versions.
  if (entries.length !== 1) return false;
  const match = /^([a-f0-9]{16})-([1-9]\d*)-[a-f0-9-]{36}$/.exec(entries[0]);
  if (match?.[1] !== LOCK_HOST) return false;
  try { process.kill(Number(match[2]), 0); return false; } catch (error) {
    if (error.code !== 'ESRCH') return false;
  }
  try { fs.rmdirSync(path.join(lock, entries[0])); } catch (error) {
    if (error.code === 'ENOENT' || windowsFileBusy(error)) return false;
    throw error;
  }
  retryWindowsFile(() => fs.rmdirSync(lock));
  return true;
}

/* ------------------------------------------------------------------ requests */

const normHex = (v) => { const h = String(v).trim().toLowerCase(); return h.startsWith('#') ? h : `#${h}`; };

/**
 * The form fields and files one photo is sent with. Everything is deterministic: the same photo and settings
 * always give the same fields, so the same Idempotency-Key matches the server's fingerprint of the request.
 * opts: parsed tool flags. extras: { flagName: [{ kind: 'url', url } | { kind: 'file', abs, type, sha }] }.
 */
export function buildRequest(tool, opts, item, extras = {}, { skuFromName = false, scope = '' } = {}) {
  const fields = {};
  const files = [];
  for (const [flag, def] of Object.entries(tool.flags)) {
    const v = opts[flag];
    if (v === undefined || v === null || v === '' || v === false) continue;
    switch (def.kind) {
      case 'string': fields[def.param] = String(v); break;
      case 'int': fields[def.param] = String(v); break;
      case 'bool': fields[def.param] = 'true'; break;
      case 'list': fields[def.param] = v.join(','); break;
      case 'hex': fields[def.param] = normHex(v); break;
      case 'image':
      case 'images': {
        const list = extras[flag] ?? [];
        const urls = list.filter((x) => x.kind === 'url').map((x) => x.url);
        if (urls.length) fields[def.kind === 'image' ? def.param : `${def.param}[]`] = def.kind === 'image' ? urls[0] : urls;
        for (const x of list.filter((y) => y.kind === 'file')) files.push({ field: def.file, abs: x.abs, type: x.type, sha: x.sha, name: `${def.file.replace(/\W/g, '')}.${x.type.split('/')[1].replace('jpeg', 'jpg')}` });
        break;
      }
      default: throw new Error(`unknown flag kind ${def.kind}`);
    }
  }
  if (skuFromName) fields.metadata = JSON.stringify({ sku: item.rel.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '').slice(0, 200) });
  if (item.kind === 'url') fields.image_url = item.url;
  else files.unshift({ field: 'image', abs: item.abs, type: item.type, sha: item.sha, name: `photo.${item.type.split('/')[1].replace('jpeg', 'jpg')}` });
  const sorted = Object.keys(fields).sort().map((k) => [k, fields[k]]);
  const idem = 'cli-' + crypto.createHash('sha256').update(JSON.stringify([tool.path, sorted, files.map((f) => [f.field, f.sha]), scope])).digest('hex').slice(0, 40);
  return { fields, files, idem };
}

/** A fresh multipart body for each attempt (a body can be read once). */
export function formFactory({ fields, files }) {
  return () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) for (const x of v) fd.append(k, x);
      else fd.append(k, v);
    }
    for (const f of files) fd.append(f.field, f.blob, f.name);
    return fd;
  };
}

/* ------------------------------------------------------------------ capacity */

/** Images rendering at once, across all jobs of this run. */
export class Slots {
  constructor(cap) { this.cap = cap; this.used = 0; this.waiting = []; }
  acquire(n) {
    return new Promise((resolve) => { this.waiting.push({ n, resolve }); this.pump(); });
  }
  release(n) { this.used = Math.max(0, this.used - n); this.pump(); }
  pump() {
    while (this.waiting.length && this.used + this.waiting[0].n <= this.cap) {
      const w = this.waiting.shift();
      this.used += w.n;
      w.resolve();
    }
  }
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/* ------------------------------------------------------------------ downloads */

/** Output file stems for a job's outputs: by label, made unique. */
function stemsFor(job, outDir, rel, toolName) {
  const used = new Set();
  return job.outputs.map((o, i) => {
    let label = o.label ? slug(o.label, 40) : `${i + 1}`;
    if (used.has(label)) label = `${label}-${i + 1}`;
    used.add(label);
    return outputStem(outDir, rel, toolName, label);
  });
}

/** Downloads every succeeded output of a finished job. Returns { files, failed: [{ id, code, message }] }. */
export async function downloadJob(job, { outDir, rel, toolName, base, overwrite, fetchImpl, reporter, signal, isMine, tag }) {
  const stems = stemsFor(job, outDir, rel, toolName);
  const files = [];
  const failed = [];
  for (const [i, o] of job.outputs.entries()) {
    if (o.status !== 'succeeded' || !o.url) {
      failed.push({ id: o.id, code: o.error?.code ?? o.status, message: o.error?.message ?? `output ${o.status}` });
      continue;
    }
    fs.mkdirSync(path.dirname(stems[i]), { recursive: true });
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await download(o.url, stems[i], { base, overwrite, fetchImpl, signal, isMine, tag });
        files.push(r.path);
        reporter?.event('output', { job_id: job.id, output_id: o.id, label: o.label, path: r.path, skipped: r.skipped });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) break;
        await sleep(1500 * attempt, signal);
      }
    }
    if (lastError) failed.push({ id: o.id, code: 'download_failed', message: lastError.message });
  }
  return { files, failed };
}

/** Polls a job until it is no longer processing. */
export async function waitJob(client, jobId, { signal, done } = {}) {
  for (;;) {
    const job = await client.get(`/jobs/${encodeURIComponent(jobId)}`, undefined, { signal });
    if (job.status !== 'processing') return job;
    if (done?.()) return job;
    await sleep((client.lowRemaining ? POLL_MS * 2 : POLL_MS) * (client.waitScale ?? 1), signal);
    if (signal?.aborted) return job;
  }
}

/* ------------------------------------------------------------------ the run */

/**
 * Prepares every input: checks local files (free, no network), hashes them, builds the request.
 * Returns { tasks, invalid } where each task has item, request, images, credits.
 */
export async function prepare(tool, opts, items, extras, { skuFromName, test, scope = '' }) {
  const tasks = [];
  const invalid = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const c = checkImage(item.abs);
      if (!c.ok) { invalid.push({ file: item.rel, reason: c.reason }); continue; }
      item.type = c.type;
      item.size = c.size;
      item.sha = await sha256File(item.abs);
    }
    const request = buildRequest(tool, opts, item, extras, { skuFromName, scope });
    tasks.push({ item, request, images: tool.images(opts), credits: test ? 0 : tool.credits(opts) });
  }
  // The same photo twice with the same settings is one job, so one task.
  const seen = new Set();
  tasks.splice(0, tasks.length, ...tasks.filter((t) => (seen.has(t.request.idem) ? false : seen.add(t.request.idem))));
  // Two different jobs must never write the same file: a.jpg and a.png, or "a b.png" and "a_b.png" (same safe name).
  // The first pass keeps the extension, the second adds a short code from the job's own key.
  const stemKey = (t) => t.item.rel.replace(/\.[^./\\]*$/, '').toLowerCase();
  const count = (keyOf) => { const m = new Map(); for (const t of tasks) m.set(keyOf(t), (m.get(keyOf(t)) ?? 0) + 1); return m; };
  const byStem = count(stemKey);
  for (const t of tasks) if (byStem.get(stemKey(t)) > 1) t.item.rel = t.item.rel.replace(/\.([^./\\]*)$/, '-$1');
  const safeKey = (t) => outputStem('/out', t.item.rel, tool.name, '').toLowerCase();
  const bySafe = count(safeKey);
  for (const t of tasks) if (bySafe.get(safeKey(t)) > 1) t.item.rel = t.item.rel.replace(/(\.[^./\\]*)?$/, `-${t.request.idem.slice(4, 10)}$1`);
  return { tasks, invalid };
}

/**
 * Runs the tasks. stop: { requested } set by Ctrl+C (no new jobs; running ones finish and download).
 * Returns a summary: { done, failed, skipped, started, notStarted, credits, fatal }.
 */
export async function runBatch({ client, tool, tasks, outDir, reporter, cap, noWait = false, overwrite = false, stop = { requested: false }, signal, fetchImpl }) {
  const state = new RunState(outDir);
  const slots = new Slots(cap);
  const summary = { done: [], failed: [], skipped: [], started: [], pending: [], notStarted: [], credits: 0, refunded: 0, fatal: null };
  let halt = null;   // 'credits' | 'auth' | 'quota': stop starting new jobs
  let creating = tasks.length;

  const finishJob = async (task, job) => {
    const { item } = task;
    state.set(task.request.idem, { job_id: job.id, status: job.status });
    // Only jobs this run started count as spending; a job the server handed back (same Idempotency-Key) was paid before.
    if (task.isNew) summary.refunded += job.credits_refunded ?? 0;
    // A file already there only counts as this job's if the state file says so; otherwise the new file gets a short code.
    const mine = (abs) => (state.get(task.request.idem)?.outputs ?? []).some((f) => path.resolve(outDir, f) === path.resolve(abs));
    const { files, failed } = await downloadJob(job, { outDir, rel: item.rel, toolName: tool.name, base: client.base, overwrite, fetchImpl, reporter, signal, isMine: mine, tag: task.request.idem.slice(4, 10) });
    const rel = files.map((f) => path.relative(outDir, f));
    state.set(task.request.idem, { status: failed.length === 0 ? 'done' : 'partial', outputs: rel });
    reporter.event('job', { file: item.rel, job_id: job.id, status: job.status, outputs: files, failed_outputs: failed, credits_charged: job.credits_charged ?? 0, credits_refunded: job.credits_refunded ?? 0 });
    if (failed.length === 0) {
      summary.done.push({ file: item.rel, job_id: job.id, outputs: files });
      reporter.info(`${reporter.c.green('✓')} ${item.rel} → ${rel.join(', ') || '(nothing)'}`);
    } else {
      summary.failed.push({ file: item.rel, job_id: job.id, outputs: files, errors: failed, retry: job.status === 'failed' });
      reporter.info(`${reporter.c.red('✗')} ${item.rel}: ${failed.map((f) => `${f.id} ${f.code}`).join(', ')}${files.length ? ` (saved ${rel.join(', ')})` : ''}`);
    }
  };

  const runOne = async (task) => {
    const { item, request } = task;
    const known = state.get(request.idem);

    // Finished before: skip without any request, as long as its files are still there.
    if (known?.status === 'done' && !overwrite && (known.outputs ?? []).length > 0 && known.outputs.every((f) => fs.existsSync(path.join(outDir, f)))) {
      summary.skipped.push({ file: item.rel, job_id: known.job_id, reason: 'already done' });
      reporter.event('skip', { file: item.rel, job_id: known.job_id, reason: 'already done' });
      reporter.info(reporter.c.dim(`- ${item.rel}: already done (${known.outputs.join(', ')})`));
      creating--;
      return;
    }
    if (task.images > cap) {
      creating--;
      summary.failed.push({ file: item.rel, errors: [{ code: 'too_many_images', message: `makes ${task.images} images at once; this key allows ${cap}` }] });
      reporter.error(`${item.rel}: makes ${task.images} images at once, and this key renders up to ${cap} at a time. Ask for fewer.`, { file: item.rel });
      return;
    }

    await slots.acquire(task.images);
    let job = null;
    // Each new job after a failed one gets its own key (…-r1, -r2), saved before it is sent, so a lost answer
    // is asked again with that same key and still makes one job.
    let attempt = known?.attempt ?? 0;
    const idemOf = (a) => (a ? `${request.idem}-r${a}` : request.idem);
    try {
      let fresh = !known?.job_id;
      if (!fresh) {
        // Started before (this run was interrupted): look at that job, never start another while it can still deliver.
        job = await client.get(`/jobs/${encodeURIComponent(known.job_id)}`, undefined, { signal });
        if (job.status === 'failed') {
          // Every image of it failed and was refunded: running the command again is how people retry, so start a new job.
          reporter.info(reporter.c.dim(`↻ ${item.rel}: ${job.id} failed (refunded), trying again`));
          reporter.event('retry', { file: item.rel, previous_job_id: job.id });
          attempt++;
          job = null;
          fresh = true;
        } else creating--;
      }
      if (fresh) {
        if (halt || stop.requested) {
          creating--;
          summary.notStarted.push({ file: item.rel, reason: halt ?? 'interrupted' });
          return;
        }
        try {
          for (const f of request.files) f.blob ??= await fs.openAsBlob(f.abs, { type: f.type });
          state.set(request.idem, { file: item.rel, sha256: item.sha ?? null, status: 'creating', attempt, job_id: null, outputs: [] });
          const res = await client.request('POST', tool.path, { form: formFactory(request), idem: idemOf(attempt), bucket: 'c', timeoutMs: 300_000, signal, cancelled: () => Boolean(halt || stop.requested) });
          job = res.body;
          // 202 = made by this request. 200 after a lost answer = made by an earlier attempt of this same request (paid now).
          task.isNew = res.status === 202 || (res.status === 200 && res.uncertain && known?.status !== 'creating');
          if (task.isNew) summary.credits += job.credits_charged ?? 0;   // charged when the job is accepted, finished or not
        } finally {
          creating--;
        }
        state.set(request.idem, { job_id: job.id, status: job.status });
        summary.started.push({ file: item.rel, job_id: job.id });
        reporter.event('start', { file: item.rel, job_id: job.id, credits_charged: job.credits_charged ?? 0 });
        reporter.info(reporter.c.dim(`… ${item.rel}: ${job.id} started`));
      }
      if (job.status === 'processing') {
        if (noWait) {
          // Keep the slot until this job finishes or nothing else needs to start.
          job = await waitJob(client, job.id, { signal, done: () => creating <= 0 || halt || stop.requested });
          if (job.status === 'processing') { summary.pending.push({ file: item.rel, job_id: job.id }); return; }
        } else {
          job = await waitJob(client, job.id, { signal });
          if (job.status === 'processing') { summary.pending.push({ file: item.rel, job_id: job.id }); return; }   // aborted
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_sent') {
        summary.notStarted.push({ file: item.rel, reason: halt ?? 'interrupted' });
        state.set(request.idem, { status: 'not_started' });
        return;
      }
      if (error instanceof ApiError) {
        if (error.status === 402) halt ??= 'credits';
        else if (error.status === 401 || error.status === 403) { halt ??= 'auth'; summary.fatal ??= error; }
        else if (error.status === 429 && Number(error.retryAfter) > 3600) { halt ??= 'quota'; summary.fatal ??= error; }
        if (error.status === 402 || halt === 'auth' || halt === 'quota') {
          if (!job) summary.notStarted.push({ file: item.rel, reason: halt, message: error.message });
          if (!job) state.set(request.idem, { status: 'not_started' });
          return;
        }
        const detail = { code: error.code, message: error.message, request_id: error.requestId };
        summary.failed.push({ file: item.rel, job_id: job?.id, errors: [detail] });
        state.set(request.idem, { status: job ? 'started' : 'failed', error: error.code });
        reporter.error(`${item.rel}: ${error.message}${error.requestId ? ` (${error.requestId})` : ''}`, { file: item.rel, ...detail });
        return;
      }
      if (signal?.aborted) return;
      summary.failed.push({ file: item.rel, job_id: job?.id, errors: [{ code: 'error', message: error.message }] });
      reporter.error(`${item.rel}: ${error.message}`, { file: item.rel });
      return;
    } finally {
      slots.release(task.images);
    }
    if (noWait) {
      // Finished while we were waiting for room: fetch it now, since it is there.
      if (job.status !== 'processing') await finishJob(task, job);
      return;
    }
    await finishJob(task, job);
  };

  await Promise.all(tasks.map((t) => runOne(t)));
  if (halt) summary.halt = halt;
  return summary;
}
