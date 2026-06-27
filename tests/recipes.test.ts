import { describe, it, expect } from "vitest";
import {
  coerceRecipe,
  coerceRecipes,
  parsePartialRecipes,
  parsePartialItems,
  coerceDish,
  coerceDishes,
  constraintsFromPreferences,
  equipmentConstraint,
} from "../lib/recipes";

// A realistic streamed response: a comma in a title, escaped quotes, and
// literal brackets inside strings — the things that trip up naive parsers.
const FULL = JSON.stringify({
  recipes: [
    {
      title: "Garlic Butter Pasta, the Easy Way",
      description: 'A quick, comforting weeknight dish — uses "what you have".',
      time: "20 min",
      difficulty: "easy",
      uses: ["pasta", "garlic", "butter", "parmesan"],
      need: ["salt", "black pepper"],
      steps: [
        "Boil the pasta in salted water until al dente.",
        "Melt butter with sliced garlic over low heat.",
        "Toss drained pasta with the garlic butter [reserve some pasta water].",
        "Finish with grated parmesan and pepper.",
      ],
    },
    {
      title: 'Spinach & Egg "Breakfast" Skillet',
      description: "Eggs and greens, ready in one pan.",
      time: "12 min",
      difficulty: "easy",
      uses: ["eggs", "baby spinach", "cheddar"],
      need: ["olive oil"],
      steps: ["Wilt spinach in a little oil.", "Scramble in the eggs.", "Fold in cheddar off the heat."],
    },
    {
      title: "Tomato Soup, Two Ways",
      description: "Use up ripe tomatoes fast.",
      time: "35 min",
      difficulty: "medium",
      uses: ["tomatoes", "onion", "garlic"],
      need: ["stock", "cream"],
      steps: ["Soften onion and garlic.", "Add tomatoes and stock; simmer.", "Blend and swirl in cream."],
    },
  ],
});

describe("coerceRecipe", () => {
  it("coerces a well-formed recipe", () => {
    const r = coerceRecipe({
      title: "  Toast  ",
      description: "  good  ",
      time: "5 min",
      difficulty: "easy",
      uses: ["bread"],
      need: [],
      steps: ["toast it"],
    });
    expect(r).toEqual({
      title: "Toast",
      description: "good",
      time: "5 min",
      difficulty: "easy",
      uses: ["bread"],
      need: [],
      steps: ["toast it"],
    });
  });

  it("returns null without a usable title", () => {
    expect(coerceRecipe({ title: "   ", steps: ["x"] })).toBeNull();
    expect(coerceRecipe({ steps: ["x"] })).toBeNull();
    expect(coerceRecipe(null)).toBeNull();
    expect(coerceRecipe("nope")).toBeNull();
  });

  it("defaults an invalid difficulty to medium", () => {
    expect(coerceRecipe({ title: "x", difficulty: "spicy-hot" })?.difficulty).toBe("medium");
    expect(coerceRecipe({ title: "x" })?.difficulty).toBe("medium");
    expect(coerceRecipe({ title: "x", difficulty: "involved" })?.difficulty).toBe("involved");
  });

  it("drops non-string array entries and trims", () => {
    const r = coerceRecipe({ title: "x", uses: ["a", 2, null, "  b  ", ""] });
    expect(r?.uses).toEqual(["a", "b"]);
  });

  it("caps uses(12) / need(8) / steps(10)", () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);
    const r = coerceRecipe({ title: "x", uses: big(20), need: big(20), steps: big(20) });
    expect(r?.uses).toHaveLength(12);
    expect(r?.need).toHaveLength(8);
    expect(r?.steps).toHaveLength(10);
  });
});

describe("coerceRecipes", () => {
  it("reads {recipes:[...]}", () => {
    expect(coerceRecipes({ recipes: [{ title: "a" }, { title: "b" }] })).toHaveLength(2);
  });
  it("reads a bare array", () => {
    expect(coerceRecipes([{ title: "a" }])).toHaveLength(1);
  });
  it("drops invalid entries and caps at 3", () => {
    expect(coerceRecipes({ recipes: [{ title: "a" }, {}, { title: "b" }, { title: "c" }, { title: "d" }] })).toHaveLength(3);
  });
  it("returns [] for junk", () => {
    expect(coerceRecipes(null)).toEqual([]);
    expect(coerceRecipes("nope")).toEqual([]);
  });
});

