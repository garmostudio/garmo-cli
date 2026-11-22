// Turning arguments into photos, checking them, and naming outputs safely.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_BYTES = 12 * 1024 * 1024;   // STUDIO_UPLOAD_MAX_BYTES
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const hasWildcard = (s) => /[*?]/.test(s);

/** A glob relative path pattern as a RegExp: ** any folders, * and ? within one name. */
export function globToRegExp(pattern) {
  let re = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '');
}

/** Files under dir (no symlinks, no hidden names, never inside skipDir), as paths relative to dir with /. */
function walk(dir, { recursive, skipDir }) {
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (recursive && !(skipDir && path.resolve(childAbs) === skipDir)) visit(childAbs, childRel);
      } else if (e.isFile()) out.push(childRel);
    }
  };
  visit(dir, '');
  return out;
}

/**
 * The photos the arguments name, in order, without duplicates:
 *   a file · a folder (its photos; subfolders with recursive) · a pattern like "shoot/*.jpg" or "**\/*.png" · an https URL.
 * Each item: { kind: 'file', abs, rel } (rel keeps the folder structure for output names) or { kind: 'url', url, rel }.
 * Problems with an argument go to `missing`.
 */
export function expandInputs(args, { recursive = false, outDir = null, cwd = process.cwd() } = {}) {
  const items = [];
  const missing = [];
  const seen = new Set();
  const skipDir = outDir ? path.resolve(cwd, outDir) : null;
  const addFile = (abs, rel) => {
    const key = path.resolve(abs);
    if (seen.has(key)) return;
    if (skipDir && (key === skipDir || key.startsWith(skipDir + path.sep))) return;
    seen.add(key);
    items.push({ kind: 'file', abs: key, rel });
  };
  for (const arg of args) {
    if (/^https?:\/\//i.test(arg)) {
      if (!/^https:\/\//i.test(arg)) { missing.push(`${arg}: only https addresses`); continue; }
      if (seen.has(arg)) continue;
      seen.add(arg);
      let name = 'photo';
      try { name = path.posix.basename(new URL(arg).pathname) || 'photo'; } catch { missing.push(`${arg}: not a valid address`); continue; }
      items.push({ kind: 'url', url: arg, rel: name });
      continue;
    }
    if (hasWildcard(arg)) {
      const norm = arg.replace(/\\/g, '/');
      const parts = norm.split('/');
      const firstWild = parts.findIndex(hasWildcard);
      const baseRel = parts.slice(0, firstWild).join('/');
      const base = path.resolve(cwd, baseRel || '.');
      const rest = parts.slice(firstWild).join('/');
      const re = globToRegExp(rest);
      const deep = rest.includes('**') || rest.includes('/');
      const found = walk(base, { recursive: deep, skipDir }).filter((r) => re.test(r));
      if (found.length === 0) missing.push(`${arg}: no files match`);
      for (const r of found) addFile(path.join(base, r), r);
      continue;
    }
    const abs = path.resolve(cwd, arg);
    let st;
    try { st = fs.statSync(abs); } catch { missing.push(`${arg}: no such file or folder`); continue; }
    if (st.isDirectory()) {
      const found = walk(abs, { recursive, skipDir }).filter((r) => EXTENSIONS.has(path.extname(r).toLowerCase()));
      if (found.length === 0) missing.push(`${arg}: no JPEG, PNG or WebP photos in this folder${recursive ? '' : ' (add -r for subfolders)'}`);
      for (const r of found) addFile(path.join(abs, r), r);
    } else if (st.isFile()) addFile(abs, path.basename(abs));
    else missing.push(`${arg}: not a file`);
  }
  return { items, missing };
}

/** The image type from the first bytes, or null. */
export function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A local photo checked before anything is sent: { ok, reason, type, size }. */
export function checkImage(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (!EXTENSIONS.has(ext)) return { ok: false, reason: 'not a .jpg, .png or .webp file' };
  let size;
  try { size = fs.statSync(abs).size; } catch { return { ok: false, reason: 'cannot be read' }; }
  if (size === 0) return { ok: false, reason: 'empty file' };
  if (size > MAX_BYTES) return { ok: false, reason: `larger than 12 MB (${(size / 1048576).toFixed(1)} MB)` };
  const fd = fs.openSync(abs, 'r');
  const head = Buffer.alloc(12);
  try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
  const type = sniff(head);
  if (!type) return { ok: false, reason: 'not a JPEG, PNG or WebP image (by its content)' };
  return { ok: true, type, size };
}

export function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** [a-z0-9-] only, at most max characters; never empty. */
export function slug(text, max = 80) {
  const s = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return s || 'image';
}

/** A safe file name stem from any name: no separators, no dots, not a Windows device name. */
export function safeStem(name) {
  const base = String(name).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '');
  const s = slug(base, 80);
  return WINDOWS_RESERVED.test(s) ? `${s}-file` : s;
}

/**
 * Where the outputs of one input go, without extension: <out>/<sub folders>/<name>-<tool>-<label>.
 * Throws when the result would leave the output folder (it cannot, but this is checked, not assumed).
 */
export function outputStem(outDir, rel, tool, label) {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  const file = parts.pop() ?? 'photo';
  const dirs = parts.map((d) => safeStem(d));
  const name = `${safeStem(file)}-${slug(tool, 30)}${label ? `-${slug(label, 40)}` : ''}`;
  const root = path.resolve(outDir);
  const full = path.resolve(root, ...dirs, name);
  if (!full.startsWith(root + path.sep)) throw new Error(`Output path escapes ${root}.`);
  return full;
}
