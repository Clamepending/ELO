// Score tree: pure functions, no DOM. Runs in the browser and in Node tests.
//
// Every node returns the same contract:
//   { theta, var, coverage, evidence, missing }
// theta is a latent level in logit-like units where the reference-population
// median is 0 and the prior is N(0, 1). All math happens in theta space;
// Elo and percentile are display-only transforms.

export const ELO_SCALE = 400 / Math.LN10; // ≈ 173.7
export const toElo = (theta) => 1500 + ELO_SCALE * theta;
export const toPct = (theta) => 100 * normCdf(theta);
export const PROVISIONAL_SD = 0.55; // theta-units; ≈ ±95 Elo (1 sd)

export function normCdf(x) {
  // Abramowitz–Stegun 7.1.26 erf approximation, |error| < 1.5e-7.
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (p) => Math.log(p / (1 - p));

// Map a raw statistic to a standardized observation against a reference norm.
// norm: { transform: 'log'|'logit', median, sigma, higherIsBetter }
export function standardize(value, norm) {
  let z;
  if (norm.transform === 'logit') {
    const eps = 0.005;
    z = (logit(clamp(value, eps, 1 - eps)) - logit(clamp(norm.median, eps, 1 - eps))) / norm.sigma;
  } else {
    const eps = norm.eps ?? 0.05;
    z = (Math.log(value + eps) - Math.log(norm.median + eps)) / norm.sigma;
  }
  if (norm.higherIsBetter === false) z = -z;
  return clamp(z, -3, 3);
}

// Conjugate Gaussian update: prior N(0,1), observation z with noise variance r2.
export function posterior(z, r2) {
  const prec = 1 + 1 / r2;
  return { theta: z / r2 / prec, var: 1 / prec };
}

const PRIOR = { theta: 0, var: 1, coverage: 0, evidence: [], missing: true };

// Score a leaf. leaf.compute(ctx) -> { value, n, evidence, detail } | null.
// n is the amount of evidence in the leaf's own units; kappa is how much
// evidence counts as much as the prior (r2 = kappa / n).
export function scoreLeaf(leaf, ctx) {
  const obs = leaf.compute(ctx);
  if (!obs || !(obs.n > 0) || !Number.isFinite(obs.value)) {
    return { ...PRIOR, raw: obs ?? null };
  }
  const z = standardize(obs.value, leaf.norm);
  const r2 = leaf.kappa / obs.n;
  const post = posterior(z, r2);
  return {
    ...post,
    z,
    coverage: obs.n / (obs.n + leaf.kappa),
    evidence: obs.evidence ?? [],
    missing: false,
    raw: obs,
  };
}

// Combine children in theta space. Missing children contribute the prior
// (theta 0, var 1) rather than having their weight renormalized away, so a
// parent means the same thing for every user. The weighted sum is divided by
// sqrt(w' S w), the population SD of the composite, so the parent stays on
// the same scale as its children. S is assumed equicorrelated with off-diagonal
// rho (a per-node placeholder until it can be estimated from real users):
//   w' S w = sum w^2 + rho * ((sum w)^2 - sum w^2)
export function combine(children, rho = 0) {
  const ws = children.map((c) => c.weight);
  const sw = ws.reduce((a, b) => a + b, 0);
  const sw2 = ws.reduce((a, b) => a + b * b, 0);
  let theta = 0, v = 0, cov = 0;
  const evidence = new Set();
  for (const c of children) {
    theta += c.weight * c.score.theta;
    v += c.weight * c.weight * c.score.var;
    cov += c.weight * c.score.coverage;
    for (const e of c.score.evidence) evidence.add(e);
  }
  // Estimation errors are given the same correlation rho, so a parent of
  // all-prior children keeps the prior variance of exactly 1.
  const wsd = children.reduce((a, c) => a + c.weight * Math.sqrt(c.score.var), 0);
  v += rho * (wsd * wsd - v);
  const wSw = sw2 + rho * (sw * sw - sw2);
  return {
    theta: theta / Math.sqrt(wSw),
    var: v / wSw,
    coverage: cov / sw,
    evidence: [...evidence],
    missing: children.every((c) => c.score.missing),
  };
}

// Recursively score a tree. Returns a parallel tree with .score on each node.
export function scoreTree(node, ctx) {
  if (node.compute) {
    return { ...node, score: scoreLeaf(node, ctx) };
  }
  const children = node.children.map((c) => scoreTree(c, ctx));
  const scored = children.map((c) => ({ weight: c.weight ?? 1, score: c.score }));
  return { ...node, children, score: combine(scored, node.rho ?? 0) };
}

export function describe(score) {
  const sd = Math.sqrt(score.var);
  return {
    elo: Math.round(toElo(score.theta)),
    pct: Math.round(toPct(score.theta)),
    ci95: Math.round(1.96 * sd * ELO_SCALE),
    provisional: sd > PROVISIONAL_SD,
  };
}