describe("parsePartialRecipes", () => {
  it("never throws and grows monotonically over every prefix, converging to the strict parse", () => {
    let prevCount = 0;
    const prevLens: number[][] = [];
    for (let i = 0; i <= FULL.length; i++) {
      const recipes = parsePartialRecipes(FULL.slice(0, i));
      expect(Array.isArray(recipes)).toBe(true);
      expect(recipes.length).toBeLessThanOrEqual(3);
      expect(recipes.length).toBeGreaterThanOrEqual(prevCount); // count never shrinks
      prevCount = recipes.length;
      recipes.forEach((r, idx) => {
        const cur = [r.title.length, r.description.length, r.uses.length, r.need.length, r.steps.length];
        const prev = prevLens[idx];
        if (prev) cur.forEach((v, k) => expect(v).toBeGreaterThanOrEqual(prev[k])); // fields never shrink
        prevLens[idx] = cur;
      });
    }
    expect(JSON.stringify(parsePartialRecipes(FULL))).toBe(JSON.stringify(coerceRecipes(JSON.parse(FULL))));
  });

  it("streams array items incrementally (steps appear one at a time)", () => {
    const counts = new Set<number>();
    for (let i = 0; i <= FULL.length; i++) {
      const r = parsePartialRecipes(FULL.slice(0, i))[0];
      if (r) counts.add(r.steps.length);
    }
    expect(counts.has(1)).toBe(true);
    expect(counts.has(2)).toBe(true);
    expect(counts.has(3)).toBe(true);
  });

  it("final parse keeps tricky strings intact", () => {
    const r = parsePartialRecipes(FULL);
    expect(r[0].title).toBe("Garlic Butter Pasta, the Easy Way");
    expect(r[1].title).toBe('Spinach & Egg "Breakfast" Skillet');
    expect(r[0].steps[2]).toContain("[reserve some pasta water]");
  });

  it("handles code-fenced and prose-wrapped input", () => {
    const strict = coerceRecipes(JSON.parse(FULL));
    expect(parsePartialRecipes("```json\n" + FULL + "\n```")).toEqual(strict);
    expect(parsePartialRecipes("Here you go:\n" + FULL)).toEqual(strict);
  });

  it("falls back to a bare array and survives junk", () => {
    expect(parsePartialRecipes(JSON.stringify([{ title: "X", steps: ["a"] }]))).toHaveLength(1);
    for (const junk of ["", "{", "[", "not json", '{"recipes"', '{"recipes":[', '{"recipes":[{']) {
      expect(parsePartialRecipes(junk)).toEqual([]);
    }
  });
});

describe("parsePartialItems", () => {
  it("extracts {name, box} from {items:[...]}", () => {
    const items = parsePartialItems('{"items":[{"name":"eggs","box":[0.1,0.2,0.3,0.4]},{"name":"milk"}]}');
    expect(items.map((i) => i.name)).toEqual(["eggs", "milk"]);
    expect(items[0].box).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("tolerates a truncated trailing item (the bug that crashed a busy photo)", () => {
    const items = parsePartialItems('{"items":[{"name":"eggs","box":[0.1,0.2,0.3,0.4]},{"name":"che');
    expect(items.map((i) => i.name)).toEqual(["eggs"]); // partial last item is dropped, not thrown
  });

  it("reads a bare array and returns [] for junk", () => {
    expect(parsePartialItems('[{"name":"apple"}]').map((i) => i.name)).toEqual(["apple"]);
    expect(parsePartialItems("not json")).toEqual([]);
    expect(parsePartialItems("")).toEqual([]);
  });
});

describe("coerceDish / coerceDishes", () => {
  it("coerces a dish and defaults the emoji + difficulty", () => {
    expect(coerceDish({ title: "Soup", blurb: "warm", time: "20 min" })).toEqual({
      title: "Soup",
      emoji: "🍽️",
      blurb: "warm",
      time: "20 min",
      difficulty: "medium",
    });
  });
  it("keeps a provided emoji and valid difficulty", () => {
    const d = coerceDish({ title: "Tacos", emoji: "🌮", difficulty: "easy" });
    expect(d?.emoji).toBe("🌮");
    expect(d?.difficulty).toBe("easy");
  });
  it("requires a title", () => {
    expect(coerceDish({ blurb: "x" })).toBeNull();
  });
  it("reads {dishes:[...]} and caps at 8", () => {
    const many = { dishes: Array.from({ length: 12 }, (_, i) => ({ title: `d${i}` })) };
    expect(coerceDishes(many)).toHaveLength(8);
  });
});

describe("constraintsFromPreferences", () => {
  it("maps known ids to constraint sentences", () => {
    const c = constraintsFromPreferences(["vegetarian", "quick"]);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatch(/vegetarian/i);
  });
  it("ignores unknown ids and dedups", () => {
    expect(constraintsFromPreferences(["vegan", "made-up", "vegan"])).toHaveLength(1);
  });
  it("returns [] for non-arrays", () => {
    expect(constraintsFromPreferences(undefined)).toEqual([]);
    expect(constraintsFromPreferences("vegan")).toEqual([]);
  });
});

describe("equipmentConstraint", () => {
  it("turns selected equipment into one 'only use' constraint", () => {
    const c = equipmentConstraint(["microwave"]);
    expect(typeof c).toBe("string");
    expect(c).toMatch(/microwave/i);
    expect(c).toMatch(/ONLY use/);
  });
  it("combines multiple items, dedups, and ignores unknown ids", () => {
    const c = equipmentConstraint(["stovetop", "pan", "stovetop", "made-up"]) ?? "";
    expect(c).toMatch(/stovetop/i);
    expect(c).toMatch(/pan|skillet/i);
    expect(c).not.toMatch(/made-up/i);
  });
  it("returns null when nothing valid is selected", () => {
    expect(equipmentConstraint([])).toBeNull();
    expect(equipmentConstraint(["made-up"])).toBeNull();
    expect(equipmentConstraint(undefined)).toBeNull();
    expect(equipmentConstraint("microwave")).toBeNull();
  });
});
