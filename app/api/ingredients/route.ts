import { NextResponse } from "next/server";
import { getAnthropic, extractJson, MODEL } from "@/lib/anthropic";
import { checkRateLimit } from "@/lib/ratelimit";
import type { IngredientsResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const ALLOWED_MEDIA = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const SYSTEM = `You identify food ingredients visible in a photo of a fridge, pantry, or kitchen counter.
Return ONLY a JSON array of strings — the distinct, usable food items you can actually see.
Rules:
- Use simple, common lowercase names ("eggs", "cheddar", "baby spinach", "soy sauce").
- Merge duplicates; skip anything that is not food; skip items you cannot identify with reasonable confidence.
- Prefer the ingredient over the brand.
- Return between 0 and 25 items.
No prose, no keys, no explanation — just the JSON array.`;

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

  let body: { image?: string; mediaType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { image, mediaType } = body;
  if (!image || typeof image !== "string") {
    return NextResponse.json({ error: "No image provided." }, { status: 400 });
  }

  const media =
    mediaType && ALLOWED_MEDIA.has(mediaType) ? mediaType : "image/jpeg";

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: media as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                data: image,
              },
            },
            { type: "text", text: "What food ingredients can you see in this photo?" },
          ],
        },
      ],
    });

    let text = "";
    for (const block of msg.content) {
      if (block.type === "text") text += block.text;
    }

    const parsed = extractJson<string[]>(text);
    const ingredients = Array.isArray(parsed)
      ? Array.from(
          new Set(
            parsed
              .filter((x): x is string => typeof x === "string")
              .map((x) => x.trim().toLowerCase())
              .filter(Boolean)
          )
        ).slice(0, 25)
      : [];

    const response: IngredientsResponse = { ingredients };
    return NextResponse.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Something went wrong reading the photo.";
    const status = message.includes("ANTHROPIC_API_KEY") ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
