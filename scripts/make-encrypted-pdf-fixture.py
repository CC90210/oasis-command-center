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

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "encrypted-statement.pdf"


def main() -> None:
    writer = PdfWriter()
    for _ in range(2):
        # US Letter at 72 dpi, matching the synthetic statements in
        # scripts/test-watermark.ts.
        writer.add_blank_page(width=612, height=792)

    # RC4-128 with an empty user password: no prompt on open, still encrypted, so
    # pdf-lib refuses it and pdfjs must decrypt.
    writer.encrypt(user_password="", owner_password="ownerpw", use_128bit=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("wb") as fh:
        writer.write(fh)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
