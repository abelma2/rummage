# Rummage

**Photograph your fridge. Get recipes you can actually make.**

[![CI](https://github.com/abelma2/rummage/actions/workflows/ci.yml/badge.svg)](https://github.com/abelma2/rummage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Rummage is a small multimodal web app: point your camera at a fridge, pantry, or
counter, and it reads the shelves and helps you cook what's already there. One
guided flow — photograph, pick a dish, cook.

**Live demo:** _add your Vercel URL here_

<!-- Add a screenshot or short GIF of the app here once deployed: -->
<!-- ![Rummage](./docs/screenshot.png) -->

---

## Highlights

- **Multimodal pipeline:** a photo becomes a structured ingredient list, a cheap
  menu of dish ideas, then one full recipe — each step a distinct API call.
- **Streaming structured output:** the recipe streams over SSE and renders as it
  arrives, parsed by a tolerant, self-correcting JSON reader.
- **Annotated photo:** detected items are labelled right on the uploaded image.
- **Defensive by default:** model output is extracted, validated, and coerced
  into typed shapes — never trusted blindly.
- **Tested:** a Vitest suite covers the parsers and coercion, run in CI on every
  push (type-check, tests, production build).

## How it works

A guided, three-step flow, so each beat of the multimodal story is visible:

1. **See it** — the photo is downscaled in the browser, then sent to Claude's
   vision model, which returns a structured list of the food it can identify,
   plus rough locations so detected items are labelled right on your photo.
2. **Choose it** — you tweak the detected ingredients (remove misreads, add what
   the camera missed), optionally set dietary filters and what you can cook with
   (microwave only, oven only, and so on), and Claude suggests a menu of dish
   ideas — cheap to generate, since they're just titles, not full recipes.
3. **Cook it** — tap a dish and Claude writes just that one recipe, streamed live
   (the card fills in token by token). Generating one chosen recipe instead of
   three keeps the API spend down.

A few details worth noting:

- **Client-side image downscaling.** Photos are resized to ~1024px and re-encoded
  as JPEG in the browser before upload (`app/page.tsx`). Smaller payloads mean
  faster, cheaper vision calls — a multi-megabyte phone photo becomes a couple
  hundred KB.
- **Defensive JSON parsing.** Models occasionally wrap JSON in prose or code
  fences, so responses are extracted and validated server-side
  (`lib/anthropic.ts`) rather than trusted blindly, then coerced into typed
  shapes.
- **Streaming structured output.** The recipe step streams over SSE. A tolerant
  parser (`lib/recipes.ts`) reads the still-incomplete JSON on the server and
  emits best-effort recipe snapshots as they form — only ever parsing text
  that's already balanced, never guessing at a truncated token. The final,
  strictly-validated parse is authoritative, so the live view is display-only
  and self-correcting.
- **You stay in control.** Detection is a suggestion, not the final word — the
  ingredient list is fully editable before any recipe is generated.
- **Snap more than one.** Add several photos — the fridge, the spice cabinet, the
  counter — and the detected ingredients accumulate into a single list.
- **Try it without a fridge.** A set of bundled sample photos (`public/examples/`)
  powers a "Try an example" button — it picks one at random, so first-time
  visitors can run the whole flow in one click.

## Tech stack

- **[Next.js 16](https://nextjs.org)** (App Router) + **React 19** + **TypeScript**
- **[Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)** for vision and generation
- Three serverless route handlers (`/api/ingredients`, `/api/dishes`, `/api/recipes`)
- Hand-written CSS design system — no UI framework
- **[Vitest](https://vitest.dev)** + GitHub Actions for tests and CI
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

Open [http://localhost:3000](http://localhost:3000). You'll need an API key from
the [Anthropic console](https://console.anthropic.com/settings/keys).

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/abelma2/rummage&env=ANTHROPIC_API_KEY&envDescription=Your%20Anthropic%20API%20key)

Or manually:

1. Push the repo to GitHub.
2. Import it at [vercel.com/new](https://vercel.com/new).
3. Add an `ANTHROPIC_API_KEY` environment variable.
4. Deploy.

## Configuration

| Variable            | Required | Default             | Notes                                            |
| ------------------- | -------- | ------------------- | ------------------------------------------------ |
| `ANTHROPIC_API_KEY` | yes      | —                   | From the Anthropic console.                      |
| `ANTHROPIC_MODEL`   | no       | `claude-sonnet-4-6` | Swap to `claude-haiku-4-5-20251001` to cut cost. |

A run makes a vision call, then a cheap "dish ideas" call, then one recipe call
per dish you actually cook — so browsing ideas is inexpensive. Sonnet keeps
quality high; Haiku is noticeably cheaper if you're sharing a public demo.

## Project structure

```
app/
  api/ingredients/route.ts   # photo        -> detected ingredients + boxes (vision)
  api/dishes/route.ts        # ingredients  -> a cheap menu of dish ideas
  api/recipes/route.ts       # chosen dish  -> one streamed recipe (SSE)
  page.tsx                   # the whole UI (photo -> pick a dish -> recipe)
  layout.tsx                 # fonts + metadata
  globals.css                # design system
lib/
  anthropic.ts               # client + resilient JSON extraction
  recipes.ts                 # dish/recipe coercion + tolerant partial parser
  types.ts                   # shared types + model config
public/
  examples/                  # bundled sample photos for "Try an example"
tests/                       # Vitest unit tests (parsers + coercion)
```

## Tests

```bash
npm test         # run the Vitest suite (parsers, coercion, the tolerant JSON parser)
npm run typecheck
```

CI (GitHub Actions) runs the type-check, tests, and a production build on every
push and pull request — see the badge at the top.

## Ideas for next steps

- Cook mode — a step-by-step view with timers
- A shareable URL for a generated recipe

## License

MIT — see [LICENSE](./LICENSE).
