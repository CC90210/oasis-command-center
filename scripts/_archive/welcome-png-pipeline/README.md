# Archived: welcome-page PNG slicing pipeline

`segment_agent_reference.py` is the build-time tool that originally
generated the 10 PNG slices + `agent-solid.png` in
`public/welcome/parts/` from a single 1024x1536 ChatGPT reference
render.

Archived 2026-06-07 when the `/welcome` route's `AgentFigureSprite`
was replaced with a procedural WebGL humanoid (see
`components/landing/agent-assembly/webgl/`). The PNGs and this
generation script are no longer wired into any runtime path.

Kept (rather than deleted) for two reasons:

1. **Reproducibility of the prior figure.** If we ever need to roll
   back to the photoreal PNG version, the slicing rules are here.
2. **Pipeline reference.** The morphological-closing + BFS
   connected-component step in `agent-solid.png` generation is
   reusable for other "isolate primary subject from speckle noise"
   tasks. Not currently invoked, but useful as a worked example.

If this folder is still untouched 6 months from now, delete it.
