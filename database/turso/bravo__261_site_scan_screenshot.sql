-- Free AI scan: the picture of the business's home page the runner takes while it matches, as a
-- visitor first sees it (1280x800, JPEG, at most 250 KB: lib/site-scan/screenshot.ts). Shown in the
-- live view's browser frame and served by GET /api/scan/:id/screenshot. Deleted with its scan (an unclaimed scan after 30 days: lib/site-scan/store.ts).
ALTER TABLE site_scans ADD COLUMN screenshot_jpeg BLOB;
ALTER TABLE site_scans ADD COLUMN screenshot_at TEXT;
