import { describe, it, expect } from "vitest";
import { extractJson } from "../lib/anthropic";

describe("extractJson", () => {
  it("parses a plain JSON object", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a plain JSON array", () => {
    expect(extractJson<number[]>("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("pulls JSON out of surrounding prose", () => {
    expect(extractJson<{ ok: boolean }>('Sure! {"ok":true} hope that helps')).toEqual({ ok: true });
  });

  it("strips ```json code fences", () => {
    expect(extractJson<{ x: number }>('```json\n{"x":2}\n```')).toEqual({ x: 2 });
  });

  it("is string-aware: brackets inside string values don't break matching", () => {
    expect(extractJson<{ note: string }>('{"note":"use [these] {braces}"}')).toEqual({
      note: "use [these] {braces}",
    });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJson<{ t: string }>('{"t":"a \\"q\\" b"}')).toEqual({ t: 'a "q" b' });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });

  it("throws on truncated / unbalanced JSON", () => {
    expect(() => extractJson('{"a":[1,2')).toThrow();
  });
});
