# Shenron: a Dragon Ball Super Fusion World deck lab

A browser app with a rules engine, AI and deckbuilder for the Fusion World card game.

- **Engine**: full game rules plus about 1,200 hand-checked card scripts (`data/scripts`). The English reading of each card can be checked against its printed text in the app.
- **AI**: a turn planner that searches whole lines of play across guessed hidden hands, a self-play-tuned evaluation, and an experimental learned value network (`src/ai/valuenet.ts`, `data/valuenet.json`).
- **Counter Lab**: evolves decks to beat one list or the whole field, by default from scratch (known lists are only the bar to beat), with a matchup table and an "Ask why" explainer.
- **Play vs AI**: play full games against the AI, with undo, AI speed and step mode, a recap of each AI turn, flags and notes saved for review, and "Ask Claude about your position".
- **Meta / Matchup / Scouter / Audit**: player decklists, game plans from tournament transcripts (`data/visions.json`, `data/transcripts`), head-to-heads, opponent hand reading, and card review.

## Develop

```
npm install
npm test                 # engine and AI tests
npm run build            # writes dist/shenron.html (single file, opens in a browser)
npx tsx cli/scripts.ts show FB09-121     # a card's text next to the engine's reading
npx tsx cli/scripts.ts apply             # validate data/scripts and merge into data/cards.json
npx tsx cli/counter.ts --target "Jiren (Red)" --blind   # counter search from the command line
```

Saved Play vs AI games replay exactly with `replayRecord` (`src/play/host.ts`).
