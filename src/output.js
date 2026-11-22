// What the user sees: short lines for people (stderr for progress, stdout for results), or one JSON per line.
import { redact } from './config.js';

const useColor = (stream) => stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

export class Reporter {
  constructor({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.json = json;
    this.stdout = stdout;
    this.stderr = stderr;
    const c = useColor(stderr);
    this.c = {
      green: (s) => (c ? `\x1b[32m${s}\x1b[0m` : s),
      red: (s) => (c ? `\x1b[31m${s}\x1b[0m` : s),
      yellow: (s) => (c ? `\x1b[33m${s}\x1b[0m` : s),
      dim: (s) => (c ? `\x1b[2m${s}\x1b[0m` : s),
      bold: (s) => (c ? `\x1b[1m${s}\x1b[0m` : s),
    };
  }

  /** A machine event (--json only): start, job, output, skip, error, summary, data. */
  event(type, data = {}) {
    if (this.json) this.stdout.write(redact(JSON.stringify({ type, ...data })) + '\n');
  }

  /** A line for people about progress (never in --json, which keeps stdout clean). */
  info(text) { if (!this.json) this.stderr.write(redact(text) + '\n'); }

  /** A warning: on stderr in both modes. */
  warn(text) { this.stderr.write(this.c.yellow(redact(`! ${text}`)) + '\n'); }

  /** An error: a JSON event in --json mode, a red line otherwise. */
  error(text, data = {}) {
    if (this.json) this.event('error', { message: redact(text), ...data });
    else this.stderr.write(this.c.red(redact(`✗ ${text}`)) + '\n');
  }

  /** The result of a data command: people get text on stdout, --json gets the object. */
  result(obj, text) {
    if (this.json) this.event('data', { data: obj });
    else this.stdout.write(redact(text) + (text.endsWith('\n') ? '' : '\n'));
  }
}

/** Columns padded to the widest cell. */
export function table(rows) {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? String(cell ?? '') : String(cell ?? '').padEnd(widths[i]))).join('  ').trimEnd()).join('\n') + '\n';
}
