// garmo <command> [photos…] [flags]: argument parsing, the commands, exit codes.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TOOLS, TOOL, OTHER, BATCH_FLAGS, GLOBAL_FLAGS, EXIT, VERSION } from './commands.js';
import { resolveKey, saveKey, deleteKey, checkKey, maskKey, redact, configFile, UsageError, AuthError } from './config.js';
import { Client, ApiError, apiBase } from './api.js';
import { expandInputs, checkImage, sha256File } from './files.js';
import { prepare, runBatch, downloadJob, waitJob } from './batch.js';
import { Reporter, table } from './output.js';

const STUDIO_API = 'https://garmo.studio/studio/#/api';
const DOCS = 'https://garmo.studio/api/docs/cli/';

/* ------------------------------------------------------------------ help */

function flagLine(name, def) {
  const short = def.short ? `-${def.short}, ` : '    ';
  const value = def.kind === 'bool' ? '' : def.enum ? ` <${def.enum.join('|')}>` : def.kind === 'list' ? ' <a,b>' : def.kind === 'int' ? ' <n>' : ' <value>';
  return [`  ${short}--${name}${value}`, def.help];
}

export function helpText(name) {
  const tool = TOOL[name];
  const other = OTHER.find((c) => c.name === name);
  if (tool) {
    return `${tool.summary}\n\nUsage: garmo ${tool.name} <photos…> [flags]\n  photos: files, folders, patterns like "shoot/*.jpg", https URLs, or - to read a list from stdin\n\n`
      + `Flags:\n${table(Object.entries(tool.flags).map(([n, d]) => flagLine(n, d)))}\n`
      + `Batch flags:\n${table(Object.entries(BATCH_FLAGS).map(([n, d]) => flagLine(n, d)))}\n`
      + `Examples:\n${tool.examples.map((e) => `  ${e}`).join('\n')}\n\nDocs: ${DOCS}\n`;
  }
  if (other) {
    return `${other.summary}\n\nUsage: ${other.usage}\n` + (other.flags ? `\nFlags:\n${table(Object.entries(other.flags).map(([n, d]) => flagLine(n, d)))}` : '') + `\nDocs: ${DOCS}\n`;
  }
  return `garmo ${VERSION}: AI edits for whole folders of product photos, from the terminal.\nSpends API credits (buy a pack at ${STUDIO_API}).\n\n`
    + `Usage: garmo <command> [photos…] [flags]\n\nTools:\n${table(TOOLS.map((t) => [`  ${t.name}`, t.summary]))}\n`
    + `Account and jobs:\n${table(OTHER.map((c) => [`  ${c.name}`, c.summary]))}\n`
    + `Flags for every command:\n${table(Object.entries(GLOBAL_FLAGS).map(([n, d]) => flagLine(n, d)))}\n`
    + `Start:\n  npx @garmo/cli login\n  npx @garmo/cli remove-bg ./products/ -o ./clean/\n\n`
    + `The key: GARMO_API_KEY, --key-file, or what \`garmo login\` saved (${configFile()}).\n`
    + `Exit codes: 0 all done · 1 some photos failed · 2 usage · 3 key or access · 4 out of credits\n\n`
    + `garmo help <command> for its flags. Docs: ${DOCS}\n`;
}

/* ------------------------------------------------------------------ parsing */

function parseOptions(defs) {
  const options = {};
  for (const [name, d] of Object.entries(defs)) {
    options[name] = { type: d.kind === 'bool' ? 'boolean' : 'string', ...(d.short ? { short: d.short } : {}), ...(d.kind === 'images' ? { multiple: true } : {}) };
  }
  return options;
}

