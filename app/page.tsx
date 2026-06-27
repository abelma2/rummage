"use client";

import { useRef, useState, useCallback, type DragEvent, type KeyboardEvent } from "react";
import type {
  Recipe,
  Detection,
  DishIdea,
  IngredientsResponse,
  DishesResponse,
  RecipeStreamEvent,
} from "@/lib/types";

const MAX_EDGE = 1024;

// Optional recipe constraints. Ids are sent to the API, which owns the mapping
// to prompt text (and ignores anything it doesn't recognize).
const PREFERENCES: { id: string; label: string }[] = [
  { id: "vegetarian", label: "Vegetarian" },
  { id: "vegan", label: "Vegan" },
  { id: "gluten-free", label: "Gluten-free" },
  { id: "dairy-free", label: "Dairy-free" },
  { id: "quick", label: "Quick" },
  { id: "spicy", label: "Spicy" },
];

// Bundled real sample photos (in /public/examples) — one is picked at random.
const EXAMPLES = [
  "fridge_1.jpg",
  "fridge_2.jpg",
  "fridge_3.jpg",
  "fridge_4.jpg",
  "fridge_5.jpg",
  "pantry_1.jpg",
  "pantry_2.jpg",
  "pantry_3.jpg",
  "spice_2.jpg",
  "spice_3.jpg",
  "spices_1.jpg",
];

// One captured photo: its (downscaled) image plus the boxes detected in it.
type Shot = { id: number; url: string; boxes: Detection[] };

// Downscale + re-encode client-side so uploads stay small and the vision call is fast/cheap.
function processImage(file: File): Promise<{ dataUrl: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // naturalWidth/Height are the intrinsic dimensions — unlike width/height
      // they don't depend on layout, and they're 0 for an SVG without a size.
      let width = img.naturalWidth;
      let height = img.naturalHeight;
      if (!width || !height) {
        reject(new Error("That image has no readable size. Try a JPG or PNG."));
        return;
      }
      if (width >= height && width > MAX_EDGE) {
        height = Math.round((height * MAX_EDGE) / width);
        width = MAX_EDGE;
      } else if (height > MAX_EDGE) {
        width = Math.round((width * MAX_EDGE) / height);
        height = MAX_EDGE;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Your browser can't process images."));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      resolve({ dataUrl, base64: dataUrl.split(",")[1] ?? "" });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file didn't look like an image."));
    };
    img.src = url;
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data as T;
}

// Stream the recipe for a chosen dish, calling `onRecipes` with each snapshot as
// the card fills in. Resolves once the final `done` event arrives.
async function streamRecipes(
  ingredients: string[],
  preferences: string[],
  dish: string,
  onRecipes: (recipes: Recipe[]) => void
): Promise<void> {
  const res = await fetch("/api/recipes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ingredients, preferences, dish }),
  });

  // Validation/config failures come back as a plain JSON error, not a stream.
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Couldn't write that recipe.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload) continue;

        let event: RecipeStreamEvent;
        try {
          event = JSON.parse(payload) as RecipeStreamEvent;
        } catch {
          continue;
        }

        // Defensive even though we own the server: never trust the wire shape.
        if (event.type === "recipes" || event.type === "done") {
          if (Array.isArray(event.recipes)) onRecipes(event.recipes);
          if (event.type === "done") finished = true;
        } else if (event.type === "error") {
          throw new Error(typeof event.error === "string" ? event.error : "Couldn't write that recipe.");
        }
      }
    }

    if (!finished) throw new Error("The recipe stopped early. Try again.");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }
}

function Loading({ text }: { text: string }) {
  return (
    <div className="loading" aria-live="polite">
      <span className="spin-dot" />
      {text}
    </div>
  );
}

