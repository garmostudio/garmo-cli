// Every flag must be a real API parameter, with the same allowed values (api/openapi.json comes from scripts/api/spec.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/commands.js';

const specPath = fileURLToPath(new URL('../../api/openapi.json', import.meta.url));
const spec = fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf8')) : null;

test('every tool matches the API spec', { skip: !spec && 'api/openapi.json not found (outside the Garmo repo)' }, () => {
  const editPaths = Object.keys(spec.paths).filter((p) => p === '/generate' || p.startsWith('/edit/'));
  assert.deepEqual(TOOLS.map((t) => t.path).sort(), editPaths.sort(), 'one command per edit endpoint');
  for (const tool of TOOLS) {
    const schema = spec.paths[tool.path].post.requestBody.content['application/json'].schema;
    const props = schema.properties;
    const mine = Object.values(tool.flags);
    for (const def of mine) {
      const p = props[def.param];
      assert.ok(p, `${tool.name}: ${def.param} is not an API parameter`);
      const theirs = p.enum ?? p.items?.enum ?? null;
      if (def.enum || theirs) assert.deepEqual(def.enum, theirs, `${tool.name} ${def.param}: allowed values differ`);
      if (p.maxLength) assert.equal(def.max, p.maxLength, `${tool.name} ${def.param}: max length differs`);
    }
    for (const req of schema.required ?? []) {
      assert.ok(mine.some((d) => d.param === req && d.required), `${tool.name}: required ${req} is not a required flag`);
    }
  }
});
