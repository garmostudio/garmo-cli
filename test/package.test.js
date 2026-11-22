// The package itself: nothing runs on install, nothing is pulled in, no ways to run other code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('no install scripts and no dependencies', () => {
  for (const s of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) assert.ok(!pkg.scripts?.[s], `scripts.${s}`);
  for (const d of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    assert.equal(Object.keys(pkg[d] ?? {}).length, 0, d);
  }
  assert.deepEqual(pkg.files, ['bin', 'src', 'README.md', 'LICENSE']);
  assert.equal(pkg.bin.garmo, 'bin/garmo.js');
});

test('source has no eval, child processes or dynamic imports, and only Node modules', () => {
  const dirs = ['src', 'bin'];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      const text = fs.readFileSync(path.join(root, d, f), 'utf8');
      assert.ok(!/\beval\s*\(|new Function\s*\(|child_process|\bimport\s*\(/.test(text), `${d}/${f}`);
      for (const [, spec] of text.matchAll(/from '([^']+)'/g)) assert.ok(spec.startsWith('node:') || spec.startsWith('.'), `${d}/${f} imports ${spec}`);
    }
  }
});

test('version is the same in package.json and the code', async () => {
  const { VERSION } = await import(path.join(root, 'src', 'commands.js'));
  assert.equal(VERSION, pkg.version);
});
