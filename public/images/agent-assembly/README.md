# Agent Assembly Phase Images

`components/landing/AgentAssemblyScrollScene.tsx` crossfades through 8 photoreal
keyframes as the operator scrolls the `/welcome` page. Save the rendered
phase images here with these exact filenames:

| Phase | File | Subject |
|---|---|---|
| 01 | `phase-01-initial-seed.png` | Holographic silhouette. Reasoning core warming. State pulse syncing. Robotic arms inward from L/R. |
| 02 | `phase-02-neural-backbone.png` | Memory spine forming vertically through torso and neck. Body silhouette stabilizing. |
| 03 | `phase-03-optic-calibration.png` | Browser optics installing. Eyes / temple precision needles. Face becoming defined. |
| 04 | `phase-04-tool-limb-docking.png` | Tool limbs and embodiment hardware attaching. Shoulders, arms, hands mechanical. |
| 05 | `phase-05-guard-shield.png` | Guardrails and policy alignment active. Translucent shield panels around the body. |
| 06 | `phase-06-output-halo.png` | Output halo above head. Response synthesis online. Halo pulses and rotates subtly. |
| 07 | `phase-07-security-mesh.png` | Zero-trust mesh wrapping the figure. Lattice lines and lock nodes. |
| 08 | `phase-08-bravo-online.png` | Final completed executive agent. All systems online. Calm and authoritative. |

Recommended specs:
- 1920 × 1080 PNG (or 2400 × 1350 for retina)
- < 600 KB each after compression (use `pngquant` or `sharp` for optimization)
- Same framing across all 8 — figure centered, same crop, so the crossfade
  is visually stable (no figure-jump between phases)
- Match the existing OASIS palette: dark charcoal background, teal/cyan
  primary glow, gold/amber accents for the final state

After saving the 8 files here, the next Vercel build will activate the
cinematic scroll on production `/welcome`. No code changes needed once
the images are in place.
