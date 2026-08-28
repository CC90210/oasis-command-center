# Shared harness tools

## `agent_genome.py` — measure the version gap instead of discussing it

Both agents are expressions of one 11-gene contract. This verifies a repo
expresses it, and it accepts `--repo` so **either side can run it against the
other's checkout, read-only**.

```bash
python agent_genome.py --repo <path-to-your-repo>
python agent_genome.py --repo <path> --json      # machine-readable
```

Your paths differ from Bravo's, and that is expected. Drop a `genome.json` at
your repo root naming yours — the gene checks the **capability**, never Bravo's
filenames:

```json
{
  "name": "apex",
  "entry_points": ["<your entry point(s)>"],
  "coord_client":  ["services/coordination/coord-claim.js"],
  "coord_guard":   ["services/coordination/coord-guard.js"],
  "ownership_map": ["docs/coordination/OWNERSHIP_MAP.yaml"],
  "guard_wiring":  ["<the settings file your runtime actually loads>"]
}
```

**G11 is the one to look at first.** It checks that the pre-edit guard is
**REGISTERED IN A HOOK CHAIN**, not merely present on disk. A guard nothing
invokes reads as coverage while protecting nothing — the exact failure this
programme spent two days removing, and the exact current state of a guard that
is written, tested, and not installed.

Verified to fail correctly: a repo with the lease client, the guard, and the
ownership map all present, but the guard absent from every hook chain, reports
`G11 missing: guard not registered in any settings hook chain`.
