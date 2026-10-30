# Shenron — handoff notes (October 30, 2026)

Where things stand, so the next session can pick up immediately.

## Live app
- https://claude.ai/artifact/QoumcU7QNngTSP6GEfKQGK — publish from `dist/shenron.html` (`npm run build`).
- Capabilities: `db` (rules: carddb/settings/scripts admin-write; playgames/reports/selfplay interact-write), `sample`, `user`, `downloads`.
- Database collections Claude reads: `playgames` (the user's games vs the AI, with notes), `reports`, `selfplay`
  (training positions from the "Help train the AI" panel on the Matchup tab; rows are a JSON string, 10 games per doc,
  ~55 KB each — download with ArtifactData `list` + `out_dir`, then delete to keep the database small).
- The user can also save training games to a file (same panel, "A file on this PC"): `{v, inputs, games, rows}`.

## Data and tools (all in the repo)
- `data/official.json` — the official card database (stats, text, 495 Q&A rulings). `cli/official.ts` applies stats.
- `data/tournaments.json` + `cli/import-tournaments.ts` — real FB10 results from deckbuilder.egmanevents.com/api/tournaments/fusionworld;
  sets meta shares from field share and adds top-cut lists. Rerunnable.
- `data/selfplay/*.json.gz` — learned-evaluation training data: ~4,900 searching-AI self-play games (2,446 from the user's PC),
  rows = `[...NET_INPUTS_V2 (71), handLogit, won, gameSeed, turnsLeft]`. `human.json.gz` = the user's games (exam set).
  `net-r3.json` = latest residual net (A/B 50.0% vs the hand-set evaluation: not shipped). `ab-history.txt` = every A/B so far.
- `cli/learn/` — `gen2.ts` (self-play generator), `train2.ts` (residual trainer; env TURNSTART=1 DROP=activeEnergy,deck,castable,myTurn,drop;
  FRAC for learning curves; KEEP/LINEAR variants), `exam.ts`, `sens.ts` (what the net rewards), `human.ts`.
  Gunzip the data into a folder first: `mkdir -p /tmp/sp && for f in data/selfplay/gen2-*.gz; do gunzip -c $f > /tmp/sp/$(basename $f .gz); done`
  then `TURNSTART=1 DROP=activeEnergy,deck,castable,myTurn,drop npx tsx cli/learn/train2.ts /tmp/sp net.json`.
- `cli/ab.sh NAME 'VARIANTJSON'` — strong-AI A/B (360 games), e.g. `cli/ab.sh netR4 "$(node -e '...{eval:{net,netResidual:true}}')"`.
- `cli/calibrate.ts` — round-robin of the 8 FB10 tournament Leaders; last result Spearman 0.93 vs real conversion.

## Learned evaluation status
- Prediction keeps improving with data (learning curve still climbing: ~+0.01 held-out loss per doubling).
- Play: 1.6k games 43%, linear 48%, 4.6k games 50% vs the hand-set evaluation. Next: retrain at ~10k+ games and A/B.
- Lessons: the net must not see controllable inputs (unspent energy, deck/drop size); half-finished turns in the planner
  are ranked with the hand-set evaluation (`beamEval`); only turn-start positions are trained on.

## Pending at handoff
- SHIPPED: `prune.guardLife: 5` won its A/B 211/360 (58.6%). A cutoff-4 run may also be in `ab-history.txt`.
  on-damage triggers left to the search; damage counted so a Double Strike at 6 is plain at cutoff 5). Results land in
  `ab-results.txt` / the history; ship the better cutoff by adding it to SEARCH_LEVELS' `prune` if it wins.
- Counter Lab: seeding now adds Evolve packages and Leader-keyed archetype cards (seed overlap with real lists 94 → 132 of 500).
  Verify with `npx tsx cli/counter.ts --target "Jiren (Red)" --blind --effort quick --seed 202` (old: best 61%, known SS3 93%).
- Fresh Counter Lab sweep of all targets on the current data (the old retest mixed card-data versions).

## The user
- Plays Boujack (Yellow) well; beat the Deep AI three times. Their notes drove most fixes: Broly tax, optional costs,
  pointless attacks, burning combo cards to guard at high life, status tags naming their source.
- Prefers a D&D-style DM persona with a short italic flavour line; don't republish while they're mid-game.
