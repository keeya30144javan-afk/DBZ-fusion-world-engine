# Shenron: Fusion World deck lab

Simulates full games of the Dragon Ball Super Card Game Fusion World to find counter decks, and only recommends one when the evidence clears your bar.

## What's inside

| Part | Where | What it does |
|---|---|---|
| Card data | `src/data/` | Normalises card rows from DeckPlanet, the official site, or our own format. Parses decklists and checks deck legality. |
| Effect compiler | `src/effects/parse.ts` | Turns skill text into actions the engine can run, and reports how much of each card it understood. |
| Rules engine | `src/engine/` | Plays whole games: setup, mulligan, charge, play, skills, attacks, counters, blockers, combos, damage, awaken, win and loss. |
| AI | `src/ai/` | A fast rule-based player, a searching player that re-deals the cards it can't see and looks ahead, and the Scouter opponent model. |
| Counter builder | `src/builder/` | Evolves decks against a target, then re-tests finalists on fresh games and applies the statistical stop. |
| App | `src/ui/`, `build.mjs` | A one-file web app; simulations run in Web Workers. |

## Commands

```
npm test                          # rules + Scouter tests
npm run typecheck
npm run build                     # dist/shenron.html
npx tsx cli/counter.ts --target "Starter: Vegeta (Blue)" --effort quick --level quick
npx tsx cli/update-cards.ts       # pull every card from DeckPlanet (needs network access)
npx tsx cli/build-db.ts data/cards.json raw1.json raw2.json --source "name"
```

## When a new set comes out

1. Get the card list: run `cli/update-cards.ts`, or save the DeckPlanet API pages and use **Import cards** in the app's Cards tab.
2. Open the Cards tab and check the "understood" percentage. Cards with approximated text are listed with the exact sentences the engine skipped. Add templates for them in `src/effects/parse.ts`.
3. Add the new meta decklists on the Meta tab.

## Known assumptions

Four rules are switches in the app (Cards & Rules tab) because they could not be confirmed against the official manual from this environment:
- whether Battle Cards can attack the turn they are played
- whether there is a combo limit per battle
- whether a player loses as soon as life reaches 0
- how multicolour cards fit a leader's colours

The colored part of a card's energy cost is also assumed (one orb of the card's colour, two from cost 5 up) when the data source doesn't list it.
