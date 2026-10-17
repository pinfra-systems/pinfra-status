import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerTiming, mergeHops } from '../api/_timing.js';

test('real platform format: one metric per line, one decimal', () => {
  assert.deepEqual(parseServerTiming('wake;dur=1234.5, app;dur=56.7'), { wake: 1234.5, app: 56.7 });
});

test('tenant header BEFORE the platform one: the last entry wins', () => {
  // joined as fetch Headers.get() does for repeated header lines
  const h = 'app;dur=1, wake;dur=0, wake;dur=2300.4, app;dur=120.2';
  assert.deepEqual(parseServerTiming(h), { wake: 2300.4, app: 120.2 });
  // and a tenant cannot fake a wake the platform did not report
  assert.equal(parseServerTiming('wake;dur=9999, wake;dur=0.0').wake, 0);
});

test('missing or malformed header yields nothing', () => {
  assert.deepEqual(parseServerTiming(null), {});
  assert.deepEqual(parseServerTiming('cache;desc=HIT'), {});
});

test('wake on the redirect hop survives a later hop reporting wake;dur=0', () => {
  const m = mergeHops([parseServerTiming('wake;dur=2300.1, app;dur=5.0'), parseServerTiming('wake;dur=0.0, app;dur=90.3')]);
  assert.deepEqual(m, { wake: 2300.1, app: 90.3 });
});
