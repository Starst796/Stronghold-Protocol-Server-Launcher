import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { prependPath } from '../launcher/lib/util.mjs';

test('prependPath puts the bundled runtime first and preserves Windows PATH casing', () => {
  const env = prependPath('/portable/node/bin', { Path: '/usr/bin', KEEP: 'value' });

  assert.equal(env.Path, ['/portable/node/bin', '/usr/bin'].join(path.delimiter));
  assert.equal(env.PATH, undefined);
  assert.equal(env.KEEP, 'value');
});
