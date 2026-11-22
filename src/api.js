// Talks to https://api.garmo.studio/v1 and nothing else (plus signed file links without the key).
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { VERSION } from './commands.js';
import { redact, maskKey } from './config.js';

export const DEFAULT_BASE = 'https://api.garmo.studio/v1';
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export class ApiError extends Error {
  constructor(status, code, message, requestId = null, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

/**
 * The API address. GARMO_API_BASE is for development only: https://*.garmo.studio or a localhost address,
 * so a stray .env can never send the key to someone else's server.
 */
export function apiBase(env = process.env) {
  const raw = env.GARMO_API_BASE;
  if (!raw) return DEFAULT_BASE;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`GARMO_API_BASE is not a URL: ${raw}`); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const ours = url.protocol === 'https:' && (url.hostname === 'garmo.studio' || url.hostname.endsWith('.garmo.studio'));
  if (!local && !ours) throw new Error('GARMO_API_BASE may only point to https://*.garmo.studio or http://localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('GARMO_API_BASE must be a plain address.');
  return url.href.replace(/\/+$/, '');
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** At most `limit` calls in any 60 seconds (so also in each of the server's calendar minutes). */
export class MinuteWindow {
  constructor(limit, now = () => Date.now()) { this.limit = limit; this.times = []; this.now = now; this.queue = Promise.resolve(); }
  take() {
    const next = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        this.times = this.times.filter((x) => t - x < 60_000);
        if (this.times.length < this.limit) { this.times.push(t); return; }
        await sleep(60_000 - (t - this.times[0]) + 50);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

function retryAfterMs(res, attempt) {
  const header = Number(res?.headers?.get('retry-after'));
  const base = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(60_000, 1000 * 2 ** attempt);
  return Math.min(base, 15 * 60_000) + Math.floor(Math.random() * 400);
}

export class Client {
  /** key: gm_… · base: apiBase() · log(text): verbose lines · fetchImpl: for tests. */
  constructor({ key, base = DEFAULT_BASE, log = null, fetchImpl = globalThis.fetch, maxAttempts = 8, waitScale = 1 }) {
    this.waitScale = waitScale;   // tests shorten every wait
    this.key = key;
    this.base = base;
    this.log = log;
    this.fetch = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.windows = { c: null, r: null };
    this.lowRemaining = false;
  }

  /** Sets the create and read limits once GET /account told them. */
  setLimits(limits) {
    if (limits?.create_requests_per_minute) this.windows.c = new MinuteWindow(limits.create_requests_per_minute);
    if (limits?.read_requests_per_minute) this.windows.r = new MinuteWindow(Math.max(1, Math.floor(limits.read_requests_per_minute * 0.8)));
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.key}`,
      Accept: 'application/json',
      'Garmo-Client': `cli/${VERSION}`,
      'User-Agent': `garmo-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`,
      ...extra,
    };
  }

  /**
   * One API call. form() builds a fresh body for each attempt (a FormData, or undefined).
   * Retries what is safe to retry: rate limits, 503, 409 in progress, network errors, and one 500.
   * A create request is only retried with its Idempotency-Key, so a retry can never start a second job.
   */
  async request(method, path, { form, query, idem, bucket, timeoutMs = 60_000, signal, cancelled } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const retryable = method === 'GET' || Boolean(idem) || path.endsWith('/cancel');
    let served500 = false;
    let uncertain = false;   // an attempt may have reached the server without an answer coming back
    for (let attempt = 1; ; attempt++) {
      const win = this.windows[bucket ?? (method === 'GET' ? 'r' : 'c')];
      if (win) await win.take();
      // Waiting for the rate window can take a minute; a Ctrl+C in that time means this job is not started.
      if (attempt === 1 && cancelled?.()) throw new ApiError(0, 'not_sent', 'Stopped before sending.');
      const headers = this.headers(idem ? { 'Idempotency-Key': idem } : {});
      if (this.log) this.log(`→ ${method} ${url.pathname}${url.search}  Authorization: Bearer ${maskKey(this.key)}${idem ? `  Idempotency-Key: ${idem}` : ''}`);
      let res;
      try {
        res = await this.fetch(url, { method, headers, body: form ? form() : undefined, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (retryable && attempt < this.maxAttempts) {
          this.log?.(`  network error (${redact(error.cause?.code ?? error.message)}), retrying`);
          uncertain = true;
          await sleep(retryAfterMs(null, attempt) * this.waitScale, signal);
          continue;
        }
        throw new ApiError(0, 'network_error', `Could not reach ${url.host}: ${redact(error.cause?.code ?? error.message)}`);
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      this.lowRemaining = Number.isFinite(remaining) && remaining <= 2;
      if (res.status >= 300 && res.status < 400) throw new ApiError(res.status, 'unexpected_redirect', `The API answered with a redirect (${res.status}); refusing to follow it.`);
      let text;
      try { text = await res.text(); } catch (error) {
        // The headers came but the body was cut off: the server may have made the job. Ask again with the same key.
        if (signal?.aborted) throw error;
        if (retryable && attempt < this.maxAttempts) {
          this.log?.('  answer cut off, retrying');
          uncertain = true;
          await sleep(retryAfterMs(null, attempt) * this.waitScale, signal);
          continue;
        }
        throw new ApiError(0, 'network_error', `The answer from ${url.host} was cut off: ${redact(error.cause?.code ?? error.message)}`);
      }
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      this.log?.(`← ${res.status} ${res.headers.get('x-request-id') ?? ''}`);
      if (res.ok) return { status: res.status, body, headers: res.headers, uncertain };

      const err = body?.error ?? {};
      const code = err.code ?? (body === null ? 'bad_response' : 'error');
      const e = new ApiError(res.status, code, redact(err.message ?? `HTTP ${res.status}`), err.request_id ?? res.headers.get('x-request-id'), res.headers.get('retry-after'));
      const again = retryable && attempt < this.maxAttempts && (
        res.status === 429 || res.status === 503 || (res.status === 409 && code === 'idempotency_in_progress')
        || (res.status === 500 && !served500) || res.status === 502 || res.status === 504);
      // A day's file quota will not clear by waiting a minute.
      if (again && !(res.status === 429 && Number(res.headers.get('retry-after')) > 3600)) {
        if (res.status === 500) served500 = true;
        if (res.status >= 500) uncertain = true;
        const wait = retryAfterMs(res, attempt) * this.waitScale;
        this.log?.(`  ${code}, waiting ${Math.round(wait / 1000)} s`);
        await sleep(wait, signal);
        if (signal?.aborted) throw e;
        continue;
      }
      throw e;
    }
  }

  get(path, query, opts = {}) { return this.request('GET', path, { query, ...opts }).then((r) => r.body); }
}

/** Where a signed output link may go: https anywhere, or the local dev server we were pointed at. */
function downloadAllowed(url, base) {
  if (url.protocol === 'https:') return true;
  const b = new URL(base);
  return b.protocol === 'http:' && url.origin === b.origin;
}

/**
 * Moves the finished download into place without ever replacing a file another command put there in the
 * meantime (a hard link fails when the name is taken): then this job's file gets its short code instead.
 */
function place(part, dest, { overwrite, stem, ext, tag }) {
  if (overwrite) { fs.renameSync(part, dest); return dest; }
  for (const target of [dest, `${stem}-${tag ?? 'job'}.${ext}`]) {
    try { fs.linkSync(part, target); fs.unlinkSync(part); return target; }
    catch (error) {
      if (error.code === 'EEXIST') continue;
      // No hard links on this file system: the plain rename is all there is.
      fs.renameSync(part, target); return target;
    }
  }
  fs.unlinkSync(part);   // both names taken by others: keep theirs
  return `${stem}-${tag ?? 'job'}.${ext}`;
}

/**
 * Downloads a finished image without the API key: to `<dest>.part` first, renamed when complete.
 * stem is the file name without extension; the extension comes from the image type. Returns the final path.
 */
export async function download(link, stem, { base = DEFAULT_BASE, fetchImpl = globalThis.fetch, overwrite = false, exists = fs.existsSync, signal, isMine, tag } = {}) {
  let url = new URL(link);
  let res;
  for (let hop = 0; ; hop++) {
    if (!downloadAllowed(url, base)) throw new Error(`Refusing to download from ${url.protocol}//${url.host}: not https.`);
    res = await fetchImpl(url, { headers: { 'User-Agent': `garmo-cli/${VERSION}` }, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < 3) {
      url = new URL(res.headers.get('location'), url);
      await res.body?.cancel();
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}.`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) { await res.body?.cancel(); throw new Error(`Download is not an image (${type || 'no type'}).`); }
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_DOWNLOAD) { await res.body?.cancel(); throw new Error('Download is larger than 50 MB.'); }
  let dest = `${stem}.${ext}`;
  if (!overwrite && exists(dest)) {
    // Without isMine (garmo jobs get) any existing file is kept. With it, a file that is not this job's output
    // (another job, or one that was there before) is never taken for it: this job's file gets a short code instead.
    if (!isMine || isMine(dest)) { await res.body?.cancel(); return { path: dest, skipped: true }; }
    dest = `${stem}-${tag ?? 'job'}.${ext}`;
    if (exists(dest)) { await res.body?.cancel(); return { path: dest, skipped: true }; }
  }
  const part = `${dest}.${process.pid}.part`;   // per process: two commands in one folder never share a half file
  let seen = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      cb(seen > MAX_DOWNLOAD ? new Error('Download is larger than 50 MB.') : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(part, { mode: 0o644 }));
    if (Number.isFinite(length) && length > 0 && seen !== length) throw new Error('Download was cut off.');
    dest = place(part, dest, { overwrite, stem, ext, tag });
  } catch (error) {
    try { fs.unlinkSync(part); } catch { /* already gone */ }
    throw error;
  }
  return { path: dest, skipped: false };
}
