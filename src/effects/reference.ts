/**
 * The skill-language reference given to a translator (Claude in the app, or
 * by hand). Kept next to the types so the two change together.
 */
export const LANGUAGE_REFERENCE = `
You translate Dragon Ball Super Card Game Fusion World card text into a JSON skill language that a game simulator executes.
Translate ONLY what the text says. Never invent effects. If a sentence cannot be expressed, put it verbatim in that ability's "unparsed" list (or the script's "needs" list naming the missing mechanic) — a missing piece is fine, a wrong piece is not.

SCRIPT = { "keywords": Keyword[], "abilities": Ability[], "backKeywords"?: Keyword[], "backAbilities"?: Ability[] (a Leader's awakened side), "evolve"?: Evolve, "unparsed"?: string[], "needs"?: string[] }

Keyword: "blocker" | "critical" | "doubleStrike" | "tripleStrike" | "superCombo" | "barrier" | "field" (an Extra with [Field]) | "dragonBall"
 | "cantAttack" | "cantAttackLeader" | "cantBlock" | "koImmuneSkills" (can't be KO'd by opponent's skills) | "koImmune" | "koImmuneOnce" (can't be KO'd once per turn) | "koImmuneBattle" (can't be KO'd in battle)
 | "removeImmune" (can't be removed from the Battle Area by opponent's skills) | "cantBeRested" | "attackActive" (can attack Active Mode Battle Cards)
Unconditional keywords go in "keywords". Conditional ones ("If X, this card gains [Blocker]") are a permanent ability with a grant effect on {"ref":"this"}.
AURAS (grant, power and costMod): a [Permanent] that affects OTHER cards ("Your Battle Cards with a cost of 3 can't be removed...", "All your <X> get +5000 power") is a permanent ability whose grant/power target has "all": true, e.g. {"t":"grant","target":{"all":true,"side":"self","filter":{"costEQ":3}},"kw":"removeImmune","dur":"static"}.

Evolve = { "from": [Filter] (Evolve) or [Filter, Filter] (Fusion Evolve), "cost": number of energy, "equalPowerGE"?: number, "orFrom"?: Filter[] (alternative bases), "baseMode"?: "rested" }

Ability = { "timing": Timing, "turn"?: "your"|"opp", "once"?: true ([Once per turn]), "cost"?: Cost[] (what comes before the colon), "cond"?: Cond[] (leading "If ..."), "effects": Effect[], "trigger"?: Filter (for whenAllyPlayed), "unparsed"?: string[] }
Timing: "onPlay" | "whenAttacking" | "whenBlocking" | "whenKOd" | "activateMain" | "activateBattle" | "permanent" | "endOfYourTurn" | "awaken" (Leader; the effects end with {"t":"flipLeader"})
 | "comboFromHand" ("When you use this card in a combo from your hand") | "comboFromField" ("...from the Battle Area") | "whenDamaged" ("When you take damage")
 | "whenAllyPlayed" ("When your <X> is played", filter in "trigger") | "whenMilled" ("When this card is placed from your deck into your Drop") | "gameStart" ("When this card is placed in your Leader Area")
 | "whenWinsBattle" ("When this card wins a battle") | "whenDealsDamage" ("When this card inflicts damage with an attack") | "whenKOsInBattle" ("When this card KO's an opponent's Battle Card in battle") | "whenAllyKOd" ("When your <X> is KO'd", filter in "trigger") | "comboFromDrop" ("When this card is used in a combo from your Drop") | "whenOppAttacks" ("When an opponent's Battle Card attacks")
 | "whenAllyRemovedBySelf" / "whenAllyRemovedByOpp" ("When your <X> is removed from the Battle Area by one of your skills / by your opponent", filter in "trigger")
 | "startOfYourTurn" | "whenAttacked" | "counter" ([Counter] skills)
A skill with two tags like [On Play/When Attacking] is two abilities with the same body.
Awaken condition example: "When your life is at 4 or less, draw 1 card. Then, flip this card over." -> {"timing":"awaken","cond":[{"t":"lifeLE","n":4}],"effects":[{"t":"draw","n":1},{"t":"flipLeader"}]}

Target (for effects that choose) — every field optional, defaults to up to 1 of your opponent's Battle Cards:
 { "side": "opp"|"self"|"any", "zones": ["battle"] | ["leader","battle"] | ["field"], "count": n, "upTo": bool, "all": bool ("choose all ..."), "filter": Filter,
   "ref": "this" | "leader" (your Leader) | "oppLeader" | "prev" (the card(s) the previous effect chose: "it", "that card") | "battler" (your card that's in a battle) | "oppBattler",
   "chooser": "opp" ("Your opponent KO's 1 of their ..." — the opponent picks; use "upTo": false) }
Filter (all optional): comboLE, comboEQ (printed combo power), costLE, costGE, costEQ, originalCost (bool), originalPower (bool: power filters use printed power), powerLE, powerGE, powerEQ, rested, active, names: ["Son Goku"] (card name contains), notNames, traits: ["Saiyan"] (any of),
 traitsAll (all of), onlyTraits ("≪Saiyan≫-only"), notTraits, colors: ["Red"], type: "BATTLE"|"EXTRA", other (not this card), keyword: e.g. "blocker"|"evolve"|"fusionEvolve", noSkill, kiGE, underNames,
 anyOf: [Filter, Filter] ("a <Sorbet> or a card with a cost of 1")

Effect (each may carry "cond": Cond[] for a mid-skill "Then, if ...,"):
 {"t":"draw","n"}  {"t":"discard","n"}  {"t":"oppDiscard","n"}  {"t":"mill","n"} (top n of your deck into your Drop)
 {"t":"lifeToHand","n","upTo"}  {"t":"lifeFromDeck","n"} (top of deck to life)  {"t":"handToLife","n","upTo"}  {"t":"handToDeck","n","bottom"?}
 {"t":"power","target","amount","dur","per"?: Count} ("for each ..."; draw, ki and costMod also take "per")  dur: "turn" | "battle" | "oppNextTurn" | "game" | "static" (permanent abilities)
 {"t":"comboPower","target":{"ref":"this"},"amount"}
 {"t":"ko","target"}  {"t":"bounce","target"} (to owner's hand)  {"t":"bottom","target"} (bottom of owner's deck)  {"t":"toDrop","target"} (into Drop, not a KO)  {"t":"toEnergy","target","rested"}
 {"t":"rest","target"}  {"t":"activate","target"} (switch to Active Mode)  {"t":"lockActive","target"} (can't switch to Active Mode during opponent's next turn)
 {"t":"grant","target","kw": Keyword,"dur"}  {"t":"costMod","target","amount": -1 (reduce) or +3 (increase),"dur"}
 {"t":"ki","target","n"} (+n Ki on the target)  {"t":"placeMarker","n"} (you place an energy marker)
 {"t":"search","look","options":[Filter...],"take","toHand":true,"dest"?: "hand"|"play"|"drop"|"life","rest"?: "bottom"|"drop"|"top"}
 {"t":"dropToHand","options":[Filter...],"each"} (add up to 'each' of each option from your Drop to your hand)
 {"t":"playFrom","from":"hand"|"drop"|"deck"|"energy","filter","n","rested"?}
 {"t":"energyFromDeck","n","rested"}  {"t":"energyFromDrop","filter","n","rested"}  {"t":"energyFromLife","n","rested"}  {"t":"energyFromHand","n","rested","filter"?}  {"t":"activateEnergy","n"}
 {"t":"costReduce","n"} (permanent: this card costs n less in hand; combine with cond)  {"t":"nextDiscount","filter","amount": n|"free"} (next card you use this turn)
 {"t":"cantPlay","filter","dur","extras"?} (you can't play/use these)  {"t":"oppTax","amount","filter"?}  {"t":"oppPlayRested","filter"}
 {"t":"self","to":"hand"|"drop"|"energy"|"deckBottom"|"play","rested"?} (move this card)  {"t":"damageLeader","n"}  {"t":"cantBlock"}  {"t":"flipLeader"}
 {"t":"placeUnder","target","from":"drop"|"hand"|"deck"|"battle","filters":[Filter...],"n"}  {"t":"comboFrom","from":"drop"|"deckTop","filter","n"}
 {"t":"choose","options":[[Effect...],[Effect...]]} ("Choose one —")  {"t":"noop","note"} (look/rearrange/shuffle with no game effect)
 {"t":"negate","target","dur","scope"?: "all"|"onPlay"} ("negate its skills for the turn")  {"t":"redirect","target":{"side":"self",...}} ("switch the attack target to the chosen card")
 playFrom also takes "negate": "onPlay"|"all" ("play it with its [On Play] skills negated for the turn")
 {"t":"atEndOfBattle","effects":[Effect...]} {"t":"oppMarker","n"} {"t":"winGame"} {"t":"selfDamage","n"} ("you take 1 damage") {"t":"energyToDrop","n"} (an effect, not a cost)
 {"t":"atEndOfTurn","effects":[Effect...]} ("At the end of the turn, ...")  {"t":"lockSkill","names","timing","dur"} ("you can't activate the [Activate:Main] of <X> for the turn")
 {"t":"dropToDeck"} (return all cards from your Drop to your deck, shuffled)  {"t":"lifeToDeck","n"} (n life cards to the bottom of your deck)
Count = {"side":"self"|"opp","zone":"battle"|"drop"|"hand"|"energy"|"life"|"deck"|"combo"|"under"|"thisKi"|"kiTotal"|"kiRemoved"|"prev","filter"?}
 (thisKi = Ki on this card; kiTotal = all your Ki; kiRemoved = Ki removed by this skill's cost; prev = cards the previous effect affected, e.g. "for each card KO'd by this skill")

Cost: {"t":"discard","n","filter"?} {"t":"restSelf"} {"t":"restEnergy","n"} ("(2)" or "pay 2 energy") {"t":"energyToDrop","n"} {"t":"selfToDrop"} {"t":"selfToHand"} {"t":"selfToDeckBottom"} {"t":"koSelf"}
 {"t":"lifeToHand","n"} {"t":"lifeToDrop","n"} {"t":"reduceKi","n","scope":"this"|"leader"|"your"|"battle","max"?} ("Remove 1 or more Ki" -> n:1,max:99; "Remove all 3 or more Ki" -> n:3,max:99) {"t":"koOwn","n","filter"} {"t":"restOwn","n","filter"} {"t":"dropOwn","n","filter"}
 {"t":"bounceOwn","n","filter"} {"t":"bottomOwn","n","filter"} {"t":"handToDeckTop","n"} {"t":"mill","n"} {"t":"reveal","filter"} {"t":"underToDrop","n","filter"?}
 {"t":"dropToDeck","n","filter"} (return n cards from your Drop to your deck) {"t":"handToUnder","filter","onto":Filter} {"t":"activateOwn","filter"} (switch your rested card to Active Mode)

Cond: {"t":"handLE"|"handGE"|"energyGE"|"energyLE"|"lifeLE"|"lifeGE"|"oppLifeLE"|"oppLifeGE"|"oppHandGE"|"dropGE","n"}
 {"t":"leaderIs","names"} {"t":"leaderTrait","traits","only"?} {"t":"leaderAwakened"} {"t":"kiLeaderGE","n"} {"t":"kiTotalGE","n","scope":"your"|"battle"} {"t":"thisKiGE","n"}
 {"t":"battleCount","op":"ge"|"none","n","filter","side":"self"|"opp"} {"t":"count","what":Count,"op":"ge"|"le"|"eq"|"none","n"}
 {"t":"hasMarker","yes"} {"t":"thisRested","yes"} {"t":"thisInBattle"} {"t":"playedThisTurn"} {"t":"comboAreaHasCard"} {"t":"energyLessThanOpp"}
 {"t":"attackingBattleCard","filter"?} {"t":"prevMatches","filter"} ("if that card has ...") {"t":"yourTurn","yes"} {"t":"not","c"} {"t":"or","any":[Cond...]} {"t":"and","all":[Cond...]}
 {"t":"thisHasUnder","yes"} {"t":"attacking","filter"} (this card is attacking a card matching filter) {"t":"koedThisTurn","filter"} (your matching card KO'd an opponent's card this turn)
 {"t":"playedByLeaderSkill"} {"t":"leaderInBattle"} {"t":"removedOwnThisTurn"} ("if your Battle Card was removed from a Battle Area by one of your skills during this turn")
 {"t":"kiRemovedThisTurn"} {"t":"comboFromFieldThisTurn"} {"t":"bouncedThisTurn"} {"t":"energyLeftThisTurn"} {"t":"extraUsedThisTurn","filter"?} {"t":"lifeLeftThisTurn"} {"t":"markerPaid"} (also "for this skill") {"t":"markerUsedThisTurn"} {"t":"comboFromDropThisTurn"} {"t":"removedBySkillThisTurn"} {"t":"oppHasMarker","yes"} ("if you removed an energy marker to use this card") {"t":"thisMatches","filter"} ("if this card has 30000 power or more") {"t":"playedBySkill"}
 {"t":"battleTotalCost","n","only"?: Filter} ("If you only have cards with ≪X≫ in your Battle Area and their total cost is 10 or more") {"t":"attackedThisTurn","yes"} {"t":"inBattleWith","filter"} ("while this card is in a battle with an opponent's card with ...")

EXAMPLES
"[On Play] Choose up to 1 of your opponent's Battle Cards with a cost of 2 or less and KO it."
 -> {"timing":"onPlay","effects":[{"t":"ko","target":{"filter":{"costLE":2}}}]}
"[When Attacking] Discard 1 card from your hand: Draw 1 card."
 -> {"timing":"whenAttacking","cost":[{"t":"discard","n":1}],"effects":[{"t":"draw","n":1}]}
"[Permanent][Your Turn] If your Leader is awakened, this card in a Battle Area gets +5000 power."
 -> {"timing":"permanent","turn":"your","cond":[{"t":"leaderAwakened"}],"effects":[{"t":"power","target":{"ref":"this"},"amount":5000,"dur":"static"}]}
"[Permanent] This card can't attack."  -> keywords: ["cantAttack"]
"[Activate:Battle] Your cards that are in a battle get +15000 power for the battle."
 -> {"timing":"activateBattle","effects":[{"t":"power","target":{"ref":"battler"},"amount":15000,"dur":"battle"}]}
"[On Play] If you don't have an energy marker, you place 1 energy marker."
 -> {"timing":"onPlay","cond":[{"t":"hasMarker","yes":false}],"effects":[{"t":"placeMarker","n":1}]}
"[On Play] If your Leader has ≪Saiyan≫ in its special traits, draw 1 card. Then, choose up to 1 Battle Card in your opponent's Battle Area and reduce its cost by 1 for the turn."
 -> {"timing":"onPlay","cond":[{"t":"leaderTrait","traits":["Saiyan"]}],"effects":[{"t":"draw","n":1},{"t":"costMod","target":{},"amount":-1,"dur":"turn"}]}
 (A leading "If" gates the whole ability; an "If" after "Then," goes on the effects it covers.)

A script REPLACES the card's whole reading: include every ability on the card, not only the hard one.
Answer with JSON only.
`.trim();
