// Zero-shot photo classification with CLIP, running entirely in the browser
// via transformers.js. Photos never leave the device; only the model weights
// are downloaded (≈90 MB, cached by the browser after the first run).

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const MODEL = 'Xenova/clip-vit-base-patch32';

// [prompt, category, sub-type]. Category probability = sum over its prompts.
export const LABELS = [
  ['a home-cooked meal on a plate', 'cooking', 'meal'],
  ['someone cooking food in a home kitchen', 'cooking', 'stovetop'],
  ['homemade bread, cake or pastries', 'cooking', 'baking'],
  ['a homemade pasta dish', 'cooking', 'pasta'],
  ['a homemade salad', 'cooking', 'salad'],
  ['a homemade soup or stew in a pot', 'cooking', 'soup'],
  ['ingredients being chopped on a cutting board', 'cooking', 'prep'],
  ['food served at a restaurant', 'dining', null],
  ['a coffee drink at a cafe', 'dining', null],

  ['a person lifting weights in a gym', 'fitness', 'gym'],
  ['exercise machines and weights in a gym', 'fitness', 'gym'],
  ['a person running outdoors', 'fitness', 'running'],
  ['a person riding a bicycle', 'fitness', 'cycling'],
  ['a person swimming in a pool', 'fitness', 'swimming'],
  ['a person hiking on a mountain trail', 'fitness', 'hiking'],
  ['people playing a team sport', 'fitness', 'team sport'],
  ['a person doing yoga', 'fitness', 'yoga'],
  ['a phone screenshot of a workout tracking app', 'fitness', 'tracked workout'],

  ['a group of friends posing together', 'social', 'hangout'],
  ['a group selfie', 'social', 'hangout'],
  ['people at a party or celebration', 'social', 'party'],
  ['people sharing a meal together at a table', 'social', 'shared meal'],
  ['a wedding or formal event', 'social', 'event'],
  ['a crowd at a concert', 'social', 'concert'],

  ['handwritten notes in a notebook', 'learning', 'notes'],
  ['a whiteboard with equations or diagrams', 'learning', 'whiteboard'],
  ['an open textbook', 'learning', 'book'],
  ['a computer screen showing code', 'learning', 'code'],
  ['a lecture hall or classroom', 'learning', 'class'],

  ['a scenic landscape', 'travel', null],
  ['a famous landmark or tourist attraction', 'travel', null],
  ['a selfie of one person', 'other', null],
  ['a pet dog or cat', 'other', null],
  ['a phone screenshot of text messages or social media', 'other', null],
  ['a document, receipt or form', 'other', null],
  ['a meme or image with text', 'other', null],
  ['a random object or a blurry photo', 'other', null],
  ['a baby or small child', 'other', null],
];

export const MIN_CATEGORY_PROB = 0.4;

let classifierPromise = null;
export function loadClassifier(onProgress) {
  classifierPromise ??= (async () => {
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels = false;
    return pipeline('zero-shot-image-classification', MODEL, {
      progress_callback: (p) => onProgress?.(p),
    });
  })();
  return classifierPromise;
}

// Returns { cat, sub, conf } for one image URL (blob: or data: URL).
export async function classify(classifier, imageUrl) {
  const out = await classifier(imageUrl, LABELS.map((l) => l[0]), { hypothesis_template: '{}' });
  const prob = Object.fromEntries(out.map((o) => [o.label, o.score]));
  const catProb = {};
  let best = { p: -1 };
  for (const [text, cat, sub] of LABELS) {
    const p = prob[text] ?? 0;
    catProb[cat] = (catProb[cat] ?? 0) + p;
    if (p > best.p) best = { p, cat, sub };
  }
  const [topCat, topP] = Object.entries(catProb).sort((a, b) => b[1] - a[1])[0];
  if (topP < MIN_CATEGORY_PROB) return { cat: 'other', sub: null, conf: topP };
  // Sub-type = best-scoring prompt within the winning category.
  let sub = null, sp = -1;
  for (const [text, cat, s] of LABELS) if (cat === topCat && prob[text] > sp) { sp = prob[text]; sub = s; }
  return { cat: topCat, sub, conf: topP };
}
