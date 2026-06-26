// Shared types used by both API routes and the client.

export interface Recipe {
  title: string;
  description: string;
  time: string; // e.g. "25 min"
  difficulty: "easy" | "medium" | "involved";
  uses: string[]; // ingredients from the detected list this recipe leans on
  need: string[]; // a few common extras the cook will likely need
  steps: string[];
}

/** One detected item with its rough location, for the photo overlay. */
export interface Detection {
  name: string;
  /** Normalized [x, y, w, h] as fractions of the image, top-left origin. */
  box: [number, number, number, number];
}

export interface IngredientsResponse {
  ingredients: string[];
  boxes: Detection[];
}

export interface RecipesResponse {
  recipes: Recipe[];
}

/**
 * Server-sent events emitted by the streaming /api/recipes route.
 * - `recipes`: a best-effort snapshot as the model writes (cards fill in live)
 * - `done`: the final, strictly-validated set of recipes
 * - `error`: generation failed after the stream had already started
 */
export type RecipeStreamEvent =
  | { type: "recipes"; recipes: Recipe[] }
  | { type: "done"; recipes: Recipe[] }
  | { type: "error"; error: string };
