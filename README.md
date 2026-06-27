# 🥬 Rummage

**Photograph your fridge. Get recipes you can actually make.**

Rummage is a small multimodal web app: point your camera at a fridge, pantry, or
counter, and it reads the shelves and suggests dishes built around what you already
have. One clean flow — upload, detect, cook — built on [Claude](https://www.anthropic.com).

<!-- Replace with a screenshot or GIF of the app once deployed -->
<!-- ![Rummage](./docs/screenshot.png) -->

🔗 **Live demo:** _add your Vercel URL here_

---

## How it works

It's a guided, three-step flow so each beat of the "multimodal" story is visible:

1. **See it** — the photo is downscaled in the browser, then sent to Claude's vision
   model, which returns a structured list of the food it can identify — plus rough
   locations, so detected items are **labelled right on your photo**.
2. **Choose it** — you tweak the detected ingredients (remove misreads, add what the
   camera missed), optionally flip on dietary filters (vegetarian, gluten-free,
   quick, …), and Claude suggests a **menu of dish ideas** — cheap to generate, since
   they're just titles, not full recipes.
3. **Cook it** — tap a dish and Claude writes **just that one** recipe, **streamed
   live** (the card fills in token-by-token). Generating one chosen recipe instead of
   three keeps the API spend down.

A few details worth noting:

- **Client-side image downscaling.** Photos are resized to ~1024px and re-encoded as
  JPEG in the browser before upload (`app/page.tsx`). Smaller payloads mean faster,
  cheaper vision calls — a multi-megabyte phone photo becomes a couple hundred KB.
- **Defensive JSON parsing.** Models occasionally wrap JSON in prose or code fences,
  so responses are extracted and validated server-side (`lib/anthropic.ts`) rather
  than trusted blindly, then coerced into typed shapes.
- **Streaming structured output.** The recipe step streams over SSE. A tolerant
  parser (`lib/recipes.ts`) reads the still-incomplete JSON on the server and emits
  best-effort recipe snapshots as they form — only ever parsing text that's already
  balanced, never guessing at a truncated token. The final, strictly-validated
  parse is authoritative, so the live view is display-only and self-correcting.
- **You stay in control.** Detection is a suggestion, not the final word — the
  ingredient list is fully editable before any recipe is generated.
- **Snap more than one.** Add several photos — the fridge, the spice cabinet, the
  counter — and the detected ingredients accumulate into a single list.
- **Try it without a fridge.** A set of bundled sample photos (`public/examples/`)
  powers a "Try an example" button — it picks one at random, so first-time visitors
  can run the whole flow in one click.

## Tech stack

- **[Next.js 16](https://nextjs.org)** (App Router) + **React 19** + **TypeScript**
- **[Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)** for vision + generation
- Three serverless route handlers (`/api/ingredients`, `/api/dishes`, `/api/recipes`)
- Hand-written CSS design system — no UI framework
- Deploys to **[Vercel](https://vercel.com)** with zero config

## Run it locally

```bash
git clone https://github.com/abelma2/rummage.git
cd rummage
npm install

cp .env.example .env.local
# then open .env.local and paste your Anthropic API key

npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll need an API key from the
[Anthropic console](https://console.anthropic.com/settings/keys).

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/abelma2/rummage&env=ANTHROPIC_API_KEY&envDescription=Your%20Anthropic%20API%20key)

Or manually:

1. Push the repo to GitHub.
2. Import it at [vercel.com/new](https://vercel.com/new).
3. Add an `ANTHROPIC_API_KEY` environment variable.
4. Deploy.

## Configuration

| Variable                   | Required | Default              | Notes                                                          |
| -------------------------- | -------- | -------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | yes      | —                    | From the Anthropic console.                                    |
| `ANTHROPIC_MODEL`          | no       | `claude-sonnet-4-6`  | Swap to `claude-haiku-4-5-20251001` to cut cost.               |
| `UPSTASH_REDIS_REST_URL`   | no       | —                    | Enables the per-IP rate limit (see below). Unset = no limit.   |
| `UPSTASH_REDIS_REST_TOKEN` | no       | —                    | Paired with the URL above.                                     |
| `RATELIMIT_PER_DAY`        | no       | `30`                 | Requests per IP per day once rate limiting is enabled.         |

A run makes a vision call, then a cheap "dish ideas" call, then one recipe call
per dish you actually cook — so browsing ideas is inexpensive. Sonnet keeps
quality high; Haiku is noticeably cheaper if you're sharing a public demo.

### Protecting a public demo

The API routes call a **paid** model with **your** key, so a public link is a
spend risk. All three routes are guarded by a per-IP daily rate limit
(`lib/ratelimit.ts`). It's **off until you configure it**: create a free
[Upstash](https://upstash.com) Redis database, set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`, and redeploy. The guard fails open — if Upstash is
unreachable, requests are allowed rather than blocked — so it never takes the
app down.

## Project structure

```
app/
  api/ingredients/route.ts   # photo  → detected ingredients + boxes (vision)
  api/dishes/route.ts        # items  → a cheap menu of dish ideas
  api/recipes/route.ts       # chosen dish → one streamed recipe (SSE)
  page.tsx                   # the whole UI (photo → pick a dish → recipe)
  layout.tsx                 # fonts + metadata
  globals.css                # design system
lib/
  anthropic.ts               # client + resilient JSON extraction
  recipes.ts                 # dish/recipe coercion + tolerant partial parser
  ratelimit.ts               # optional per-IP daily cap (Upstash)
  types.ts                   # shared types + model config
public/
  examples/                  # bundled sample photos for "Try an example"
```

## Ideas for next steps

- "Cook mode" — step-by-step view with timers
- A shareable URL for a generated recipe

## License

MIT — see [LICENSE](./LICENSE).
