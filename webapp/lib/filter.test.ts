import { describe, expect, it } from "vitest";
import {
  advancedIsActive,
  countAdvanced,
  emptyAdvanced,
  normalizeAdvanced,
  type Advanced,
} from "@/lib/filter";

/**
 * `normalizeAdvanced` is the boundary every externally-stored filter set
 * crosses: saved views out of JSONB, preferences out of the API, drafts
 * out of sessionStorage. All three were written by older versions of this
 * type, so the cases below are the shapes that actually arrive — not
 * hypotheticals.
 */
describe("normalizeAdvanced", () => {
  it("fills in fields a saved view predates", () => {
    // Views stored before `articleTypes` and `subjectCountries` existed
    // lack those fields; reading them unguarded would throw.
    const legacy = { query: "macron", categories: ["Politics"] };

    const out = normalizeAdvanced(legacy as Partial<Advanced>);

    expect(out.articleTypes).toEqual([]);
    expect(out.subjectCountries).toEqual([]);
    expect(out.query).toBe("macron");
    expect(out.categories).toEqual(["Politics"]);
  });

  it("accepts null and undefined as an empty filter set", () => {
    expect(normalizeAdvanced(null)).toEqual(emptyAdvanced);
    expect(normalizeAdvanced(undefined)).toEqual(emptyAdvanced);
  });

  it("drops legacy entity filters stored as surface forms", () => {
    // Older saved views stored entities as free-text names; they are
    // canonical ids now. A stale view must come back empty rather than carry names
    // into a resolver that will compare them against integers.
    const out = normalizeAdvanced({
      persons: ["Emmanuel Macron"],
      orgs: ["BCE"],
    } as unknown as Partial<Advanced>);

    expect(out.persons).toEqual([]);
    expect(out.orgs).toEqual([]);
  });

  it("keeps numeric entity ids, including ones stored as strings", () => {
    const out = normalizeAdvanced({
      persons: [42, "1337"],
    } as unknown as Partial<Advanced>);

    expect(out.persons).toEqual([42, 1337]);
  });

  it("rejects zero and negatives, which are not valid entity ids", () => {
    const out = normalizeAdvanced({
      places: [0, -1, 7, 3.5],
    } as unknown as Partial<Advanced>);

    expect(out.places).toEqual([7]);
  });

  it("never returns the shared empty constant", () => {
    // Callers mutate what they get back. Handing out `emptyAdvanced`
    // itself would let one screen's edit leak into every other.
    const out = normalizeAdvanced(null);
    expect(out).not.toBe(emptyAdvanced);
  });
});

describe("advancedIsActive", () => {
  it("is false for an empty filter set", () => {
    expect(advancedIsActive(emptyAdvanced)).toBe(false);
  });

  it("ignores a query made only of whitespace", () => {
    expect(advancedIsActive({ ...emptyAdvanced, query: "   " })).toBe(false);
  });

  it("is true as soon as one criterion is set", () => {
    expect(advancedIsActive({ ...emptyAdvanced, langs: ["fr"] })).toBe(true);
    expect(advancedIsActive({ ...emptyAdvanced, periodMinutes: 180 })).toBe(true);
  });

  it("survives a field that is missing entirely", () => {
    // Defence in depth: a shape that skipped normalisation must degrade
    // to "filter looks off", never to a crash mid-render.
    const partial = { ...emptyAdvanced, keywords: undefined };
    expect(() =>
      advancedIsActive(partial as unknown as Advanced),
    ).not.toThrow();
  });
});

/**
 * This number is the badge on the "Filtres" button, so it is what tells
 * someone how much is currently narrowing their feed.
 */
describe("countAdvanced", () => {
  it("counts nothing when nothing is set", () => {
    expect(countAdvanced(emptyAdvanced)).toBe(0);
  });

  it("counts every value, not every criterion", () => {
    const a: Advanced = {
      ...emptyAdvanced,
      langs: ["fr", "en", "de"],
      categories: ["Politics"],
    };
    expect(countAdvanced(a)).toBe(4);
  });

  it("counts a period as one whatever its length", () => {
    expect(countAdvanced({ ...emptyAdvanced, periodMinutes: 4320 })).toBe(1);
  });

  it("does not count the text query", () => {
    // Deliberate, and worth pinning: the query has its own visible input
    // in the list header, so counting it again in the badge would tell
    // someone a filter is hidden behind a dialog when it is in plain
    // sight. Change this only on purpose.
    expect(countAdvanced({ ...emptyAdvanced, query: "macron" })).toBe(0);
  });
});
