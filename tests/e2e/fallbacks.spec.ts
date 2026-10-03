import { test, expect } from "@playwright/test";
import { seedGame, uniqueId } from "./helpers";

test.describe("Fallbacks", () => {
  test("a game without cover art shows the placeholder instead of a broken image", async ({
    page,
  }) => {
    const title = `No Cover Game ${uniqueId()}`;
    await page.goto("/");
    await seedGame(page, { title, igdbId: uniqueId(), status: "owned" });

    await page.goto("/");
    const cover = page.getByRole("img", { name: title }).first();
    await expect(cover).toBeVisible();
    await expect(cover).toHaveAttribute("src", /placeholder-game-cover\.svg$/);
    await expect
      .poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test("an unknown API path answers with a JSON 404", async ({ page }) => {
    await page.goto("/");
    const response = await page.request.get("/api/does-not-exist");
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toMatch(/json/);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
