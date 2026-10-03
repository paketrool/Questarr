import { describe, it, expect } from "vitest";
import { coverSrc } from "@/lib/cover";

describe("coverSrc", () => {
  it("keeps a real cover URL untouched", () => {
    const url = "https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg";
    expect(coverSrc(url)).toBe(url);
  });

  it.each([null, undefined, ""])("falls back to the bundled placeholder for %p", (value) => {
    expect(coverSrc(value)).toMatch(/\/placeholder-game-cover\.svg$/);
  });
});
