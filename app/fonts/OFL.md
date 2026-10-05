# Vendored fonts — SIL Open Font License 1.1

These `.woff2` files are the **latin subset** binaries Google Fonts was already
serving to this app. They are vendored so `next build` does not depend on a live
fetch to `fonts.gstatic.com` — that fetch failed two deploys in two days (Vercel
`104cd22`, GitHub Actions on `fix/invite-create-failed`) and took the whole build
down with it each time.

| Family | Weights | Upstream | License |
|---|---|---|---|
| Space Grotesk | 500, 600, 700 | https://fonts.google.com/specimen/Space+Grotesk | OFL-1.1 |
| Inter Tight | 400, 500, 600 | https://fonts.google.com/specimen/Inter+Tight | OFL-1.1 |
| JetBrains Mono | 400, 500 | https://fonts.google.com/specimen/JetBrains+Mono | OFL-1.1 |
| Chakra Petch | 500, 600, 700 | https://fonts.google.com/specimen/Chakra+Petch | OFL-1.1 |
| Orbitron | 700 | https://fonts.google.com/specimen/Orbitron | OFL-1.1 |

Chakra Petch and Orbitron (added 2026-09-01 for the web-leads battle card's HUD
faces) were vendored from `@fontsource/chakra-petch@5.3.0` and
`@fontsource/orbitron@5.3.0` (latin subset, npm) rather than a live Google
fetch, for the same reason the first three exist: the build must never depend
on fonts.gstatic.com being up. Loaded by `components/web-leads/BattleCard.tsx`
via `next/font/local`, scoped to the battle card only.

All five are licensed under the SIL Open Font License 1.1, which permits
redistribution of the font files, bundled or standalone, provided they are not
sold on their own and the license travels with them:
https://openfontlicense.org/

Loaded by `app/(marketing)/layout.tsx` via `next/font/local`. Nothing else in the
app uses a webfont — the operator dashboard renders on a system stack on purpose.

**To change a weight:** add the `.woff2` here and register it in that layout's
`src` array. Do not reintroduce `next/font/google`; `tests/font-selfhost.test.ts`
fails the build if you do, and explains why.
