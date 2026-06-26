import Anthropic from "@anthropic-ai/sdk";

/** The model used for both vision and generation. Override via ANTHROPIC_MODEL. */
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

let client: Anthropic | null = null;

/**
 * Returns a singleton Anthropic client.
 * Throws a readable error if the API key is missing so the first run is obvious.
 */
export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (local) or your Vercel project settings (deployed)."
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Models sometimes wrap JSON in prose or ```json fences. This pulls the first
 * JSON value out of a string and parses it, throwing if nothing valid is found.
 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;

  // Find the first {...} or [...] block.
  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new Error("No JSON found in model response.");
  }

  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("Malformed JSON in model response.");
  }

  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
