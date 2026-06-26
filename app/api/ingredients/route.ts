import { NextResponse } from "next/server";
import { getAnthropic, extractJson, MODEL } from "@/lib/anthropic";
import { checkRateLimit } from "@/lib/ratelimit";
import type { Detection, IngredientsResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const ALLOWED_MEDIA = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const SYSTEM = `You identify food ingredients visible in a photo of a fridge, pantry, or kitchen counter.
Return ONLY a JSON object of this exact shape:
{ "items": [ { "name": "<lowercase ingredient>", "box": [x, y, w, h] } ] }
Rules:
- Use simple, common lowercase names ("eggs", "cheddar", "baby spinach", "soy sauce"); prefer the ingredient over the brand.
- "box" locates the item in the image as fractions from 0 to 1, origin at the TOP-LEFT: x,y is the top-left corner of the item, w,h is its width and height.
- One entry per visible item. It's fine to list the same name more than once if you see multiple; skip non-food and anything you can't identify with reasonable confidence.
- Return between 0 and 25 items.
No prose, no extra keys — just the JSON object.`;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function coerceBox(raw: unknown): Detection["box"] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  if (!raw.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [x, y, w, h] = (raw as number[]).map(clamp01);
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

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

    // Accept either the {items:[...]} object or a bare array, of objects or
    // plain strings — defensively coerce whatever shape comes back.
    const parsed = extractJson<unknown>(text);
    const rawItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown })?.items)
        ? (parsed as { items: unknown[] }).items
        : [];

    const names = new Set<string>();
    const boxes: Detection[] = [];
    for (const item of rawItems) {
      const name =
        typeof item === "string"
          ? item.trim().toLowerCase()
          : item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
            ? (item as { name: string }).name.trim().toLowerCase()
            : "";
      if (!name) continue;
      names.add(name);

      const box = item && typeof item === "object" ? coerceBox((item as { box?: unknown }).box) : null;
      if (box && boxes.length < 25) boxes.push({ name, box });
    }

    const ingredients = Array.from(names).slice(0, 25);
    const response: IngredientsResponse = {
      ingredients,
      boxes: boxes.filter((b) => ingredients.includes(b.name)),
    };
    return NextResponse.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Something went wrong reading the photo.";
    const status = message.includes("ANTHROPIC_API_KEY") ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
