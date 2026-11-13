import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, standardize, posterior, combine, scoreTree, toElo, describe } from '../src/scoring.js';
import { TREE, buildContext } from '../src/tree.js';
import { demoPhotos } from '../src/demo.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('normCdf', () => { close(normCdf(0), 0.5); close(normCdf(1.96), 0.975, 1e-4); close(normCdf(-1), 0.158655, 1e-5); });
test('Elo scale: logit(0.9) -> ~1882', () => close(toElo(Math.log(9)), 1881.7, 0.1));
test('standardize median -> 0, direction flips', () => {
  close(standardize(0.3, { transform: 'log', median: 0.3, sigma: 1 }), 0);
  assert.ok(standardize(0.1, { transform: 'logit', median: 0.03, sigma: 1, higherIsBetter: false }) < 0);
});
test('posterior shrinks toward 0 and narrows', () => {
  const p = posterior(2, 1); close(p.theta, 1); close(p.var, 0.5);
  assert.ok(posterior(2, 0.01).theta > 1.9);
});
test('missing children keep prior; scale preserved for independent children', () => {
  const prior = { theta: 0, var: 1, coverage: 0, evidence: [], missing: true };
  const all = combine([1, 1, 1, 1].map((w) => ({ weight: w, score: prior })));
  close(all.theta, 0); close(all.var, 1);
  close(combine([1, 1, 1].map((w) => ({ weight: w, score: prior })), 0.6).var, 1); assert.equal(all.missing, true);
  const one = { theta: 1, var: 0, coverage: 1, evidence: ['a'], missing: false };
  const c = combine([1, 1, 1, 1].map((w) => ({ weight: w, score: one })));
  close(c.theta, 2); // Σ=I: 4 / sqrt(4)
  close(combine([1, 1, 1, 1].map((w) => ({ weight: w, score: one })), 1).theta, 1); // ρ=1: no inflation
});
test('empty gallery -> everything at prior 1500, no data', () => {
  const s = scoreTree(TREE, buildContext([]));
  assert.equal(describe(s.score).elo, 1500);
  assert.equal(s.score.missing, true);
});
test('demo gallery scores every leaf', () => {
  const s = scoreTree(TREE, buildContext(demoPhotos()));
  const walk = (n) => (n.children ? n.children.flatMap(walk) : [n]);
  for (const leaf of walk(s)) {
    assert.equal(leaf.score.missing, false, leaf.id);
    assert.ok(Number.isFinite(leaf.score.theta), leaf.id);
  }
  console.log(walk(s).map((l) => `${l.id} ${describe(l.score).elo} ±${describe(l.score).ci95} | ${l.score.raw.detail}`).join('\n'));
  console.log('overall', describe(s.score));
});
