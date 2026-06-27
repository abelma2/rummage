// Recipe shaping + a tolerant parser for partial JSON streamed from the model.
//
// The route streams recipes token-by-token. To render cards as they form, we
// need to read incomplete JSON — but we never want to *guess* at a truncated
// token. So `parsePartialRecipes` only ever calls JSON.parse on text that is
// already balanced/complete (a closed object, or a field whose value is a
// closed string/array), and skips anything still in flight. It therefore cannot
// throw on a partial chunk, and the worst it does is briefly omit a field that
// hasn't finished arriving. The authoritative result is always the strict parse
// of the final message (see the route) — this is display-only and converges.

import type { DishIdea, Recipe } from "./types";

const DIFFICULTIES = new Set<Recipe["difficulty"]>(["easy", "medium", "involved"]);

// Known recipe constraints. Clients send ids; we own the prompt text and ignore
// anything we don't recognize. Shared by the dishes and recipes routes.
export const PREFERENCE_RULES: Record<string, string> = {
  vegetarian: "Must be vegetarian — no meat, poultry, or fish.",
  vegan: "Must be vegan — no animal products at all (no meat, dairy, eggs, or honey).",
  "gluten-free": "Must be gluten-free.",
  "dairy-free": "Must be dairy-free.",
  quick: "Should take 30 minutes or less, start to finish.",
  spicy: "Lean into bold, spicy flavors wherever it fits.",
};

/** Map preference ids (untrusted) to their constraint sentences. */
export function constraintsFromPreferences(preferences: unknown): string[] {
  if (!Array.isArray(preferences)) return [];
  return Array.from(new Set(preferences.filter((x): x is string => typeof x === "string")))
    .map((id) => PREFERENCE_RULES[id])
    .filter(Boolean);
}

// Cooking equipment the cook has → a constraint so recipes stay actually
// makeable (e.g. microwave-only, or a stovetop with no pan). Ids map to a
// human phrase; the client owns the toggle list, we own the prompt text.
export const EQUIPMENT: Record<string, string> = {
  stovetop: "a stovetop",
  oven: "an oven",
  microwave: "a microwave",
  "air-fryer": "an air fryer",
  pan: "a frying pan / skillet",
  pot: "a pot / saucepan",
};

/**
 * Build a single constraint sentence from the selected equipment ids, or null
 * if none are selected (no constraint — assume a normal kitchen).
 */
export function equipmentConstraint(equipment: unknown): string | null {
  if (!Array.isArray(equipment)) return null;
  const have = Array.from(new Set(equipment.filter((x): x is string => typeof x === "string")))
    .map((id) => EQUIPMENT[id])
    .filter(Boolean);
  if (have.length === 0) return null;
  return `The cook can ONLY use this equipment: ${have.join(", ")} (plus everyday basics — a bowl, plate, knife, and an oven-safe dish or microwave-safe bowl where relevant). Every recipe must be fully makeable with only that — do not require anything that isn't listed (for example, no frying pan unless one is listed).`;
}

/** Coerce one untrusted value into a typed DishIdea, or null if unusable. */
export function coerceDish(raw: unknown): DishIdea | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return null;

  const difficulty =
    typeof r.difficulty === "string" && DIFFICULTIES.has(r.difficulty as Recipe["difficulty"])
      ? (r.difficulty as DishIdea["difficulty"])
      : "medium";
  const emoji = typeof r.emoji === "string" && r.emoji.trim() ? r.emoji.trim().slice(0, 4) : "🍽️";

  return {
    title: title.slice(0, 80),
    emoji,
    blurb: typeof r.blurb === "string" ? r.blurb.trim().slice(0, 160) : "",
    time: typeof r.time === "string" ? r.time.trim() : "",
    difficulty,
  };
}

/** Coerce a parsed response ({dishes:[...]} or a bare array) into DishIdeas. */
export function coerceDishes(parsed: unknown): DishIdea[] {
  const arr =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { dishes?: unknown }).dishes)
      ? (parsed as { dishes: unknown[] }).dishes
      : Array.isArray(parsed)
        ? parsed
        : [];
  return arr.map(coerceDish).filter((d): d is DishIdea => d !== null).slice(0, 8);
}

/** Coerce one untrusted value into a typed Recipe, or null if it isn't usable. */
export function coerceRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return null;

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [];

  const difficulty =
    typeof r.difficulty === "string" && DIFFICULTIES.has(r.difficulty as Recipe["difficulty"])
      ? (r.difficulty as Recipe["difficulty"])
      : "medium";

  return {
    title,
    description: typeof r.description === "string" ? r.description.trim() : "",
    time: typeof r.time === "string" ? r.time.trim() : "",
    difficulty,
    uses: asStringArray(r.uses).slice(0, 12),
    need: asStringArray(r.need).slice(0, 8),
    steps: asStringArray(r.steps).slice(0, 10),
  };
}

