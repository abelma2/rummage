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

export interface IngredientsResponse {
  ingredients: string[];
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
