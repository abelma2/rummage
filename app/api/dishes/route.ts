import { NextResponse } from "next/server";
import { getAnthropic, extractJson, MODEL } from "@/lib/anthropic";
import { coerceDishes, constraintsFromPreferences } from "@/lib/recipes";
import { checkRateLimit } from "@/lib/ratelimit";
import type { DishIdea, DishesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// Cheap "menu" step: just dish ideas, not full recipes. The full recipe is
// generated only for the one the user taps (see /api/recipes with `dish`).
const SYSTEM = `You are a warm, encouraging home cook helping someone decide what to make.
Given the ingredients they have, suggest 6 dish IDEAS — not full recipes, just appealing options.
Favor dishes that mostly use what they already have (assume staples like salt, pepper, oil, water).

Return ONLY a JSON object of this exact shape:
{
  "dishes": [
    {
      "title": "string — short, friendly dish name",
      "emoji": "string — one single emoji that fits the dish",
      "blurb": "string — one short, inviting sentence",
      "time": "string — rough total time, e.g. '25 min'",
      "difficulty": "easy" | "medium" | "involved"
    }
  ]
}
No prose outside the JSON. Make the 6 ideas varied (different styles, efforts, and meals).`;

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

  const constraints = constraintsFromPreferences(body.preferences);

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Ingredients on hand: ${ingredients.join(", ")}.` +
            (constraints.length
              ? `\n\nFollow all of these:\n${constraints.map((c) => `- ${c}`).join("\n")}`
              : ""),
        },
      ],
    });

    let text = "";
    for (const block of msg.content) {
      if (block.type === "text") text += block.text;
    }

    let dishes: DishIdea[] = [];
    try {
      dishes = coerceDishes(extractJson(text));
    } catch {
      dishes = [];
    }

    if (dishes.length === 0) {
      return NextResponse.json(
        { error: "Couldn't think of dishes for that. Try adding a few more ingredients." },
        { status: 502 }
      );
    }

    const response: DishesResponse = { dishes };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong finding dishes.";
    const status = message.includes("ANTHROPIC_API_KEY") ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