/** Checks and converts one flag value against its definition. */
export function convertFlag(name, def, raw) {
  if (raw === undefined) return undefined;
  if (def.kind === 'bool' || def.kind === 'images' || def.kind === 'image') return raw;
  const v = String(raw).trim();
  if (v === '') throw new UsageError(`--${name} needs a value.`);
  switch (def.kind) {
    case 'int': {
      if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number.`);
      const n = Number(v);
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) throw new UsageError(`--${name} must be between ${def.min} and ${def.max}.`);
      return n;
    }
    case 'hex': {
      const h = v.startsWith('#') ? v : `#${v}`;
      if (!/^#[0-9a-fA-F]{6}$/.test(h)) throw new UsageError(`--${name} must be a color like "#c8553d".`);
      return h.toLowerCase();
    }
    case 'list': {
      const items = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
      if (items.length === 0) throw new UsageError(`--${name} needs at least one id.`);
      if (def.enum) for (const x of items) if (!def.enum.includes(x)) throw new UsageError(`Unknown ${name} "${x}". Allowed: ${def.enum.join(', ')}.`);
      return items;
    }
    default: {
      if (def.enum && !def.enum.includes(v)) throw new UsageError(`--${name} must be one of: ${def.enum.join(', ')}.`);
      if (def.max && v.length > def.max) throw new UsageError(`--${name} may be up to ${def.max} characters.`);
      return v;
    }
  }
}

function parse(argv, defs) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: parseOptions(defs), allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message.replace(/\. To specify a positional argument.*$/s, '.'));
  }
  const values = {};
  for (const [name, def] of Object.entries(defs)) values[name] = convertFlag(name, def, parsed.values[name]);
  return { values, positionals: parsed.positionals };
}

/* ------------------------------------------------------------------ helpers */

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 1_000_000) reject(new UsageError('stdin is too long.')); });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Reads a line without showing it (for the key). */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) { reject(new UsageError('No terminal to ask in. Use: echo "$GARMO_KEY" | garmo login --with-token')); return; }
    process.stderr.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); return; }
        if (ch === '\u0003') { done(); reject(new UsageError('Canceled.')); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    const done = () => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    input.on('data', onData);
  });
}

function ask(question) {
  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d).trim().toLowerCase()); });
  });
}

function makeClient(g, reporter, { required = true } = {}) {
  const found = resolveKey({ keyFile: g['key-file'], warn: (m) => reporter.warn(m) });
  if (!found) {
    if (!required) return null;
    throw new AuthError(`No API key. Run \`garmo login\`, or set GARMO_API_KEY. Get a key at ${STUDIO_API}`);
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') reporter.warn('NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks; your key could be read on the way. Unset it.');
  const base = apiBase();
  if (base !== 'https://api.garmo.studio/v1') reporter.warn(`Using GARMO_API_BASE ${base}`);
  return new Client({ key: found.key, base, log: g.verbose ? (m) => process.stderr.write(redact(m) + '\n') : null });
}

/** A path as people want to read it: relative when inside the current folder. */
const shown = (p) => { const r = path.relative(process.cwd(), p); return r === '' ? '.' : r.startsWith('..') || path.isAbsolute(r) ? p : r; };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ commands */

async function cmdLogin(argv, reporter) {
  const { values } = parse(argv, { ...GLOBAL_FLAGS, 'with-token': { kind: 'bool' } });
  if (process.env.GARMO_API_KEY) reporter.warn('GARMO_API_KEY is set; it wins over the key saved here.');
  reporter.info(`Make a key at ${STUDIO_API} (gm_live_… spends credits, gm_test_… is free and makes sample images).`);
  const raw = values['with-token'] ? (await readStdin()).trim() : await readHidden('API key: ');
  const key = checkKey(raw, 'That');
  const client = new Client({ key, base: apiBase() });
  let account = null;
  try {
    account = await client.get('/account');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'api_not_enabled') {
      reporter.warn('The key works, but live keys need an API pack before they can make images.');
    } else throw error;
  }
  const file = saveKey(key);
  reporter.event('login', { key: maskKey(key), mode: key.startsWith('gm_test_') ? 'test' : 'live', file });
  reporter.info(`${reporter.c.green('✓')} Saved ${maskKey(key)} to ${file}${account ? ` · ${account.api_credits} API credits` : ''}`);
  return EXIT.ok;
}

