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

import type { Recipe } from "./types";

const DIFFICULTIES = new Set<Recipe["difficulty"]>(["easy", "medium", "involved"]);

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
 * Return the text inside the recipes array (`[ ... ]`), without the brackets.
 * Prefers the array that follows a "recipes" key; falls back to the first array.
 * If the array hasn't closed yet, returns everything after the opening bracket.
 */
function extractArrayBody(text: string): string | null {
  let open = -1;
  const key = text.indexOf('"recipes"');
  if (key !== -1) open = text.indexOf("[", key);
  if (open === -1) open = text.indexOf("[");
  if (open === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i); // matching close bracket
    }
  }
  return text.slice(open + 1); // not closed yet — take the rest
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
