#!/usr/bin/env python3
"""
Regenerate tests/fixtures/encrypted-statement.pdf — a 2-page, permission-encrypted
PDF that stands in for a real bank export.

Why a committed fixture: permission-encrypted PDFs are a large share of real bank
statements, and pdf-lib cannot decrypt them, so they are the ONLY input that
exercises the pdfjs raster fallback in lib/forms/watermark.ts. That path had zero
test coverage while being the path every "it can't watermark it" report runs
through. Generating it at test time would need qpdf or Python on every machine and
CI runner, so the artifact is committed instead and the test always runs.

Empty user password + a set owner password = "opens with no prompt, but is
encrypted", which is exactly the shape banks emit.

Run (regenerate only; the output is committed):
    python scripts/make-encrypted-pdf-fixture.py
"""

import pathlib

from pypdf import PdfWriter

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures"
OUT = FIXTURES / "encrypted-statement.pdf"

# Over the RASTER page cap (MAX_PAGES_RASTER = 120 in lib/forms/watermark.ts).
#
# Why a SECOND fixture: the raster cap is only reachable by a source the overlay
# cannot read, and encryption is the realistic one. An unencrypted over-cap PDF
# is refused by the overlay's own (much higher) cap and never reaches raster, so
# without this the raster cap would ship with zero coverage — a guard asserting a
# timing guarantee that nothing proves. Pages are blank, so 121 pages costs only
# a few KB.
OUT_OVER_CAP = FIXTURES / "encrypted-statement-over-cap.pdf"
OVER_CAP_PAGES = 121


def _write(out: pathlib.Path, pages: int) -> None:
    writer = PdfWriter()
    for _ in range(pages):
        # US Letter at 72 dpi, matching the synthetic statements in
        # scripts/test-watermark.ts.
        writer.add_blank_page(width=612, height=792)

    # RC4-128 with an empty user password: no prompt on open, still encrypted, so
    # pdf-lib refuses it and pdfjs must decrypt.
    writer.encrypt(user_password="", owner_password="ownerpw", use_128bit=True)

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as fh:
        writer.write(fh)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


def main() -> None:
    _write(OUT, 2)
    _write(OUT_OVER_CAP, OVER_CAP_PAGES)


if __name__ == "__main__":
    main()
