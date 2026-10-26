"""tests/tools-grid.browser.py - the Video extractor card driven in a real browser.

The real components (ToolGrid, ContentTabs, RefreshOnToolRun) are bundled by
scripts/test-content-tools-browser.mjs and mounted with synthetic API answers:
no session, no database, no runner, no network beyond localhost. Each case runs
in a fresh browser context (its own localStorage).

Pins the lifecycle CC asked for on 2026-10-25:
  - a finished run is in review (Video extracted, Download, Open in Extracted
    videos, Done) with the form still under it; Done puts that run away, leaves
    what was typed since, focuses the Link field, and a re-read from the server
    does not bring the run back;
  - a fresh visit after Done starts idle even though the server still lists
    the run; the history drawer lists it with its links, and leads to the list;
  - idle -> Extract video -> Waiting -> Downloading -> Uploading -> review ->
    Done -> idle, and the page is told the run finished; a run that comes back
    already finished (a worker tool) tells it too;
  - a second link queues while the first downloads, and both show their stage;
  - two finished runs each wait for their own Done; a finished run shows even
    while an older one is still in flight;
  - Refresh while running reads at once; a background poll never flips it;
  - a read that started before a run was accepted never replaces it;
  - a failed read says so, offers Reload runs, and recovers;
  - a run request with no answer says so, reads the runs at once, and is retried
    under the same idempotency key; an accepted run or a refusal starts a new key;
  - a failed run offers Try again (the link comes back) and Dismiss;
  - the offline card offers Check connection, which asks the page to refresh,
    says "Still offline" when nothing changes, and has no Run button;
  - no Extracted videos tab; Content Tools is current on this page;
  - every visible control is 44 px tall, Download is above a phone's fold, and
    nothing overflows sideways at 360 px.

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
DONE_KEY = "oasis:tools:fixture-tenant:video_download:done-ids"
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
PHONE_FOLD = 800


async def answer(route, payload, status=200):
    await route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))


def jobs_route(page, state):
    """Answer the runs read from state['jobs'], counting reads in state['reads']."""
    async def handler(route):
        state["reads"] = state.get("reads", 0) + 1
        await answer(route, {"ok": True, "jobs": state["jobs"]})
    return page.route("**/api/tools/jobs?*", handler)


async def put_away(page, *ids):
    await page.evaluate("([k, v]) => localStorage.setItem(k, v)", [DONE_KEY, json.dumps(list(ids))])


async def stored(page):
    raw = await page.evaluate("(k) => localStorage.getItem(k)", DONE_KEY)
    return json.loads(raw) if raw else []


async def wait_for_reads(state, n, timeout_ms=5000):
    """Until the card has read its runs n times (the mount read lands a moment after the page does)."""
    for _ in range(timeout_ms // 50):
        if state.get("reads", 0) >= n:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"expected {n} reads, saw {state.get('reads', 0)}")


def card(page):
    return page.locator("#video-extractor")


def reviews(page):
    """Every review block, newest first. The history drawer below repeats titles and lines, so text is looked for here."""
    return card(page).get_by_test_id("tool-video_download-review")


async def tap_targets(c):
    """Every visible button and link in the card is at least 44 px tall."""
    boxes = await c.locator("button:visible, a:visible").evaluate_all(
        "els => els.map(e => [e.textContent.trim(), e.getBoundingClientRect().height])"
    )
    assert boxes, "no controls found"
    small = [b for b in boxes if b[1] < 44]
    assert not small, f"controls under 44px: {small}"


async def no_sideways_overflow(page):
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "horizontal overflow"


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
            r = reviews(page)
            await expect(r).to_have_count(1)
            await expect(r.get_by_text("Video extracted", exact=True)).to_be_visible()
            await expect(r.get_by_text("An older video", exact=True)).to_be_visible()
            download = r.get_by_role("link", name="Download", exact=True)
            await expect(download).to_have_attribute("href", "/api/founders/marketing/assets/old-asset/download")
            await expect(r.get_by_role("link", name="Open in Extracted videos", exact=True)).to_have_attribute("href", "/founders/marketing/extracted?video=old-asset")
            box = await download.bounding_box()
            assert box and box["y"] + box["height"] <= PHONE_FOLD, f"Download below a phone's fold: {box}"
            await tap_targets(c)
            await no_sideways_overflow(page)
            # The form stays under the result: the next link never waits on Done, and Done never erases it.
            link = c.get_by_label("Link", exact=True)
            await expect(link).to_be_visible()
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_disabled()
            await link.fill(URL2)
            await c.get_by_role("button", name="Done", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(r).to_have_count(0)
            await expect(link).to_have_value(URL2)
            await expect(link).to_be_focused()
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_enabled()
            assert await stored(page) == ["old"], await stored(page)
            # The server still lists the run: a focus re-read brings it back, and it stays put away.
            await page.evaluate('window.dispatchEvent(new Event("focus"))')
            await page.wait_for_timeout(300)
            await expect(c).to_have_attribute("data-phase", "idle")
            # The history drawer lists it with its links and leads to the whole list.
            await c.locator("summary").click()
            await expect(c.get_by_role("link", name="Open in Extracted videos", exact=True)).to_be_visible()
            await expect(c.get_by_role("link", name="Download", exact=True)).to_be_visible()
            await expect(c.get_by_role("link", name="All extracted videos", exact=True)).to_have_attribute("href", "/founders/marketing/extracted")
            await expect(c.get_by_test_id("tool-video_download-history").get_by_text("Done", exact=True)).to_have_count(0)
            await tap_targets(c)
            # The bar: no Extracted videos tab; Content Tools is current here.
            nav = page.get_by_role("navigation", name="Content", exact=True)
            await expect(nav.get_by_role("link", name="Extracted videos")).to_have_count(0)
            await expect(nav.get_by_role("link")).to_have_text(["Overview", "Library", "Content Tools", "Performance"])
            await expect(nav.get_by_role("link", name="Content Tools")).to_have_attribute("aria-current", "page")
            await no_sideways_overflow(page)
            SHOTS.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(SHOTS / f"tools-idle-{page.viewport_size['width']}.png"), full_page=True)

        async def reentry(page):
            await jobs_route(page, {"jobs": [OLD]})
            await page.goto(TOOLS)
            await expect(card(page)).to_have_attribute("data-phase", "review")
            await put_away(page, "old")
            await page.reload()
            c = card(page)
            await expect(c.get_by_label("Link", exact=True)).to_be_visible()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(reviews(page)).to_have_count(0)
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
            await put_away(page, "old")
            await page.reload()
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "idle")
            await c.get_by_label("Link", exact=True).fill(URL)
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_enabled()
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "running")
            running = c.get_by_test_id("tool-video_download-running")
            await expect(running).to_contain_text("Waiting")
            await expect(running).to_contain_text(URL)
            # The link was taken, and the form is still there for the next one.
            await expect(c.get_by_label("Link", exact=True)).to_have_value("")
            assert posts and posts[0]["tool"] == "video_download" and posts[0]["input"]["url"] == URL and posts[0]["idempotency_key"], posts
            await tap_targets(c)
            await no_sideways_overflow(page)
            SHOTS.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(SHOTS / "tools-running.png"), full_page=True)
            # The runner takes it: each poll (3 s) shows the stage it is at.
            state["jobs"] = [dict(NEW, status="running", stage="downloading"), OLD]
            await expect(running).to_contain_text("Downloading", timeout=7000)
            state["jobs"] = [dict(NEW, status="running", stage="uploading"), OLD]
            await expect(running).to_contain_text("Uploading", timeout=7000)
            state["jobs"] = [NEW_DONE, OLD]
            await expect(c).to_have_attribute("data-phase", "review", timeout=7000)
            r = reviews(page)
            await expect(r).to_have_count(1)
            await expect(r.get_by_text("Video extracted", exact=True)).to_be_visible()
            await expect(r.get_by_text("The new video", exact=True)).to_be_visible()
            await expect(r.get_by_role("link", name="Download", exact=True)).to_have_attribute("href", "/api/founders/marketing/assets/new-asset/download")
            await expect(r.get_by_role("link", name="Open in Extracted videos", exact=True)).to_have_attribute("href", "/founders/marketing/extracted?video=new-asset")
            await expect(running).to_have_count(0)
            await tap_targets(c)
            await no_sideways_overflow(page)
            await page.screenshot(path=str(SHOTS / "tools-review.png"), full_page=True)
            assert await page.evaluate("window.__refreshes") >= 1, "the page was not told the run finished"
            await c.get_by_role("button", name="Done", exact=True).click()
            await expect(c).to_have_attribute("data-phase", "idle")
            await expect(c.get_by_label("Link", exact=True)).to_have_value("")
            await expect(c.get_by_label("Link", exact=True)).to_be_focused()
            assert await stored(page) == ["old", "new"], await stored(page)
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

        async def two_finished_each_with_done(page):
            # Two links were queued; the newer succeeded, the older failed. Each waits for its own Done:
            # putting the success away must never hide the failure unseen (review of #736).
            await jobs_route(page, {"jobs": [NEW_DONE, FAILED]})
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "review")
            r = reviews(page)
            await expect(r).to_have_count(2)
            await expect(r.nth(0).get_by_text("Video extracted", exact=True)).to_be_visible()
            await expect(r.nth(1).get_by_text("Didn't finish", exact=True)).to_be_visible()
            await tap_targets(c)
            await r.nth(0).get_by_role("button", name="Done", exact=True).click()
            await expect(r).to_have_count(1)
            await expect(r.get_by_text("Didn't finish", exact=True)).to_be_visible()
            await expect(c).to_have_attribute("data-phase", "review")
            await r.get_by_role("button", name="Dismiss", exact=True).click()
            await expect(r).to_have_count(0)
            await expect(c).to_have_attribute("data-phase", "idle")
            assert sorted(await stored(page)) == ["bad", "new"], await stored(page)

        async def finished_while_another_runs(page):
            # The PC claims the oldest job first, so a newer link can finish while an older one is still held:
            # the finished one shows, the running one too.
            held = dict(OLD, id="held", status="claimed", created_at="2026-10-25T09:00:00.000Z", result=None, asset_id=None, finished_at=None, input_summary=URL2)
            await jobs_route(page, {"jobs": [NEW_DONE, held]})
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "review")
            await expect(reviews(page).get_by_text("The new video", exact=True)).to_be_visible()
            running = c.get_by_test_id("tool-video_download-running")
            await expect(running).to_contain_text("Downloading")
            await expect(running).to_contain_text(URL2)
            await expect(c.get_by_role("button", name="Refresh", exact=True)).to_be_visible()

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
            await expect(reviews(page).get_by_text("The new video", exact=True)).to_be_visible()
            assert await page.evaluate("window.__refreshes") == 1, "the page was not told the run finished"

        async def running_refresh(page):
            state = {"jobs": [NEW]}
            await jobs_route(page, state)
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "running")
            button = c.get_by_role("button", name="Refresh", exact=True)
            await wait_for_reads(state, 1)
            before = state["reads"]
            await button.click()
            await page.wait_for_timeout(300)
            assert state["reads"] == before + 1, (before, state["reads"])
            # A background poll (every 3 s) never flips the button to "Refreshing...".
            before = state["reads"]
            seen = set()
            for _ in range(40):
                seen.add((await button.text_content() or "").strip())
                await page.wait_for_timeout(100)
            assert state["reads"] > before, "no poll happened in 4 s"
            assert seen == {"Refresh"}, seen

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
            await tap_targets(c)
            state["failed"] = False
            await alert.get_by_role("button", name="Reload runs", exact=True).click()
            await expect(c.get_by_role("alert")).to_have_count(0)
            await expect(c).to_have_attribute("data-phase", "review")

        async def unconfirmed_then_rereads(page):
            # The run request gets no answer: the card says so, reads the runs at once, and the run it finds shows.
            state = {"jobs": []}
            await jobs_route(page, state)

            async def post(route):
                state["jobs"] = [NEW]
                await route.abort()

            await page.route("**/api/tools/run", post)
            await page.goto(TOOLS)
            c = card(page)
            await wait_for_reads(state, 1)
            reads = state["reads"]
            await c.get_by_label("Link", exact=True).fill(URL)
            await c.get_by_role("button", name="Extract video", exact=True).click()
            await expect(c.get_by_role("alert")).to_contain_text("Couldn't confirm whether this run started")
            await expect(c).to_have_attribute("data-phase", "running")
            assert state["reads"] == reads + 1, (reads, state["reads"])

        async def retry_keys(page):
            # No answer: the same key again. An accepted run, or a refusal: a new key for the next press.
            posts = []
            state = {"jobs": []}
            await jobs_route(page, state)

            async def post(route):
                body = route.request.post_data_json
                posts.append(body)
                n = len(posts)
                if n == 1:
                    await route.abort()
                elif n == 2:
                    state["jobs"] = [NEW_DONE]
                    await answer(route, {"ok": True, "job": NEW_DONE})
                elif n == 3:
                    await answer(route, {"ok": False, "error": "too_many_in_flight", "message": "Five downloads are already in progress."}, 429)
                else:
                    await answer(route, {"ok": True, "job": dict(NEW, id="fourth")})

            await page.route("**/api/tools/run", post)
            await page.goto(TOOLS)
            c = card(page)
            link = c.get_by_label("Link", exact=True)
            extract = c.get_by_role("button", name="Extract video", exact=True)
            await link.fill(URL)
            await extract.click()
            await expect(c.get_by_role("alert")).to_contain_text("Couldn't confirm")
            await extract.click()
            await expect(c).to_have_attribute("data-phase", "review")
            await c.get_by_role("button", name="Done", exact=True).click()
            await link.fill(URL)
            await extract.click()
            await expect(c.get_by_role("alert")).to_contain_text("Five downloads are already in progress.")
            await extract.click()
            await expect(c).to_have_attribute("data-phase", "running")
            keys = [p["idempotency_key"] for p in posts]
            assert len(keys) == 4, posts
            assert keys[0] == keys[1], "no answer: the same run is retried"
            assert keys[2] != keys[1], "after an accepted run the same link is a new run"
            assert keys[3] != keys[2], "after a refusal the next press is a new request"

        async def failed_run(page):
            await jobs_route(page, {"jobs": [FAILED, OLD]})
            await page.goto(TOOLS)
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "review")
            r = reviews(page)
            await expect(r).to_have_count(2)
            failed = r.nth(0)
            await expect(failed.get_by_text("Didn't finish", exact=True)).to_be_visible()
            await expect(failed.get_by_text("That link couldn't be downloaded.")).to_be_visible()
            await expect(failed.get_by_text("download_failed", exact=True)).to_be_visible()
            await expect(failed.get_by_role("link", name="Download", exact=True)).to_have_count(0)
            await failed.get_by_role("button", name="Try again", exact=True).click()
            await expect(r).to_have_count(1)
            await expect(c.get_by_label("Link", exact=True)).to_have_value(URL)
            await expect(c.get_by_label("Link", exact=True)).to_be_focused()
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_be_enabled()
            # Dismiss: the same failure, cleared without the link.
            await page.evaluate("(k) => localStorage.removeItem(k)", DONE_KEY)
            await page.reload()
            await expect(reviews(page)).to_have_count(2)
            await reviews(page).nth(0).get_by_role("button", name="Dismiss", exact=True).click()
            await expect(reviews(page)).to_have_count(1)
            await expect(c.get_by_label("Link", exact=True)).to_have_value("")

        async def offline(page):
            await jobs_route(page, {"jobs": [OLD]})
            await page.goto(TOOLS + "?offline")
            c = card(page)
            await expect(c).to_have_attribute("data-phase", "runner_offline")
            await expect(c.get_by_test_id("tool-video_download-offline")).to_contain_text("OASIS PC")
            await expect(c.get_by_label("Link", exact=True)).to_have_count(0)
            await expect(c.get_by_role("button", name="Extract video", exact=True)).to_have_count(0)
            await expect(reviews(page)).to_have_count(0)
            await c.locator("summary").click()
            await expect(c.get_by_role("link", name="Download", exact=True)).to_be_visible()
            await tap_targets(c)
            await c.get_by_role("button", name="Check connection", exact=True).click()
            assert await page.evaluate("window.__refreshes") == 1, "the page was not asked to refresh"
            await expect(c.get_by_role("button", name="Checking...", exact=True)).to_be_disabled()
            # Nothing changed on the server side: the card says so instead of going quiet.
            await expect(c.get_by_text("Still offline", exact=False)).to_be_visible(timeout=6000)
            await expect(c.get_by_role("button", name="Check connection", exact=True)).to_be_enabled()

        for width in (1280, 360):
            await run(f"review, Done, idle, drawer, nav, tap targets and layout at {width}px", review_then_done, width)
        await run("a fresh visit after Done starts idle", reentry)
        await run("idle -> Extract video -> running stages -> review -> Done -> idle", full_run)
        await run("a second link queues while the first downloads; both show with their stage", queue_second_link)
        await run("two finished runs each wait for their own Done; the failure is never hidden unseen", two_finished_each_with_done)
        await run("a finished run shows while an older one is still in flight", finished_while_another_runs)
        await run("a run accepted already finished goes to review and tells the page", finished_on_accept)
        await run("Refresh while running reads at once; a poll never flips it", running_refresh)
        await run("a late read cannot replace a newly accepted run", stale_read)
        await run("a failed read says so and Reload runs recovers", read_failure)
        await run("an unanswered run request says so and reads the runs at once", unconfirmed_then_rereads)
        await run("idempotency keys: kept with no answer, new after an accepted run or a refusal", retry_keys)
        await run("a failed run offers Try again (the link comes back) and Dismiss", failed_run)
        await run("offline: Check connection asks the page to refresh and says Still offline; no Run button", offline)
        await browser.close()
    if failures:
        raise SystemExit(f"{len(failures)} browser regression(s) failed: {', '.join(failures)}")


asyncio.run(main())
