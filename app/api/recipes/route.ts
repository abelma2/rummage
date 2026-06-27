import { NextResponse } from "next/server";
import { getAnthropic, extractJson, MODEL } from "@/lib/anthropic";
import { coerceRecipes, parsePartialRecipes, constraintsFromPreferences } from "@/lib/recipes";
import type { Recipe, RecipeStreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM = `You are a resourceful, encouraging home cook. Favor what the cook already has and keep
extra shopping minimal (assume common staples like salt, pepper, oil, water). Write clear, realistic
steps a nervous beginner could follow.

Return ONLY a JSON object of this exact shape:
{
  "recipes": [
    {
      "title": "string — short, appetizing",
      "description": "string — one friendly sentence on why it works",
      "time": "string — rough total time, e.g. '25 min'",
      "difficulty": "easy" | "medium" | "involved",
      "uses": ["the provided ingredients this dish leans on"],
      "need": ["a few common extras the cook likely needs, empty if none"],
      "steps": ["clear, ordered steps — 3 to 7 of them"]
    }
  ]
}
No prose outside the JSON.`;

export async function POST(req: Request) {
  let body: { ingredients?: unknown; preferences?: unknown; dish?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const ingredients = Array.isArray(body.ingredients)
    ? body.ingredients.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
    : [];

  if (ingredients.length === 0) {
    return NextResponse.json({ error: "Add at least one ingredient first." }, { status: 400 });
  }

  // When a dish is chosen from the menu, generate just that one recipe; without
  // one, fall back to suggesting three (keeps the endpoint back-compatible).
  const dish = typeof body.dish === "string" ? body.dish.trim().slice(0, 120) : "";
  const constraints = constraintsFromPreferences(body.preferences);
  const constraintBlock = constraints.length
    ? `\n\nHard constraints — follow all of them:\n${constraints.map((c) => `- ${c}`).join("\n")}`
    : "";
  const userContent = dish
    ? `Make this specific dish: "${dish}".\nUsing these ingredients on hand: ${ingredients.join(", ")}.\nReturn exactly ONE recipe for it.${constraintBlock}`
    : `Ingredients on hand: ${ingredients.join(", ")}.\nSuggest 3 recipes, meaningfully different from one another.${constraintBlock}`;

  // Config errors happen before we start streaming, so they can still be a
  // normal HTTP error the client surfaces directly.
  let client;
  try {
    client = getAnthropic();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server is misconfigured.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const ac = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: RecipeStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true; // consumer went away
        }
      };

      try {
        const ai = client.messages.stream(
          {
            model: MODEL,
            max_tokens: 2048,
            system: SYSTEM,
            messages: [{ role: "user", content: userContent }],
          },
          { signal: ac.signal }
        );

        let text = "";
        let lastSnapshot = "";
        ai.on("text", (delta) => {
          text += delta;
          try {
            const recipes = parsePartialRecipes(text);
            const snapshot = JSON.stringify(recipes);
            if (recipes.length > 0 && snapshot !== lastSnapshot) {
              lastSnapshot = snapshot;
              send({ type: "recipes", recipes });
            }
          } catch {
            // Display-only; never let a partial-parse hiccup break the stream.
          }
        });

        const final = await ai.finalMessage();
        let full = "";
        for (const block of final.content) {
          if (block.type === "text") full += block.text;
        }

        // Authoritative pass: defensively extract + validate the full response.
        let recipes: Recipe[] = [];
        try {
          recipes = coerceRecipes(extractJson(full));
        } catch {
          recipes = parsePartialRecipes(full); // tolerate trailing prose/truncation
        }

        if (recipes.length === 0) {
          send({ type: "error", error: "Couldn't come up with recipes for that. Try different ingredients." });
        } else {
          send({ type: "done", recipes });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Something went wrong building recipes.";
        send({ type: "error", error: message });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
