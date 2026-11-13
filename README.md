# Life Rating (v0 prototype)

Pick photos (or a Google Takeout export folder) and get an Elo-scaled rating, then click to
drill down: **Overall → category → sub-score → the photos that produced it.**

```
npm start        # = python3 -m http.server 8000, then open http://localhost:8000
npm test         # node --test, scoring math + tree on synthetic data
```

Deploy with `npx wrangler@4 deploy` (Node ≥ 22.12); it serves https://elo.vibe-research.net.

There is no build step and no backend beyond a stateless Worker route that relays Google Photos
downloads (Google's media URLs block browser CORS). Photos are never stored server-side: a CLIP model
(`Xenova/clip-vit-base-patch32` via transformers.js, ≈90 MB, downloaded once and cached) tags each
photo zero-shot. "Try synthetic data" explores the UI without photos or the model.

## Layout

| File | Role |
|---|---|
| `src/ingest.js` | Connector: files → photo records (EXIF date/GPS, Takeout `.json` sidecars, thumbnails) |
| `src/archives.js` | Connector: Instagram / X export (.zip or folder) → images + post dates |
| `src/gphotos.js` | Connector: Google Photos Picker API (downloads via the Worker's `/api/gphoto`) |
| `src/calendar.js` | Connector: Google Calendar / `.ics` → event records, keyword-classified |
| `src/google.js`, `src/config.js` | Google sign-in and the public OAuth client ID |
| `worker/index.js` | Cloudflare Worker: serves the site, plus the Google Photos download pass-through |
| `src/classify.js` | CLIP zero-shot prompts → `{cat, sub, conf}` per photo |
| `src/tree.js` | The score tree: leaves read photo and event records, never files |
| `src/scoring.js` | Node contract + math (pure, no DOM) |
| `src/main.js` | UI |

## Scoring math

Every node returns `{theta, var, coverage, evidence, missing}`. `theta` is a latent level where
the reference median is 0 and the prior is N(0, 1). Elo is display-only:
`R = 1500 + (400 / ln 10)·θ ≈ 1500 + 173.7·θ`; percentile = `100·Φ(θ)`.

- **Leaf:** statistic `x` → `z = (log x − log median)/σ` (or logit for shares), clamped to ±3.
  Observation noise `r² = κ/n`, where `n` is the amount of evidence. The posterior is
  `θ = z / (r² + 1)` with variance `r² / (r² + 1)`, so thin evidence shrinks toward 1500.
- **Parent:** `θ = Σ wᵢθᵢ / √(wᵀΣw)` with an assumed equicorrelation `ρ` per node
  (0.6 within a category, 0.2 across categories). This keeps composites on the same scale as
  their children and avoids double-counting near-duplicate siblings such as frequency and
  consistency. Errors get the same `ρ`.
- **Missing child** (e.g. no GPS): it contributes the prior (θ=0, var=1). Its weight is *not*
  renormalized away, so a parent means the same thing for every user.
- **Weeks with no photos at all** are missing, not zero. A week that has photos but none in
  a category counts as zero for that category.
- **Provisional** = posterior sd > 0.55 (≈ ±95 Elo at 1 sd).

## Known limitations (deliberate for v0)

- All `norm` medians and σ values are hand-set placeholders, not fitted to ATUS, NHANES or any
  real population.
- Scores measure photographing habits as much as behavior. There is no propensity correction
  yet; the next step is capture–recapture against a second source such as a calendar or wearable.
- CLIP can't tell home cooking from restaurant food or your activity from someone else's.
  Tested on COCO images, it confidently labeled a skier as "cycling".
- HEIC files decode only in Safari. Elsewhere they count for dates and GPS but are not classified.
- Videos are ignored. Scores are computed over the whole history; there is no per-week
  Kalman/Glicko history yet.

## Adding a module

Add a leaf `{id, name, desc, norm, kappa, compute(ctx)}` anywhere in `TREE`. `compute` returns
`{value, n, evidence, detail}` or `null` (missing). A new connector only has to emit records in
the same shape for every existing leaf to pick them up.
