import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slug, safeStem, outputStem, globToRegExp, sniff, expandInputs, checkImage } from '../src/files.js';
import { maskKey, redact, checkKey, saveKey, resolveKey, configFile } from '../src/config.js';
import { apiBase } from '../src/api.js';
import { buildRequest } from '../src/batch.js';
import { convertFlag } from '../src/main.js';
import { TOOL } from '../src/commands.js';

const KEY = 'gm_live_' + 'a'.repeat(39) + 'a3f9';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('slug and safe names', () => {
  assert.equal(slug('White · shadow'), 'white-shadow');
  assert.equal(slug('Çanta Ön'), 'canta-on');
  assert.equal(slug('../../etc'), 'etc');
  assert.equal(slug(''), 'image');
  assert.equal(slug('x'.repeat(200)).length, 80);
  assert.equal(safeStem('CON.jpg'), 'con-file');
  assert.equal(safeStem('a/b\\..\\nul.png'), 'nul-file');
  assert.equal(safeStem('Dress 01.JPG'), 'dress-01');
});

test('outputs never leave the output folder', () => {
  const out = path.join(os.tmpdir(), 'garmo-out-test');
  for (const rel of ['../../x.jpg', '/etc/passwd', '..\\..\\win.jpg', 'a/../../b.jpg', '....//x.jpg']) {
    const stem = outputStem(out, rel, 'remove-bg', '../label');
    assert.ok(stem.startsWith(out + path.sep), `${rel} → ${stem}`);
  }
  assert.equal(outputStem(out, 'shoes/red.jpg', 'upscale', '4K'), path.join(out, 'shoes', 'red-upscale-4k'));
});

test('glob patterns', () => {
  assert.ok(globToRegExp('*.jpg').test('a.jpg'));
  assert.ok(!globToRegExp('*.jpg').test('sub/a.jpg'));
  assert.ok(globToRegExp('**/*.png').test('a/b/c.png'));
  assert.ok(globToRegExp('**/*.png').test('c.png'));
  assert.ok(globToRegExp('img-?.webp').test('img-1.webp'));
  assert.ok(!globToRegExp('a.jpg').test('aXjpg'));
});

test('image sniffing and checks', () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniff(PNG), 'image/png');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniff(Buffer.from('<?php echo 1;')), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-'));
  fs.writeFileSync(path.join(dir, 'fake.jpg'), 'not an image');
  fs.writeFileSync(path.join(dir, 'ok.png'), PNG);
  assert.equal(checkImage(path.join(dir, 'fake.jpg')).ok, false);
  assert.equal(checkImage(path.join(dir, 'ok.png')).type, 'image/png');
});

test('folders: no hidden files, no symlinks, not the output folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-'));
  fs.writeFileSync(path.join(dir, 'a.png'), PNG);
  fs.writeFileSync(path.join(dir, '.hidden.png'), PNG);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.png'), PNG);
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'a-remove-bg.png'), PNG);
  fs.symlinkSync(dir, path.join(dir, 'loop'));
  const flat = expandInputs([dir], { outDir: path.join(dir, 'out') }).items.map((i) => i.rel);
  assert.deepEqual(flat, ['a.png']);
  const deep = expandInputs([dir], { recursive: true, outDir: path.join(dir, 'out') }).items.map((i) => i.rel);
  assert.deepEqual(deep, ['a.png', 'sub/b.png']);
  const glob = expandInputs(['**/*.png'], { cwd: dir, outDir: path.join(dir, 'out') }).items.map((i) => i.rel);
  assert.deepEqual(glob, ['a.png', 'sub/b.png']);
  assert.equal(expandInputs(['http://x.test/a.jpg']).missing.length, 1);
  assert.equal(expandInputs(['https://x.test/a.jpg']).items[0].kind, 'url');
});