async function cmdLogout(argv, reporter) {
  parse(argv, GLOBAL_FLAGS);
  const had = deleteKey();
  reporter.event('logout', { deleted: had });
  reporter.info(had ? `Deleted the key saved in ${configFile()}.` : 'No key was saved on this computer.');
  reporter.info(`The key still works until you revoke it at ${STUDIO_API}.`);
  return EXIT.ok;
}

async function cmdAccount(name, argv, reporter) {
  const { values } = parse(argv, GLOBAL_FLAGS);
  const client = makeClient(values, reporter);
  const a = await client.get('/account');
  if (name === 'credits') {
    reporter.result({ api_credits: a.api_credits, livemode: a.livemode }, `${a.api_credits} API credits${a.livemode ? '' : ' (test key: jobs are free)'}`);
    return EXIT.ok;
  }
  const l = a.limits ?? {};
  reporter.result(a, table([
    ['Key', `${a.key?.name || 'unnamed'} (starts ${String(a.key?.prefix ?? '').replace(/^gm_(live|test)_/, '')}…)`],
    ['Mode', a.livemode ? 'live' : 'test (free, sample images)'],
    ['Tier', a.tier ?? '-'],
    ['API credits', a.api_credits],
    ['Limits', `${l.concurrent_images} images at once · ${l.create_requests_per_minute} new jobs/min · ${l.read_requests_per_minute} reads/min`],
  ]));
  return EXIT.ok;
}

async function cmdCatalog(kind, argv, reporter) {
  const { values } = parse(argv, GLOBAL_FLAGS);
  const client = makeClient(values, reporter);
  const list = await client.get(`/catalog/${kind}`);
  const rows = list.data.map((x) => (kind === 'models' ? [x.id, x.name, x.gender, x.custom ? 'yours' : ''] : [x.id, x.name, x.description ?? '']));
  reporter.result(list.data, table(rows));
  return EXIT.ok;
}

async function cmdJobs(argv, reporter) {
  const def = OTHER.find((c) => c.name === 'jobs').flags;
  const { values, positionals } = parse(argv, { ...GLOBAL_FLAGS, ...def });
  const client = makeClient(values, reporter);
  if (positionals.length === 0) {
    const list = await client.get('/jobs', { limit: values.limit, status: values.status });
    reporter.result(list.data, table([['ID', 'TOOL', 'STATUS', 'IMAGES', 'CREDITS', 'CREATED'], ...list.data.map((j) => [j.id, j.tool, j.status, j.outputs.length, j.credits_charged - j.credits_refunded, j.created_at])]));
    return EXIT.ok;
  }
  let code = EXIT.ok;
  for (const id of positionals) {
    let job = await client.get(`/jobs/${encodeURIComponent(id)}`);
    if (!values.download) {
      reporter.result(job, `${job.id}  ${job.tool}  ${job.status}  ${plural(job.outputs.length, 'image')}  ${job.credits_charged - job.credits_refunded} credits\n`
        + table(job.outputs.map((o) => [`  ${o.id}`, o.status, o.label, o.error?.code ?? ''])));
      continue;
    }
    if (job.status === 'processing') { reporter.info(`${job.id} is still rendering; waiting…`); job = await waitJob(client, job.id); }
    const out = path.resolve(values.out ?? 'garmo-out');
    const { files, failed } = await downloadJob(job, { outDir: out, rel: job.id, toolName: job.tool, base: client.base, overwrite: values.overwrite, reporter });
    reporter.event('job', { job_id: job.id, status: job.status, outputs: files, failed_outputs: failed });
    reporter.info(`${files.length ? reporter.c.green('✓') : reporter.c.red('✗')} ${job.id} → ${files.map(shown).join(', ') || 'nothing to download'}`);
    if (failed.length) { code = EXIT.partial; for (const f of failed) reporter.error(`${job.id} ${f.id}: ${f.message}`); }
  }
  return code;
}

