import { NextResponse } from "next/server";
import { getAnthropic, extractJson, MODEL } from "@/lib/anthropic";
import { coerceRecipes, parsePartialRecipes } from "@/lib/recipes";
import { checkRateLimit } from "@/lib/ratelimit";
import type { Recipe, RecipeStreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM = `You are a resourceful home cook. Given a list of ingredients someone has on hand,
suggest 3 recipes they could realistically make. Favor dishes that use what they already have and
keep extra shopping minimal (assume common staples like salt, pepper, oil, water).

Return ONLY a JSON object of this exact shape:
{
  "recipes": [
    {
      "title": "string — short, appetizing",
      "description": "string — one sentence on why it works",
      "time": "string — rough total time, e.g. '25 min'",
      "difficulty": "easy" | "medium" | "involved",
      "uses": ["the provided ingredients this dish leans on"],
      "need": ["a few common extras the cook likely needs, empty if none"],
      "steps": ["clear, ordered steps — 3 to 7 of them"]
    }
  ]
}
No prose outside the JSON. Make the three recipes meaningfully different from one another.`;

// Known recipe constraints. The client sends ids; we own the prompt text and
// ignore anything we don't recognize (defensive — never trust the wire).
const PREFERENCE_RULES: Record<string, string> = {
  vegetarian: "Every recipe must be vegetarian — no meat, poultry, or fish.",
  vegan: "Every recipe must be vegan — no animal products at all (no meat, dairy, eggs, or honey).",
  "gluten-free": "Every recipe must be gluten-free.",
  "dairy-free": "Every recipe must be dairy-free.",
  quick: "Every recipe should take 30 minutes or less, start to finish.",
  spicy: "Lean into bold, spicy flavors wherever it fits.",
};

export async function POST(req: Request) {
  const rate = await checkRateLimit(req);
  if (!rate.ok) {
    const init: ResponseInit = { status: 429 };
    if (rate.retryAfter) init.headers = { "Retry-After": String(rate.retryAfter) };
    return NextResponse.json(
      { error: "This demo has a daily limit and you've reached it. Try again tomorrow." },
      init
    );
  }

  let body: { ingredients?: unknown; preferences?: unknown };
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

  const constraints = Array.isArray(body.preferences)
    ? Array.from(new Set(body.preferences.filter((x): x is string => typeof x === "string")))
        .map((id) => PREFERENCE_RULES[id])
        .filter(Boolean)
    : [];

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
            messages: [
              {
                role: "user",
                content:
                  `Ingredients on hand: ${ingredients.join(", ")}.` +
                  (constraints.length
                    ? `\n\nHard constraints — follow all of them:\n${constraints.map((c) => `- ${c}`).join("\n")}`
                    : ""),
              },
            ],
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