export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);

  // photo + ingredients
  const [shots, setShots] = useState<Shot[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const nextId = useRef(0);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<string[]>([]);
  const [showLabels, setShowLabels] = useState(true);
  const [newItem, setNewItem] = useState("");

  // dish menu + chosen recipe
  const [dishes, setDishes] = useState<DishIdea[]>([]);
  const [loadingDishes, setLoadingDishes] = useState(false);
  const [chosenDish, setChosenDish] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [cooking, setCooking] = useState(false);

  // flags
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const clearMenu = () => {
    setDishes([]);
    setLoadingDishes(false);
    setChosenDish(null);
    setRecipe(null);
  };

  // Add a photo: detected ingredients MERGE into the list (so a fridge shot, a
  // spice-cabinet shot, and a counter shot accumulate) rather than resetting it.
  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose a photo (JPG, PNG, or WebP).");
      return;
    }
    setError(null);
    clearMenu(); // the ingredient set is about to change

    let processed: { dataUrl: string; base64: string };
    try {
      processed = await processImage(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that photo.");
      return;
    }

    const id = nextId.current++;
    setShots((prev) => [...prev, { id, url: processed.dataUrl, boxes: [] }]);
    setActiveId(id);

    setDetecting(true);
    try {
      const data = await postJson<IngredientsResponse>("/api/ingredients", {
        image: processed.base64,
        mediaType: "image/jpeg",
      });
      const detectedBoxes = Array.isArray(data.boxes) ? data.boxes : [];
      setShots((prev) => prev.map((s) => (s.id === id ? { ...s, boxes: detectedBoxes } : s)));
      setIngredients((prev) => Array.from(new Set([...prev, ...data.ingredients])));
      setDetected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the photo.");
      setShots((prev) => prev.filter((s) => s.id !== id));
      setActiveId(null);
    } finally {
      setDetecting(false);
    }
  }, []);

  const loadExample = useCallback(async () => {
    setError(null);
    try {
      const name = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
      const res = await fetch(`/examples/${name}`);
      if (!res.ok) throw new Error("missing");
      const blob = await res.blob();
      await handleFile(new File([blob], name, { type: blob.type || "image/jpeg" }));
    } catch {
      setError("Couldn't load the example. Try a photo of your own instead.");
    }
  }, [handleFile]);

  const reset = () => {
    setShots([]);
    setActiveId(null);
    setIngredients([]);
    clearMenu();
    setError(null);
    setDetected(false);
    setShowLabels(true);
    if (fileInput.current) fileInput.current.value = "";
  };

  const removeIngredient = (name: string) =>
    setIngredients((prev) => prev.filter((i) => i !== name));

  const addIngredient = () => {
    const v = newItem.trim().toLowerCase();
    if (v && !ingredients.includes(v)) setIngredients((prev) => [...prev, v]);
    setNewItem("");
  };

  const togglePref = (id: string) =>
    setPrefs((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  const showDishes = async () => {
    setError(null);
    setLoadingDishes(true);
    setDishes([]);
    try {
      const data = await postJson<DishesResponse>("/api/dishes", { ingredients, preferences: prefs });
      setDishes(data.dishes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't find dishes.");
    } finally {
      setLoadingDishes(false);
    }
  };

  const cookDish = async (title: string) => {
    setError(null);
    setChosenDish(title);
    setRecipe(null);
    setCooking(true);
    try {
      await streamRecipes(ingredients, prefs, title, (r) => setRecipe(r[0] ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't write that recipe.");
      setChosenDish(null);
      setRecipe(null);
    } finally {
      setCooking(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  const openPicker = () => fileInput.current?.click();
  const onZoneKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  };

  const hasPhoto = shots.length > 0;
  const activeShot = shots.find((s) => s.id === activeId) ?? shots[shots.length - 1] ?? null;
  const visibleBoxes = activeShot ? activeShot.boxes.filter((b) => ingredients.includes(b.name)) : [];

  // Which of the three screens are we on?
  const screen: "capture" | "ideas" | "recipe" = chosenDish
    ? "recipe"
    : dishes.length > 0 || loadingDishes
      ? "ideas"
      : "capture";

  return (
    <div className="wrap">
      <header className="mast">
        <div className="brand">
          <svg className="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect x="7" y="3" width="18" height="26" rx="4" stroke="var(--ink)" strokeWidth="2" />
            <line x1="7" y1="13" x2="25" y2="13" stroke="var(--ink)" strokeWidth="2" />
            <line x1="11" y1="7" x2="11" y2="10" stroke="var(--herb)" strokeWidth="2" strokeLinecap="round" />
            <line x1="11" y1="17" x2="11" y2="21" stroke="var(--herb)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="wordmark">Rummage</span>
        </div>
        <span className="mast-note">
          built on{" "}
          <a href="https://docs.claude.com/en/api/overview" target="_blank" rel="noreferrer">
            Claude
          </a>
        </span>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          handleFile(f);
        }}
        hidden
      />

      {error && (
        <div className="error" role="alert">
          <strong>Hmm. </strong>
          {error}
        </div>
      )}

      {/* ───────── SCREEN 1 — photo + ingredients ───────── */}
      {screen === "capture" && (
        <>
          <section className="hero">
            <h1>
              Cook what you <span className="pop">have.</span>
            </h1>
            <p className="lede">
              Take a photo of your fridge, cupboard, or counter. We&apos;ll find what&apos;s there and
              help you cook it.
            </p>
          </section>

          {!hasPhoto ? (
            <>
              <div
                className={`drop${dragging ? " dragging" : ""}`}
                role="button"
                tabIndex={0}
                aria-label="Add a photo of your food"
                onClick={openPicker}
                onKeyDown={onZoneKey}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <svg className="drop-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M3 8a2 2 0 0 1 2-2h1.5l1-1.5A1 1 0 0 1 9.3 4h5.4a1 1 0 0 1 .8.5l1 1.5H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                  <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.7" />
                </svg>
                <span className="drop-title">Take a photo of your food</span>
                <span className="drop-sub">A fridge, a cupboard, or the counter — anything works</span>
              </div>
              <p className="example-line">
                No photo handy?{" "}
                <button type="button" className="example-btn" onClick={loadExample} disabled={detecting}>
                  Try an example
                </button>
              </p>
            </>
          ) : (
            <div className="capture">
              <div className="preview">
                {activeShot && <img src={activeShot.url} alt="Your food" />}
                {showLabels && visibleBoxes.length > 0 && (
                  <div className="anno-layer" aria-hidden="true">
                    {visibleBoxes.map((b, i) => (
                      <div
                        className="anno"
                        key={`${b.name}-${i}`}
                        style={{
                          left: `${b.box[0] * 100}%`,
                          top: `${b.box[1] * 100}%`,
                          width: `${b.box[2] * 100}%`,
                          height: `${b.box[3] * 100}%`,
                        }}
                      >
                        <span className="anno-label">{b.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="preview-tools">
                  {activeShot && activeShot.boxes.length > 0 && (
                    <button
                      className="pill-btn"
                      onClick={() => setShowLabels((v) => !v)}
                      type="button"
                      aria-pressed={showLabels}
                    >
                      {showLabels ? "Hide labels" : "Show labels"}
                    </button>
                  )}
                  <button className="pill-btn" onClick={reset} type="button">
                    Start over
                  </button>
                </div>
              </div>

              <div className="shots">
                {shots.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`shot-thumb${s.id === activeShot?.id ? " active" : ""}`}
                    onClick={() => setActiveId(s.id)}
                    aria-label={`Photo ${i + 1}`}
                    aria-pressed={s.id === activeShot?.id}
                  >
                    <img src={s.url} alt="" />
                  </button>
                ))}
                <button
                  type="button"
                  className="shot-add"
                  onClick={openPicker}
                  disabled={detecting}
                  aria-label="Add another photo"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Add photo
                </button>
              </div>
            </div>
          )}

          {detecting && <Loading text="Looking at your food…" />}

          {detected && (
            <section className="panel">
              <div className="panel-head">
                <h2>{ingredients.length ? "Here's what I see" : "Hmm, not much"}</h2>
                <span className="count">
                  {ingredients.length} item{ingredients.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="hint">
                {ingredients.length
                  ? "Tap × to remove anything wrong, or add what I missed."
                  : "I didn't catch much. Add a few things by hand to get started."}
              </p>
              <div className="chips">
                {ingredients.map((item) => (
                  <span className="chip" key={item}>
                    {item}
                    <button
                      className="chip-x"
                      onClick={() => removeIngredient(item)}
                      aria-label={`Remove ${item}`}
                      type="button"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <span className="chip-add">
                  <input
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addIngredient();
                      }
                    }}
                    placeholder="+ add"
                    aria-label="Add an ingredient"
                  />
                </span>
              </div>

              {ingredients.length > 0 && (
                <div className="prefs-block">
                  <p className="prefs-label">Any preferences?</p>
                  <div className="prefs">
                    {PREFERENCES.map((p) => {
                      const on = prefs.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`pref${on ? " on" : ""}`}
                          onClick={() => togglePref(p.id)}
                          aria-pressed={on}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="cta-row">
                <button
                  className="cta"
                  onClick={showDishes}
                  disabled={ingredients.length === 0}
                  type="button"
                >
                  Show me dishes
                  <svg className="arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {/* ───────── SCREEN 2 — pick a dish ───────── */}
      {screen === "ideas" && (
        <section className="step">
          <button className="back-btn" type="button" onClick={() => clearMenu()}>
            ← Back to my food
          </button>
          <h1 className="step-title">Tap one to cook</h1>
          {loadingDishes ? (
            <Loading text="Thinking of dishes…" />
          ) : (
            <div className="menu">
              {dishes.map((d, i) => (
                <button className="dish" key={`${d.title}-${i}`} type="button" onClick={() => cookDish(d.title)}>
                  <span className="dish-emoji" aria-hidden="true">
                    {d.emoji}
                  </span>
                  <span className="dish-body">
                    <span className="dish-title">{d.title}</span>
                    {d.blurb && <span className="dish-blurb">{d.blurb}</span>}
                    <span className="dish-meta">
                      {d.time && <span className="tag">{d.time}</span>}
                      <span className={`tag diff-${d.difficulty}`}>{d.difficulty}</span>
                    </span>
                  </span>
                  <svg className="dish-go" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ───────── SCREEN 3 — the recipe ───────── */}
      {screen === "recipe" && (
        <section className="step">
          <button className="back-btn" type="button" onClick={() => { setChosenDish(null); setRecipe(null); }}>
            ← See other dishes
          </button>
          {!recipe ? (
            <Loading text="Writing your recipe…" />
          ) : (
            <article className={`card cook-card${cooking ? " writing" : ""}`}>
              <h1 className="cook-title">{recipe.title}</h1>
              {recipe.description && <p className="card-desc">{recipe.description}</p>}
              <div className="card-meta">
                {recipe.time && <span className="tag">{recipe.time}</span>}
                <span className={`tag diff-${recipe.difficulty}`}>{recipe.difficulty}</span>
              </div>

              {(recipe.uses.length > 0 || recipe.need.length > 0) && (
                <>
                  <p className="uses-label">What you&apos;ll use</p>
                  <div className="uses">
                    {recipe.uses.map((u) => (
                      <span className="use" key={`u-${u}`}>
                        {u}
                      </span>
                    ))}
                    {recipe.need.map((n) => (
                      <span className="use extra" key={`n-${n}`}>
                        + {n}
                      </span>
                    ))}
                  </div>
                </>
              )}

              <ol className="steps big-steps">
                {recipe.steps.map((s, si) => (
                  <li key={si}>{s}</li>
                ))}
              </ol>

              {!cooking && (
                <button className="restart-btn" type="button" onClick={reset}>
                  Start over with a new photo
                </button>
              )}
            </article>
          )}
        </section>
      )}

      <footer className="foot">
        <span>Rummage · a multimodal demo</span>
        <span>
          vision + generation via{" "}
          <a href="https://www.anthropic.com" target="_blank" rel="noreferrer">
            Claude
          </a>
        </span>
      </footer>
    </div>
  );
}
