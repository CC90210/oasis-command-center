"""tests/tools-grid.browser.py - the Video extractor card driven in a real browser.

The real components (ToolGrid, ContentTabs, RefreshOnToolRun) are bundled by
scripts/test-content-tools-browser.mjs and mounted with synthetic API answers:
no session, no database, no runner, no network beyond localhost. Each case runs
in a fresh browser context (its own localStorage).

Pins the lifecycle CC asked for on 2026-10-25:
  - a finished run is in review (Video extracted, Download, Open in Extracted
    videos, Done) with the form still under it; Done returns the card to idle
    with the Link field focused, and a re-read from the server leaves it idle;
  - a second link queues while the first downloads, and both show their stage;
  - a fresh visit after Done starts idle even though the server still lists
    the run; the history drawer lists it with its links, and leads to the list;
  - idle -> Extract video -> Waiting -> Downloading -> Uploading -> review ->
    Done -> idle, and the page is told the run finished; a run that comes back
    already finished (a worker tool) tells it too;
  - Refresh in the running state reads at once;
  - a read that started before a run was accepted never replaces it;
  - a failed read says so, offers Try again, and recovers;
  - a run request with no answer is retried under the same idempotency key;
  - a failed run offers Try again (the link comes back) and Dismiss;
  - the offline card offers Check connection, which asks the page to refresh,
    and no Run button;
  - no Extracted videos tab; Content Tools is current on this page;
  - no horizontal overflow at 360 px.

Run: OASIS_TEST_PYTHON=<python with playwright + chromium> npm run test:content-tools-browser
"""
import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright, expect

BASE = sys.argv[1]
TOOLS = BASE + "/founders/marketing/tools"
URL = "https://www.youtube.com/watch?v=fixture1234"
URL2 = "https://www.youtube.com/watch?v=fixture5678"
DONE_KEY = "oasis:tools:video_download:done-through"
OLD = dict(
    id="old", tool_key="video_download", status="done", stage=None,
    created_at="2026-10-25T10:00:00.000Z", updated_at="2026-10-25T10:05:00.000Z",
    finished_at="2026-10-25T10:05:00.000Z", input_summary=URL,
    result={"asset_id": "old-asset", "title": "An older video", "platform": "youtube"},
    error_code=None, error_message=None, asset_id="old-asset",
)
NEW = dict(
    OLD, id="new", status="queued", created_at="2026-10-25T11:00:00.000Z",
    updated_at="2026-10-25T11:00:00.000Z", finished_at=None, result=None, asset_id=None,
)
NEW_DONE = dict(
    NEW, status="done", finished_at="2026-10-25T11:03:00.000Z",
    result={"asset_id": "new-asset", "title": "The new video", "platform": "youtube"}, asset_id="new-asset",
)
FAILED = dict(
    OLD, id="bad", status="failed", created_at="2026-10-25T12:00:00.000Z", result=None, asset_id=None,
    error_code="download_failed", error_message="That link couldn't be downloaded.",
)
SHOTS = Path("tmp/content-tools-browser")


async def answer(route, payload, status=200):
    await route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))


def jobs_route(page, state):
    """Answer the runs read from state['jobs'], counting reads in state['reads']."""
    async def handler(route):
        state["reads"] = state.get("reads", 0) + 1
        await answer(route, {"ok": True, "jobs": state["jobs"]})
    return page.route("**/api/tools/jobs?*", handler)


async def put_away(page, through):
    await page.evaluate("([k, v]) => localStorage.setItem(k, v)", [DONE_KEY, through])


def card(page):
    return page.locator("#video-extractor")


def review(page):
    """The review panel alone: the history drawer below repeats titles and lines, so text is looked for here."""
    return card(page).get_by_test_id("tool-video_download-review")