test('keys are masked everywhere and checked before sending', () => {
  assert.equal(maskKey(KEY), 'gm_live_…a3f9');
  assert.ok(!redact(`Error: Bearer ${KEY} failed`).includes('aaaa'));
  assert.throws(() => checkKey('hunter2', 'That'));
  assert.throws(() => checkKey('gm_live_short', 'That'));
  assert.equal(checkKey(` ${KEY}\n`, 'That'), KEY);
});

test('saved key file is private and read back', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'garmo-home-'));
  const env = { XDG_CONFIG_HOME: home };
  const file = saveKey(KEY, env);
  assert.equal(file, configFile(env));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  fs.chmodSync(file, 0o644);
  const warnings = [];
  assert.equal(resolveKey({ env, warn: (m) => warnings.push(m) }).key, KEY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(warnings.length, 1);
  assert.equal(resolveKey({ env: { ...env, GARMO_API_KEY: KEY.replace('a3f9', 'b4c5') } }).source, 'GARMO_API_KEY');
});

test('the key only goes to garmo.studio or localhost', () => {
  assert.equal(apiBase({}), 'https://api.garmo.studio/v1');
  assert.equal(apiBase({ GARMO_API_BASE: 'http://localhost:8000/studio/v1.php' }), 'http://localhost:8000/studio/v1.php');
  assert.equal(apiBase({ GARMO_API_BASE: 'https://staging.garmo.studio/v1/' }), 'https://staging.garmo.studio/v1');
  for (const bad of ['https://evil.test/v1', 'http://api.garmo.studio/v1', 'https://garmo.studio.evil.test', 'https://evilgarmo.studio', 'http://10.0.0.1', 'https://u:p@api.garmo.studio']) {
    assert.throws(() => apiBase({ GARMO_API_BASE: bad }), undefined, bad);
  }
});

test('Idempotency-Key is stable for the same photo and settings, different otherwise', () => {
  const tool = TOOL['remove-bg'];
  const item = { kind: 'file', abs: '/x/a.png', rel: 'a.png', type: 'image/png', sha: 'f'.repeat(64) };
  const a = buildRequest(tool, { bg: 'white', shadow: true }, item);
  const b = buildRequest(tool, { shadow: true, bg: 'white' }, { ...item, abs: '/elsewhere/a.png' });
  assert.equal(a.idem, b.idem);
  assert.ok(a.idem.length <= 80 && /^cli-[0-9a-f]{40}$/.test(a.idem));
  assert.notEqual(a.idem, buildRequest(tool, { bg: 'transparent' }, item).idem);
  assert.notEqual(a.idem, buildRequest(tool, { bg: 'white', shadow: true }, { ...item, sha: 'e'.repeat(64) }).idem);
  assert.notEqual(a.idem, buildRequest(TOOL.upscale, {}, item).idem);
  assert.deepEqual(a.fields, { background: 'white', shadow: 'true' });
  assert.equal(a.files[0].field, 'image');
  const url = buildRequest(tool, {}, { kind: 'url', url: 'https://x.test/a.jpg', rel: 'a.jpg' });
  assert.equal(url.fields.image_url, 'https://x.test/a.jpg');
  assert.equal(url.files.length, 0);
});

test('flag values are checked before anything is sent', () => {
  const f = TOOL.background.flags;
  assert.deepEqual(convertFlag('scene', f.scene, 'white, cafe,white'), ['white', 'cafe']);
  assert.throws(() => convertFlag('scene', f.scene, 'moon'));
  assert.equal(convertFlag('hex', TOOL.color.flags.hex, 'C8553D'), '#c8553d');
  assert.throws(() => convertFlag('hex', TOOL.color.flags.hex, 'red'));
  assert.throws(() => convertFlag('count', TOOL.generate.flags.count, '5'));
  assert.throws(() => convertFlag('count', TOOL.generate.flags.count, '1.5'));
  assert.throws(() => convertFlag('describe', f.describe, 'x'.repeat(301)));
});
