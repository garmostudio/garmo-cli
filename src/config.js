// Where the API key comes from, and how it is kept on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEY_PATTERN = /^gm_(live|test)_[A-Za-z0-9]{43}$/;

export class UsageError extends Error {}
export class AuthError extends Error {}

/** ~/.config/garmo (or $XDG_CONFIG_HOME/garmo), %APPDATA%\garmo on Windows. */
export function configDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'garmo');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'garmo');
}

export function configFile(env = process.env, platform = process.platform) {
  return path.join(configDir(env, platform), 'config.json');
}

/** gm_live_…a3f9: what screens show of a key. */
export function maskKey(key) {
  const m = /^(gm_(?:live|test)_)\w*?(\w{4})$/.exec(key);
  return m ? `${m[1]}…${m[2]}` : 'gm_…';
}

/** Any key in a text (an error, a stack) is masked before it is printed. */
export function redact(text) {
  return String(text).replace(/gm_(live|test)_[A-Za-z0-9]+/g, (k) => maskKey(k));
}

/** Checks the shape locally, so a mistyped password is never sent anywhere. */
export function checkKey(key, from) {
  const k = String(key ?? '').trim();
  if (!KEY_PATTERN.test(k)) throw new AuthError(`${from} does not hold a Garmo API key (gm_live_… or gm_test_… with 43 characters after it).`);
  return k;
}

/** Tightens a file or folder that others can read; returns true when it had to. */
function tighten(file, mode, warn) {
  if (process.platform === 'win32') return false;
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(file, mode);
      warn?.(`${file} could be read by other users; its permissions are now ${mode.toString(8)}.`);
      return true;
    }
  } catch { /* missing: nothing to tighten */ }
  return false;
}

/**
 * The key to use: GARMO_API_KEY, then --key-file, then the saved config.
 * Returns { key, source } or null when there is none.
 */
export function resolveKey({ env = process.env, keyFile, warn } = {}) {
  if (env.GARMO_API_KEY) return { key: checkKey(env.GARMO_API_KEY, 'GARMO_API_KEY'), source: 'GARMO_API_KEY' };
  if (keyFile) {
    let text;
    try { text = fs.readFileSync(keyFile, 'utf8'); } catch { throw new UsageError(`Cannot read --key-file ${keyFile}.`); }
    return { key: checkKey(text, `--key-file ${keyFile}`), source: keyFile };
  }
  const file = configFile(env);
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!saved?.key) return null;
  tighten(path.dirname(file), 0o700, warn);
  tighten(file, 0o600, warn);
  return { key: checkKey(saved.key, file), source: file };
}

/** Writes the key with 0600 in a 0700 folder, through a temporary file so a crash never leaves half a file. */
export function saveKey(key, env = process.env) {
  const file = configFile(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ key }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  tighten(file, 0o600);
  return file;
}

/** Deletes the saved key; true when there was one. */
export function deleteKey(env = process.env) {
  try { fs.unlinkSync(configFile(env)); return true; } catch { return false; }
}
