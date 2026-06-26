"use client";

import { useRef, useState, useCallback, type DragEvent, type KeyboardEvent } from "react";
import type { Recipe, Detection, IngredientsResponse, RecipeStreamEvent } from "@/lib/types";

const MAX_EDGE = 1024;

// Optional recipe constraints. Ids are sent to the API, which owns the mapping
// to prompt text (and ignores anything it doesn't recognize).
const PREFERENCES: { id: string; label: string }[] = [
  { id: "vegetarian", label: "Vegetarian" },
  { id: "vegan", label: "Vegan" },
  { id: "gluten-free", label: "Gluten-free" },
  { id: "dairy-free", label: "Dairy-free" },
  { id: "quick", label: "Quick (≤30 min)" },
  { id: "spicy", label: "Make it spicy" },
];

// Downscale + re-encode client-side so uploads stay small and the vision call is fast/cheap.
function processImage(file: File): Promise<{ dataUrl: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
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
  if (!res.ok) throw new Error(data.error || "Request failed. Try again.");
  return data as T;
}

// Stream recipes from the SSE endpoint, calling `onRecipes` with each snapshot
// as cards fill in. Resolves once the final `done` event arrives.
async function streamRecipes(
  ingredients: string[],
  preferences: string[],
  onRecipes: (recipes: Recipe[]) => void
): Promise<void> {
  const res = await fetch("/api/recipes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ingredients, preferences }),
  });

  // Validation/config failures come back as a plain JSON error, not a stream.
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Couldn't build recipes.");
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
          continue; // ignore anything unparseable
        }

        // Defensive even though we own the server: never trust the wire shape.
        if (event.type === "recipes" || event.type === "done") {
          if (Array.isArray(event.recipes)) onRecipes(event.recipes);
          if (event.type === "done") finished = true;
        } else if (event.type === "error") {
          throw new Error(typeof event.error === "string" ? event.error : "Couldn't build recipes.");
        }
      }
    }

    if (!finished) throw new Error("The recipe stream ended early. Try again.");
  } finally {
    // On any early exit (error/abort), cancel so the server stops generating.
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }
}