async function cmdCancel(argv, reporter) {
  const { values, positionals } = parse(argv, GLOBAL_FLAGS);
  if (positionals.length === 0) throw new UsageError('Give the job id: garmo cancel job_…');
  const client = makeClient(values, reporter);
  for (const id of positionals) {
    const job = await client.request('POST', `/jobs/${encodeURIComponent(id)}/cancel`).then((r) => r.body);
    reporter.result(job, `${job.id}: ${job.status} · ${job.credits_refunded} credits refunded`);
  }
  return EXIT.ok;
}

/** An image flag value (scene photo, pose photo, back photos): https URLs or local files, checked. */
async function resolveExtras(tool, values) {
  const extras = {};
  for (const [flag, def] of Object.entries(tool.flags)) {
    if (def.kind !== 'image' && def.kind !== 'images') continue;
    const raw = values[flag];
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    if (def.max && list.length > def.max) throw new UsageError(`--${flag} takes up to ${def.max} photos.`);
    extras[flag] = [];
    for (const v of list) {
      if (/^https:\/\//i.test(v)) { extras[flag].push({ kind: 'url', url: v }); continue; }
      if (/^http:\/\//i.test(v)) throw new UsageError(`--${flag}: only https addresses.`);
      const abs = path.resolve(v);
      const c = checkImage(abs);
      if (!c.ok) throw new UsageError(`--${flag} ${v}: ${c.reason}.`);
      extras[flag].push({ kind: 'file', abs, type: c.type, sha: await sha256File(abs) });
    }
  }
  return extras;
}

async function cmdTool(tool, argv, reporter, signals) {
  const { values, positionals } = parse(argv, { ...GLOBAL_FLAGS, ...BATCH_FLAGS, ...tool.flags });
  for (const [flag, def] of Object.entries(tool.flags)) {
    if (def.required && values[flag] === undefined) throw new UsageError(`${tool.name} needs --${flag}. See: garmo help ${tool.name}`);
    if (def.needs && values[flag] !== undefined && values[def.needs] === undefined) throw new UsageError(`--${flag} only works together with --${def.needs}.`);
  }
  const problem = tool.check?.(values);
  if (problem) throw new UsageError(`${tool.name}: ${problem}.`);
  if (tool.images(values) < 1) throw new UsageError(`${tool.name}: this would make no images.`);

  let args = positionals;
  if (args.includes('-')) {
    const list = (await readStdin()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    args = args.flatMap((a) => (a === '-' ? list : [a]));
  }
  if (args.length === 0) throw new UsageError(`Give photos: garmo ${tool.name} <files, folders, "patterns" or https URLs>`);

  const outDir = path.resolve(values.out ?? 'garmo-out');
  const { items, missing } = expandInputs(args, { recursive: values.recursive, outDir });
  for (const m of missing) reporter.warn(m);
  if (items.length === 0) throw new UsageError('No photos to send.');
  const extras = await resolveExtras(tool, values);

  const client = makeClient(values, reporter, { required: !values['dry-run'] });
  let account = null;
  if (client) {
    account = await client.get('/account');
    client.setLimits(account.limits);
  }
  const test = account ? !account.livemode : false;
  const { tasks, invalid } = await prepare(tool, values, items, extras, { skuFromName: values['sku-from-name'], test, scope: account ? `${client.base}|${account.account_id ?? ''}|${account.livemode ? 'live' : 'test'}` : '' });
  for (const x of invalid) reporter.warn(`${x.file}: ${x.reason}, skipped`);

  const credits = tasks.reduce((s, t) => s + t.credits, 0);
  const images = tasks.reduce((s, t) => s + t.images, 0);
  const balance = account?.api_credits;
  const keyCap = account?.limits?.concurrent_images ?? 2;
  const cap = Math.min(values.concurrency ?? keyCap, keyCap);
  const filesPerPhoto = 1 + Object.values(extras).reduce((s, l) => s + l.filter((x) => x.kind === 'file' || x.kind === 'url').length, 0);
  const dayFiles = tasks.length * filesPerPhoto;
  if (test && dayFiles > 50) reporter.warn(`Test keys can send 50 files a day; this run sends ${dayFiles}. The rest will stop with a "try tomorrow" error.`);
  if (!test && dayFiles > 2000) reporter.warn(`An account can send 2,000 files a day; this run sends ${dayFiles}.`);

  const plan = `${plural(tasks.length, 'photo')} · ${plural(images, 'image')} · ${test ? 'test key, free' : `~${plural(credits, "credit")}`}${balance !== undefined && !test ? ` · balance ${balance} → ${balance - credits}` : ''}`;
  reporter.event('plan', { photos: tasks.length, images, credits, balance: balance ?? null, invalid, test, concurrency: cap, out: outDir });

  if (values['dry-run']) {
    reporter.info(`Dry run, nothing sent. ${plan}`);
    for (const t of tasks) reporter.info(`  ${t.item.rel}${t.item.kind === 'url' ? ` (${t.item.url})` : ''}`);
    if (!client) reporter.info('(No key, so no balance. Run `garmo login`.)');
    else if (!test && credits > balance) reporter.warn(`Your balance (${balance}) is short of ~${credits}; the run would stop when it runs out. Buy credits at ${STUDIO_API}`);
    return invalid.length || missing.length ? EXIT.partial : EXIT.ok;
  }
  if (tasks.length === 0) { reporter.error('Nothing to send.'); return EXIT.partial; }

  if (!test && !values.yes && (credits > 20 || credits > balance * 0.5)) {
    const short = credits > balance ? ` Your balance covers about ${balance}; the run stops when it runs out.` : '';
    if (!process.stdin.isTTY || values.json) {
      reporter.error(`This run takes ~${credits} credits.${short} Add --yes to run it without asking.`);
      return EXIT.usage;
    }
    const answer = await ask(`${plan}.${short} Go ahead? [y/N] `);
    if (!['y', 'yes', 'e', 'evet'].includes(answer)) { reporter.info('Nothing sent.'); return EXIT.ok; }
  }

  reporter.info(`${plan} · ${cap} at once → ${shown(outDir)}`);
  signals.onFirst = () => reporter.warn('Stopping: no new jobs. Jobs already rendering finish and download (their credits are spent). Ctrl+C again to quit now; run the same command later to pick them up.');
  const summary = await runBatch({ client, tool, tasks, outDir, reporter, cap, noWait: values['no-wait'], overwrite: values.overwrite, stop: signals.stop, signal: signals.abort.signal });
  return report(summary, { reporter, invalid, missing, outDir, tool, values, test });
}

function report(s, { reporter, invalid, missing = [], outDir, values }) {
  const pending = s.pending;
  reporter.event('summary', {
    accepted: s.started.length, done: s.done.length, failed: s.failed.length, skipped: s.skipped.length, invalid: invalid.length, missing: missing.length, not_started: s.notStarted.length,
    still_rendering: pending.map((p) => p.job_id), credits_charged: s.credits, credits_refunded: s.refunded, halted: s.halt ?? null, out: outDir,
  });
  const parts = [`${s.done.length} done`];
  if (s.skipped.length) parts.push(`${s.skipped.length} already done`);
  if (s.failed.length) parts.push(`${s.failed.length} failed`);
  if (invalid.length) parts.push(`${invalid.length} not photos`);
  if (missing.length) parts.push(`${missing.length} not found`);
  if (s.notStarted.length) parts.push(`${s.notStarted.length} not started`);
  if (pending.length) parts.push(`${pending.length} still rendering`);
  reporter.info(`\n${parts.join(' · ')} · ${plural(s.credits - s.refunded, 'credit')} spent`);
  if (pending.length) reporter.info(`Rendering: ${pending.map((p) => p.job_id).join(' ')}\nRun the same command again to download them${values['no-wait'] ? ' (it starts nothing new for these photos)' : ''}.`);
  if (s.halt === 'credits') { reporter.error(`Out of API credits; ${plural(s.notStarted.length, 'photo')} not started. Buy credits at ${STUDIO_API}, then run the same command again.`); return EXIT.credits; }
  if (s.halt === 'auth') { reporter.error(`${s.fatal?.message ?? 'The key was refused.'}`); return EXIT.auth; }
  if (s.halt === 'quota') { reporter.error(s.fatal?.message ?? 'Daily file limit reached.'); return EXIT.partial; }
  if (s.halt === 'interrupted' || s.notStarted.length) { reporter.info('Run the same command again to continue where it stopped.'); return EXIT.partial; }
  // With --no-wait a job still rendering is the expected state (accepted, paid, collected by the next run).
  return s.failed.length || invalid.length || missing.length || (pending.length && !values['no-wait']) ? EXIT.partial : EXIT.ok;
}

/* ------------------------------------------------------------------ main */

export async function main(argv) {
  const json = argv.includes('--json');
  const reporter = new Reporter({ json });
  const [name, ...rest] = argv;
  const signals = { stop: { requested: false }, abort: new AbortController(), onFirst: null };
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) { signals.stop.requested = true; signals.onFirst?.(); if (!signals.onFirst) process.exit(130); return; }
    reporter.warn('Quit. Jobs keep rendering on Garmo; run the same command again to download them without paying again.');
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    if (!name || name === '--help' || name === '-h') { process.stdout.write(helpText()); return name ? EXIT.ok : EXIT.usage; }
    if (name === '--version' || name === '-v') { process.stdout.write(`${VERSION}\n`); return EXIT.ok; }
    if (name === 'help') { process.stdout.write(helpText(rest[0])); return EXIT.ok; }
    if (rest.includes('--help') || rest.includes('-h')) { process.stdout.write(helpText(name)); return EXIT.ok; }
    if (TOOL[name]) return await cmdTool(TOOL[name], rest, reporter, signals);
    switch (name) {
      case 'login': return await cmdLogin(rest, reporter);
      case 'logout': return await cmdLogout(rest, reporter);
      case 'whoami': case 'credits': return await cmdAccount(name, rest, reporter);
      case 'models': case 'scenes': case 'poses': return await cmdCatalog(name, rest, reporter);
      case 'jobs': return await cmdJobs(rest, reporter);
      case 'cancel': return await cmdCancel(rest, reporter);
      default: {
        const near = [...TOOLS.map((t) => t.name), ...OTHER.map((c) => c.name)].find((n) => n.startsWith(name.slice(0, 3)));
        throw new UsageError(`Unknown command "${name}".${near ? ` Did you mean ${near}?` : ''} See: garmo --help`);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) { reporter.error(error.message); return EXIT.usage; }
    if (error instanceof AuthError) { reporter.error(error.message); return EXIT.auth; }
    if (error instanceof ApiError) {
      reporter.error(`${error.message}${error.requestId ? ` (${error.requestId})` : ''}`, { code: error.code, status: error.status, request_id: error.requestId });
      if (error.status === 401) reporter.info(`Check the key, or make a new one at ${STUDIO_API}`);
      if (error.status === 401 || error.status === 403) return EXIT.auth;
      if (error.status === 402) return EXIT.credits;
      return error.status === 400 || error.status === 404 ? EXIT.usage : EXIT.partial;
    }
    reporter.error(error?.message ?? String(error));
    if (process.env.GARMO_DEBUG) process.stderr.write(redact(error?.stack ?? '') + '\n');
    return EXIT.partial;
  } finally {
    process.off('SIGINT', onSigint);
  }
}
