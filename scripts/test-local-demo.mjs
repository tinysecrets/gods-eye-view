#!/usr/bin/env node
import assert from 'node:assert/strict';

const base = process.env.GEV_MOCK_BASE_URL || 'http://127.0.0.1:4174';
const health = await fetch(new URL('/health', base));
assert.equal(health.status, 200, 'health endpoint should return HTTP 200');
const status = await health.json();
assert.equal(status.ok, true);
assert.equal(status.simulated, true);
assert.equal(status.upstreamConnections, false, 'mock server must not contact upstream providers');

const kinds = ['aircraft', 'ships', 'fires', 'traffic', 'earthquakes'];
for (const kind of kinds) {
  const response = await fetch(new URL('/api/' + kind, base));
  assert.equal(response.status, 200, kind + ' endpoint should return HTTP 200');
  const body = await response.json();
  assert.equal(body.simulated, true, kind + ' feed must be labeled simulated');
  assert.ok(body.count > 0, kind + ' feed should contain demo records');
  assert.equal(body.count, body.records.length);
  for (const record of body.records) {
    assert.ok(Number.isFinite(record.lat), kind + ' record latitude should be numeric');
    assert.ok(Number.isFinite(record.lon), kind + ' record longitude should be numeric');
  }
  console.log('PASS ' + kind + ': ' + body.count + ' synthetic records');
}
const all = await (await fetch(new URL('/api/all', base))).json();
assert.deepEqual(Object.keys(all).sort(), kinds.slice().sort());
console.log('PASS health: local-only; no upstream connections');
console.log('PASS combined feed: all categories present');