export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [newItem, setNewItem] = useState("");
  const [detected, setDetected] = useState(false); // a detection pass has completed
  const [prefs, setPrefs] = useState<string[]>([]); // sticky dietary/recipe filters
  const [boxes, setBoxes] = useState<Detection[]>([]); // detected-item locations for the overlay
  const [showLabels, setShowLabels] = useState(true);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (JPG, PNG, or WebP).");
      return;
    }
    setError(null);
    setRecipes([]);
    setIngredients([]);
    setBoxes([]);
    setDetected(false);

    let processed: { dataUrl: string; base64: string };
    try {
      processed = await processImage(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that image.");
      return;
    }
    setPreviewUrl(processed.dataUrl);

    setDetecting(true);
    try {
      const data = await postJson<IngredientsResponse>("/api/ingredients", {
        image: processed.base64,
        mediaType: "image/jpeg",
      });
      setIngredients(data.ingredients);
      setBoxes(Array.isArray(data.boxes) ? data.boxes : []);
      setDetected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the photo.");
    } finally {
      setDetecting(false);
    }
  }, []);

  // Run a bundled sample image through the same pipeline, so first-time
  // visitors can see the whole flow without a fridge photo handy.
  const loadExample = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/sample-pantry.svg");
      if (!res.ok) throw new Error("missing");
      const blob = await res.blob();
      await handleFile(new File([blob], "sample-pantry.svg", { type: "image/svg+xml" }));
    } catch {
      setError("Couldn't load the example. Try uploading a photo instead.");
    }
  }, [handleFile]);

  const reset = () => {
    setPreviewUrl(null);
    setIngredients([]);
    setBoxes([]);
    setRecipes([]);
    setError(null);
    setDetected(false);
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

  const findRecipes = async () => {
    setError(null);
    setCooking(true);
    setRecipes([]);
    try {
      await streamRecipes(ingredients, prefs, setRecipes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't build recipes.");
      setRecipes([]); // drop any half-streamed cards on failure
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

  const busy = detecting || cooking;
  // Labels follow the editable list: removing a chip removes its label too.
  const visibleBoxes = boxes.filter((b) => ingredients.includes(b.name));

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

      <section className="hero">
        <h1>
          Cook what you <span className="pop">have.</span>
        </h1>
        <p className="lede">
          Snap your fridge, pantry, or counter. Claude reads the shelves and hands back recipes
          you can actually make tonight.
        </p>
      </section>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        onChange={(e) => handleFile(e.target.files?.[0])}
        hidden
      />

      {!previewUrl ? (
        <>
          <div
            className={`drop${dragging ? " dragging" : ""}`}
            role="button"
            tabIndex={0}
            aria-label="Upload a photo of your ingredients"
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
            <span className="drop-title">Drop a photo, or tap to choose</span>
            <span className="drop-sub">A fridge, a pantry shelf, or whatever's on the counter</span>
          </div>
          <p className="example-line">
            No fridge handy?{" "}
            <button type="button" className="example-btn" onClick={loadExample} disabled={busy}>
              Try an example
            </button>
          </p>
        </>
      ) : (
        <div className="preview">
          <img src={previewUrl} alt="Your ingredients" />
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
            {boxes.length > 0 && (
              <button
                className="pill-btn"
                onClick={() => setShowLabels((v) => !v)}
                type="button"
                aria-pressed={showLabels}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M3 8.4V5a2 2 0 0 1 2-2h3.4a2 2 0 0 1 1.4.6l9 9a2 2 0 0 1 0 2.8l-4.6 4.6a2 2 0 0 1-2.8 0l-9-9A2 2 0 0 1 3 8.4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <circle cx="7.5" cy="7.5" r="1.4" fill="currentColor" />
                </svg>
                {showLabels ? "Hide labels" : "Show labels"}
              </button>
            )}
            <button className="pill-btn" onClick={reset} type="button">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 12a9 9 0 1 1 3 6.7M3 20v-5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Replace
            </button>
          </div>
        </div>
      )}

      {busy && (
        <div className="stages" aria-live="polite">
          <div className={`stage ${detecting ? "active" : "done"}`}>
            <span className="dot" />
            Reading the fridge
          </div>
          <div className={`stage ${cooking ? "active" : ""}`}>
            <span className="dot" />
            Writing recipes
          </div>
        </div>
      )}

      {error && (
        <div className="error" role="alert">
          <strong>Hmm. </strong>
          {error}
        </div>
      )}

      {detected && (
        <section className="panel">
          <div className="panel-head">
            <h2>{ingredients.length ? "Found these" : "Nothing obvious"}</h2>
            <span className="count">
              {ingredients.length} item{ingredients.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="hint">
            {ingredients.length
              ? "Remove anything wrong, add what the camera missed, then find recipes."
              : "The camera didn't catch much. Add a few ingredients by hand to get started."}
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
                placeholder="+ add item"
                aria-label="Add an ingredient"
              />
            </span>
          </div>

          {ingredients.length > 0 && (
            <div className="prefs-block">
              <p className="prefs-label">Preferences (optional)</p>
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
              onClick={findRecipes}
              disabled={cooking || ingredients.length === 0}
              type="button"
            >
              {cooking ? "Cooking up ideas…" : "Find recipes"}
              {!cooking && (
                <svg className="arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </section>
      )}

      {recipes.length > 0 && (
        <section className="recipes">
          <div className="recipes-head">
            {cooking
              ? "Cooking up ideas…"
              : `${recipes.length} idea${recipes.length === 1 ? "" : "s"} from your shelves`}
          </div>
          {recipes.map((r, i) => (
            <article
              className={`card${cooking && i === recipes.length - 1 ? " writing" : ""}`}
              key={`${r.title}-${i}`}
            >
              <h3 className="card-title">{r.title}</h3>
              {r.description && <p className="card-desc">{r.description}</p>}
              <div className="card-meta">
                {r.time && <span className="tag">{r.time}</span>}
                <span className={`tag diff-${r.difficulty}`}>{r.difficulty}</span>
              </div>

              {(r.uses.length > 0 || r.need.length > 0) && (
                <>
                  <p className="uses-label">What it uses</p>
                  <div className="uses">
                    {r.uses.map((u) => (
                      <span className="use" key={`u-${u}`}>
                        {u}
                      </span>
                    ))}
                    {r.need.map((n) => (
                      <span className="use extra" key={`n-${n}`}>
                        + {n}
                      </span>
                    ))}
                  </div>
                </>
              )}

              <ol className="steps">
                {r.steps.map((s, si) => (
                  <li key={si}>{s}</li>
                ))}
              </ol>
            </article>
          ))}
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