/** Coerce a fully-parsed response ({recipes:[...]} or a bare array) into Recipes. */
export function coerceRecipes(parsed: unknown): Recipe[] {
  const arr =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { recipes?: unknown }).recipes)
      ? (parsed as { recipes: unknown[] }).recipes
      : Array.isArray(parsed)
        ? parsed
        : [];
  return arr.map(coerceRecipe).filter((r): r is Recipe => r !== null).slice(0, 3);
}

/**
 * Best-effort parse of an in-progress JSON stream into renderable recipes.
 * Safe to call on any prefix of the model's output — never throws.
 */
export function parsePartialRecipes(text: string): Recipe[] {
  const body = extractArrayBody(text);
  if (body === null) return [];

  const recipes: Recipe[] = [];
  for (const item of splitTopLevel(body)) {
    const obj = parseMaybePartialObject(item);
    const recipe = obj ? coerceRecipe(obj) : null;
    if (recipe) recipes.push(recipe);
  }
  return recipes.slice(0, 3);
}

/**
 * Tolerantly extract detected items ({name, box}) from the vision response —
 * reuses the streaming helpers so a long or truncated response yields whatever
 * items fully arrived instead of throwing. Handles `{"items":[...]}` or a bare
 * array.
 */
export function parsePartialItems(text: string): { name: string; box: unknown }[] {
  const body = extractArrayBody(text);
  if (body === null) return [];
  const out: { name: string; box: unknown }[] = [];
  for (const item of splitTopLevel(body)) {
    const obj = parseMaybePartialObject(item);
    if (obj && typeof obj.name === "string") out.push({ name: obj.name, box: obj.box });
  }
  return out;
}

/**
 * Return the text inside the recipes array (`[ ... ]`), without the brackets.
 * Scans string-aware so a `[` inside a string value can't be mistaken for the
 * array — the model's shape is `{"recipes":[...]}`, so the first *structural*
 * bracket is the array (this also covers a defensive bare-array response). If
 * the array hasn't closed yet, returns everything after the opening bracket.
 */
function extractArrayBody(text: string): string | null {
  let inString = false;
  let escaped = false;
  let open = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (open === -1) {
      if (ch === "[") {
        open = i; // first structural bracket — the recipes array
        depth = 1;
      }
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i); // matching close bracket
    }
  }
  return open === -1 ? null : text.slice(open + 1); // not closed yet (or no array)
}

/** Split on commas at depth 0 (ignoring commas inside strings or nested brackets). */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items.map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse an object that may be incomplete. A complete object parses directly;
 * for a partial one we keep the leading `"key": value` fields whose values have
 * fully arrived (verified by parsing them, wrapped in braces) and drop the rest.
 */
function parseMaybePartialObject(item: string): Record<string, unknown> | null {
  const t = item.trim();
  if (!t.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Not complete yet — fall through to field-by-field accumulation.
  }

  const fields = splitTopLevel(t.slice(1));
  const accepted: string[] = [];
  let pending: string | undefined;
  for (const field of fields) {
    try {
      JSON.parse("{" + [...accepted, field].join(",") + "}");
      accepted.push(field);
    } catch {
      pending = field; // first field that hasn't finished
      break;
    }
  }

  // If the unfinished field is an array still being written (e.g. "steps":["a",
  // "b", "c...), surface the elements that have fully arrived so lists stream
  // item-by-item rather than popping in all at once when the array closes.
  const partialArrayField = pending && completedArrayField(pending);
  if (partialArrayField) accepted.push(partialArrayField);

  if (accepted.length === 0) return null;
  try {
    return JSON.parse("{" + accepted.join(",") + "}") as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Given an in-progress `"key": [ ... ` field, return `"key":[<complete items>]`
 * with only the elements that have fully arrived, or null if none have.
 */
function completedArrayField(field: string): string | null {
  const m = field.match(/^\s*("(?:[^"\\]|\\.)*")\s*:\s*\[([\s\S]*)$/);
  if (!m) return null;
  const [, key, arrayBody] = m;

  const items: string[] = [];
  for (const item of splitTopLevel(arrayBody)) {
    try {
      JSON.parse("[" + [...items, item].join(",") + "]");
      items.push(item);
    } catch {
      break;
    }
  }
  return items.length > 0 ? `${key}:[${items.join(",")}]` : null;
}