async def main():
    failures = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        async def run(name, fn, width=1280):
            context = await browser.new_context(viewport={"width": width, "height": 900})
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            try:
                await fn(page)
                assert not errors, errors
                print(f"PASS {name}", flush=True)
            except Exception as e:  # noqa: BLE001 - every failure is reported, then the run fails
                failures.append(name)
                print(f"FAIL {name}: {e}", flush=True)
            finally:
                await context.close()

        async def review_then_done(page):
            await jobs_route(page, {"jobs": [OLD]})
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "review")
            r = review(page)
            await expect(r.get_by_text("Video extracted", exact=True)).to_be_visible()
            await expect(r.get_by_text("An older video", exact=True)).to_be_visible()
            await expect(r.get_by_role("link", name="Download", exact=True)).to_have_attribute("href", "/api/founders/marketing/assets/old-asset/download")
            await expect(r.get_by_role("link", name="Open in Extracted videos", exact=True)).to_have_attribute("href", "/founders/marketing/extracted?video=old-asset")
            # The form stays under the result: the next link never waits on Done.
            await expect(c.get_by_label("Link", exact=True)).to_be_visible()
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_disabled()
            await c.get_by_role("button", name="Done", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_test_id("tool-video_download-review")).to_have_count(0)
            await expect(c.get_by_label("Link", exact=True)).to_be_focused()
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_disabled()
            await expect(c.get_by_test_id("tool-video_download-needs-input")).to_contain_text("Add the link above")
            assert await page.evaluate("(k) => localStorage.getItem(k)", DONE_KEY) == OLD["created_at"]
            # The server still lists the run: a focus re-read brings it back, and it stays put away.
            await page.evaluate('window.dispatchEvent(new Event("focus"))')
            await page.wait_for_timeout(300)
            await expect(c).to_have_attribute("data-phase", "idle")
            # The history drawer lists it with its links and leads to the whole list.
            await c.locator("summary").click()
            await expect(c.get_by_role("link", name="Open in Extracted videos", exact=True)).to_be_visible()
            await expect(c.get_by_role("link", name="Download", exact=True)).to_be_visible()
            await expect(c.get_by_role("link", name="All extracted videos", exact=True)).to_have_attribute("href", "/founders/marketing/extracted")
            # The bar: no Extracted videos tab; Content Tools is current here.
            nav = page.get_by_role("navigation", name="Content", exact=True)
            await expect(nav.get_by_role("link", name="Extracted videos")).to_have_count(0)
            await expect(nav.get_by_role("link")).to_have_text(["Overview", "Library", "Content Tools", "Performance"])
            await expect(nav.get_by_role("link", name="Content Tools")).to_have_attribute("aria-current", "page")
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"
            SHOTS.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(SHOTS / f"tools-idle-{page.viewport_size['width']}.png"), full_page=True)

        async def reentry(page):
            await jobs_route(page, {"jobs": [OLD]})
            await page.goto(TOOLS)
            await expect(card(page)).to_have_attribute("data-phase", "review")
            await put_away(page, OLD["created_at"])
            await page.reload()
            c = card(page)
            await expect(c.get_by_label("Link", exact=True)).to_be_visible()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_test_id("tool-video_download-review")).to_have_count(0)
            await expect(c.get_by_test_id("tool-video_download-history")).to_be_visible()

        async def full_run(page):
            state = {"jobs": [OLD]}
            posts = []
            await jobs_route(page, state)

            async def post(route):
                body = route.request.post_data_json
                posts.append(body)
                state["jobs"] = [NEW, OLD]
                await answer(route, {"ok": True, "job": NEW})

            await page.route("**/api/tools/run", post)
            await page.goto(TOOLS)
            await put_away(page, OLD["created_at"])
            await page.reload()
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "idle")
            await c.get_by_label("Link", exact=True).fill(URL)
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_enabled()
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "running")
            await expect(c.get_by_test_id("tool-video_download-running")).to_contain_text("Waiting")
            await expect(c.get_by_test_id("tool-video_download-running")).to_contain_text(URL)
            # The link was taken, and the form is still there for the next one.
            await expect(c.get_by_label("Link", exact=True)).to_have_value("")
            assert posts and posts[0]["tool"] == "video_download" and posts[0]["input"]["url"] == URL and posts[0]["idempotency_key"], posts
            SHOTS.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(SHOTS / "tools-running.png"), full_page=True)
            # The runner takes it: each poll (3 s) shows the stage it is at.
            state["jobs"] = [dict(NEW, status="running", stage="downloading"), OLD]
            await expect(c.get_by_test_id("tool-video_download-running")).to_contain_text("Downloading", timeout=7000)
            state["jobs"] = [dict(NEW, status="running", stage="uploading"), OLD]
            await expect(c.get_by_test_id("tool-video_download-running")).to_contain_text("Uploading", timeout=7000)
            state["jobs"] = [NEW_DONE, OLD]
            await expect(c).to_have_attribute("data-phase", "review", timeout=7000)
            r = review(page)
            await expect(r.get_by_text("Video extracted", exact=True)).to_be_visible()
            await expect(r.get_by_text("The new video", exact=True)).to_be_visible()
            await expect(r.get_by_role("link", name="Download", exact=True)).to_have_attribute("href", "/api/founders/marketing/assets/new-asset/download")
            await expect(r.get_by_role("link", name="Open in Extracted videos", exact=True)).to_have_attribute("href", "/founders/marketing/extracted?video=new-asset")
            await page.screenshot(path=str(SHOTS / "tools-review.png"), full_page=True)
            assert await page.evaluate("window.__refreshes") >= 1, "the page was not told the run finished"
            await c.get_by_role("button", name="Done", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_label("Link", exact=True)).to_have_value("")
            await expect(c.get_by_label("Link", exact=True)).to_be_focused()
            assert await page.evaluate("(k) => localStorage.getItem(k)", DONE_KEY) == NEW["created_at"]
            await c.locator("summary").click()
            await expect(c.get_by_role("link", name="Open in Extracted videos", exact=True)).to_have_count(2)

        async def queue_second_link(page):
            # A second link while the first downloads: both show in the running panel, each at its stage.
            state = {"jobs": [dict(NEW, status="running", stage="downloading")]}
            second = dict(NEW, id="second", created_at="2026-10-25T11:01:00.000Z", updated_at="2026-10-25T11:01:00.000Z", input_summary=URL2)
            await jobs_route(page, state)

            async def post(route):
                state["jobs"] = [second, dict(NEW, status="running", stage="downloading")]
                await answer(route, {"ok": True, "job": second})

            await page.route("**/api/tools/run", post)
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "running")
            await c.get_by_label("Link", exact=True).fill(URL2)
            await c.get_by_role("button", name="Extract video", exact=True).click()
            panel = c.get_by_test_id("tool-video_download-running")
            await expect(panel.locator("li")).to_have_count(2)
            await expect(panel.locator("li").nth(0)).to_contain_text("Waiting")
            await expect(panel.locator("li").nth(0)).to_contain_text(URL2)
            await expect(panel.locator("li").nth(1)).to_contain_text("Downloading")
            await expect(panel.locator("li").nth(1)).to_contain_text(URL)
            await expect(c).to_have_attribute("data-phase", "running")

        async def finished_on_accept(page):
            # A worker tool answers the run request already finished (lib/tools/session-handlers.ts
            # runs it inside the request): the card goes straight to review and still tells the page.
            await jobs_route(page, {"jobs": []})
            await page.route("**/api/tools/run", lambda r: answer(r, {"ok": True, "job": NEW_DONE}))
            await page.goto(TOOLS)
            c = card(page)
            await c.get_by_label("Link", exact=True).fill(URL)
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "review")
            await expect(review(page).get_by_text("The new video", exact=True)).to_be_visible()
            assert await page.evaluate("window.__refreshes") == 1, "the page was not told the run finished"

        async def running_refresh(page):
            state = {"jobs": [NEW]}
            await jobs_route(page, state)
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "running")
            before = state["reads"]
            await c.get_by_role("button", name="Refresh", exact=True).click()
            await page.wait_for_timeout(300)
            assert state["reads"] == before + 1, (before, state["reads"])

        async def stale_read(page):
            release = asyncio.Event()
            started = asyncio.Event()
            calls = {"n": 0}

            async def delayed(route):
                calls["n"] += 1
                if calls["n"] == 1:
                    # The first read is slow: it answers an older, emptier list after the run was accepted.
                    started.set()
                    await release.wait()
                    await answer(route, {"ok": True, "jobs": []})
                else:
                    await answer(route, {"ok": True, "jobs": [NEW]})

            await page.route("**/api/tools/jobs?*", delayed)
            await page.route("**/api/tools/run", lambda r: answer(r, {"ok": True, "job": NEW}))
            await page.goto(TOOLS)
            await started.wait()
            c = card(page)
            await c.get_by_label("Link", exact=True).fill(URL)
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "running")
            release.set()
            await page.wait_for_timeout(300)
            await expect(c).to_have_attribute("data-phase", "running")
            await expect(c.get_by_test_id("tool-video_download-running")).to_contain_text("Waiting")

        async def read_failure(page):
            state = {"failed": True}

            async def jobs(route):
                if state["failed"]:
                    await answer(route, {"ok": False, "error": "jobs_failed"}, 503)
                else:
                    await answer(route, {"ok": True, "jobs": [OLD]})

            await page.route("**/api/tools/jobs?*", jobs)
            await page.goto(TOOLS)
            c = card(page)
            alert = c.get_by_role("alert")
            await expect(alert).to_contain_text("Couldn't read the recent runs.")
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_label("Link", exact=True)).to_be_visible()
            state["failed"] = False
            await alert.get_by_role("button", name="Try again", exact=True).click()
            await expect(c.get_by_role("alert")).to_have_count(0)
            await expect(c).to_have_attribute("data-phase", "review")

        async def retry_same_key(page):
            posts = []
            await jobs_route(page, {"jobs": []})

            async def post(route):
                posts.append(route.request.post_data_json)
                if len(posts) == 1:
                    await route.abort()
                else:
                    await answer(route, {"ok": True, "job": NEW})

            await page.route("**/api/tools/run", post)
            await page.goto(TOOLS)
            c = card(page)
            await c.get_by_label("Link", exact=True).fill(URL)
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c.get_by_role("alert")).to_contain_text("Couldn't confirm whether this run started")
            await expect(c).to_have_attribute("data-phase", "idle")
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "running")
            assert len(posts) == 2 and posts[0]["idempotency_key"] == posts[1]["idempotency_key"], posts

        async def failed_run(page):
            await jobs_route(page, {"jobs": [FAILED, OLD]})
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "review")
            r = review(page)
            await expect(r.get_by_text("Didn't finish", exact=True)).to_be_visible()
            await expect(r.get_by_text("That link couldn't be downloaded.")).to_be_visible()
            await expect(r.get_by_text("download_failed", exact=True)).to_be_visible()
            await expect(r.get_by_role("link", name="Download", exact=True)).to_have_count(0)
            await c.get_by_role("button", name="Try again", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_label("Link", exact=True)).to_have_value(URL)
            await expect(c.get_by_label("Link", exact=True)).to_be_focused()
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_enabled()
            # Dismiss: the same failure, cleared without the link.
            await page.evaluate("(k) => localStorage.removeItem(k)", DONE_KEY)
            await page.reload()
            await expect(c).to_have_attribute("data-phase", "review")
            await c.get_by_role("button", name="Dismiss", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_label("Link", exact=True)).to_have_value("")

        async def offline(page):
            await jobs_route(page, {"jobs": [OLD]})
            await page.goto(TOOLS + "?offline")
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "runner_offline")
            await expect(c.get_by_test_id("tool-video_download-offline")).to_contain_text("OASIS PC")
            await expect(c.get_by_label("Link", exact=True)).to_have_count(0)
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_have_count(0)
            await expect(c.get_by_test_id("tool-video_download-review")).to_have_count(0)
            await c.locator("summary").click()
            await expect(c.get_by_role("link", name="Download", exact=True)).to_be_visible()
            button = c.get_by_role("button", name="Check connection", exact=True)
            await button.click()
            assert await page.evaluate("window.__refreshes") == 1, "the page was not asked to refresh"
            await expect(c.get_by_role("button", name="Checking...", exact=True)).to_be_disabled()
            await expect(c.get_by_role("button", name="Check connection", exact=True)).to_be_enabled(timeout=6000)

        for width in (1280, 360):
            await run(f"review, Done, idle, drawer, nav and layout at {width}px", review_then_done, width)
        await run("a fresh visit after Done starts idle", reentry)
        await run("idle -> Extract video -> running stages -> review -> Done -> idle", full_run)
        await run("a second link queues while the first downloads; both show with their stage", queue_second_link)
        await run("a run accepted already finished goes to review and tells the page", finished_on_accept)
        await run("Refresh while running reads at once", running_refresh)
        await run("a late read cannot replace a newly accepted run", stale_read)
        await run("a failed read says so and Try again recovers", read_failure)
        await run("an unanswered run request retries under the same idempotency key", retry_same_key)
        await run("a failed run offers Try again (the link comes back) and Dismiss", failed_run)
        await run("offline: Check connection asks the page to refresh; no Run button", offline)
        await browser.close()
    if failures:
        raise SystemExit(f"{len(failures)} browser regression(s) failed: {', '.join(failures)}")


asyncio.run(main())
