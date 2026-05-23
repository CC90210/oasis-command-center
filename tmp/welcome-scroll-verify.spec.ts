import { expect, test } from "@playwright/test";

test("welcome pinned agent remains visible while scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3104/welcome", { waitUntil: "networkidle" });

  const positions = [0, 0.18, 0.42, 0.72, 0.94];
  for (const [index, ratio] of positions.entries()) {
    await page.evaluate((amount) => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.round(max * amount));
    }, ratio);
    await page.waitForTimeout(350);

    const figureBox = await page.locator("svg[aria-hidden='true']").first().boundingBox();
    expect(figureBox, `figure visible at scroll ratio ${ratio}`).not.toBeNull();
    expect(figureBox!.height).toBeGreaterThan(200);

    await page.screenshot({ path: `tmp/welcome-scroll-${index}.png` });
  }
});
