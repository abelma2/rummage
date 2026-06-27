import { NextResponse } from "next/server";
import { getAnthropic, MODEL } from "@/lib/anthropic";
import { parsePartialItems } from "@/lib/recipes";
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
  const x = clamp01(raw[0] as number);
  const y = clamp01(raw[1] as number);
  // keep the box inside the image — width/height can't run past the right/bottom edge
  const w = Math.min(clamp01(raw[2] as number), 1 - x);
  const h = Math.min(clamp01(raw[3] as number), 1 - y);
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

export async function POST(req: Request) {
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
      max_tokens: 2048, // boxes make the JSON long — too small truncates it
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

    // Tolerant parse — never throws on a long or slightly-truncated response,
    // so the user gets whatever items came back rather than a hard error.
    const rawItems = parsePartialItems(text);

    const names = new Set<string>();
    const boxes: Detection[] = [];
    for (const item of rawItems) {
      const name = item.name.trim().toLowerCase();
      if (!name) continue;
      names.add(name);

      const box = coerceBox(item.box);
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
