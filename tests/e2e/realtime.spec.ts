import { test, expect, type Page } from "@playwright/test";

/**
 * Open a raw Socket.IO v4 websocket from the page and report how the server
 * answered the namespace connect: "connected" or the rejection message.
 */
function socketHandshake(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const url = `${location.origin.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
        const ws = new WebSocket(url);
        const timer = setTimeout(() => resolve("timeout"), 10_000);
        ws.onmessage = (event) => {
          const data = String(event.data);
          // "0{...}" is the Engine.IO open packet; answer with a namespace connect.
          if (data.startsWith("0")) ws.send("40");
          else if (data.startsWith("40")) finish("connected");
          else if (data.startsWith("44")) finish(JSON.parse(data.slice(2)).message as string);
        };
        ws.onerror = () => finish("error");
        function finish(result: string) {
          clearTimeout(timer);
          ws.close();
          resolve(result);
        }
      })
  );
}

test.describe("Real-time updates", () => {
  test("a signed-in browser gets a live socket", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /My Library/i })).toBeVisible();
    expect(await socketHandshake(page)).toBe("connected");
  });

  test.describe("without a session", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("the socket refuses to stream logs and notifications", async ({ page }) => {
      await page.goto("/login");
      expect(await socketHandshake(page)).toBe("Authentication required");
    });
  });
});
