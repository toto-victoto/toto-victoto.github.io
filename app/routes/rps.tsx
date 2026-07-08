import { useEffect, useReducer, useState } from "react";
import { Trans, useLingui } from "@lingui/react";
import type { Route } from "./+types/rps";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { peekGame, useStoredGame, type RpsSave } from "../storage";
import { sfx, startTitleTheme, stopTitleTheme } from "../sound";

// An RPG on rock-paper-scissors. The RPS itself stays pure & random — the
// strategy is PER-MOVE stakes: each move carries its own multiplier that scales
// the exchange you commit it to (damage dealt on a win, taken on a loss).
// Around an ANCHOR move: the anchor is OFFENSIVE and climbs by CLIMB each time
// you repeat it; the move it beats is DEFENSIVE and sheds DROP per repeat with
// NO floor — once it crosses below zero that move HEALS instead of dealing
// damage. The third move holds at 1. Repeat to push your lean (a draw pushes it
// once more); switch to a new move to cash the current factors, then reset all
// three to 1 and re-anchor.

type Move = "rock" | "paper" | "scissors";
type Outcome = "win" | "lose" | "draw";

const MOVES: { id: Move; emoji: string }[] = [
  { id: "rock", emoji: "✊" },
  { id: "paper", emoji: "✋" },
  { id: "scissors", emoji: "✌️" },
];
const BEATS: Record<Move, Move> = { rock: "scissors", paper: "rock", scissors: "paper" };

// A move's role is set by the anchor: the anchor itself is offensive (climbing),
// the move it beats is defensive (shrinking), the third is neutral.
const roleOf = (m: Move, anchor: Move | null): "up" | "down" | "flat" =>
  anchor === null ? "flat" : m === anchor ? "up" : m === BEATS[anchor] ? "down" : "flat";
const ROLE_COLOR: Record<"up" | "down" | "flat", string> = {
  up: "text-amber-300",
  down: "text-sky-300",
  flat: "text-neutral-500",
};
const judge = (p: Move, c: Move): Outcome =>
  p === c ? "draw" : BEATS[p] === c ? "win" : "lose";
const randomMove = (): Move => MOVES[Math.floor(Math.random() * MOVES.length)].id;
const emojiOf = (m: Move) => MOVES.find((x) => x.id === m)!.emoji;
const MARKER: Record<Move, string> = { rock: "💥", paper: "👋", scissors: "✂️" };

type Stats = { maxHp: number; str: number; def: number; agi: number; dex: number };
// Elite tiers get a distinctive look (bigger, glowing, tinted arena).
type FoeTier = "semiboss" | "boss" | "hidden";
// `key` slugs the foe's name id (rps.foe.<key>.name). The battle cry and last
// words are drawn from shared pools (roster bosses keep their signature lines),
// so each carries its own i18n id + English fallback.
type Foe = Stats & {
  key: string;
  emoji: string;
  name: string;
  cryId: string;
  cry: string;
  wordsId: string;
  lastWords: string;
  tier?: FoeTier;
};
type StatKey = "hp" | "str" | "def" | "agi" | "dex";

const STAT_KEYS: StatKey[] = ["hp", "str", "def", "agi", "dex"];
// Foes have no DEX (it's the player's multiplier-speed stat) — their stat line
// and placeholders show these four only.
const FOE_STAT_KEYS: StatKey[] = ["hp", "str", "def", "agi"];
// English fallbacks; localized via `rps.stat.label.<k>` (e.g. HP → PV in FR).
const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  str: "STR",
  def: "DEF",
  agi: "AGI",
  dex: "DEX",
};
// English fallbacks + their catalog ids — rendered via <Trans> in the modal.
const STAT_HELP: Record<StatKey, string> = {
  hp: "Health. Hit 0 and you're defeated.",
  str: "Attack power — your base damage.",
  def: "Cuts the damage you take.",
  agi: "Outspeed your foe to strike twice.",
  dex: "How fast your move multipliers climb and fall.",
};
const STAT_HELP_ID: Record<StatKey, string> = {
  hp: "rps.stat.hp",
  str: "rps.stat.str",
  def: "rps.stat.def",
  agi: "rps.stat.agi",
  dex: "rps.stat.dex",
};
// Applied gain per allocated point — shown on the level-up screen AND used to
// apply the allocation, so the two can't drift apart.
const STAT_GAIN: Record<StatKey, number> = { hp: 18, str: 1, def: 1, agi: 1, dex: 1 };

// Numbers run on a ~10× scale: a level-1 hero has 100 HP and lands ~10 base
// damage, so a turtled ×0.1 hit chips 1 and an escalated one bites deep.
const START: Stats = { maxHp: 100, str: 10, def: 5, agi: 3, dex: 0 };

// Stakes tuning. Each application the offensive (anchor) move MULTIPLIES by the
// climb factor while the defensive move (the one the anchor beats) SUBTRACTS the
// drop step; the third holds. DEX quickens both (+0.1 each). The defensive move
// has NO floor: past 0 it turns negative and, when used, heals instead of
// scaling damage — |value| × HEAL_RATE % of the player's max HP.
const CLIMB = 1.2; // base offensive multiplier growth per application
const DROP = 0.2; // base defensive multiplier decay per application
const DEX_STEP = 0.1; // each DEX point adds this much to both the climb and the drop
const STAKE_MAX = 50; // ceiling on the climbing offensive multiplier
const HEAL_RATE = 10; // a negative move heals |value| × this % of max HP
const HEAL_DMG = 0.1; // …and its exchange deals/takes damage at this flat factor
type Mults = Record<Move, number>;
const FRESH_MULTS: Mults = { rock: 1, paper: 1, scissors: 1 };

// One round of factors around an anchor: the anchor climbs, the move it beats
// drops (and may cross into negative → healing), the third is untouched.
const applyFactors = (m: Mults, anchor: Move, dex: number): Mults => {
  const next = { ...m };
  next[anchor] = Math.min(STAKE_MAX, next[anchor] * (CLIMB + dex * DEX_STEP));
  next[BEATS[anchor]] = next[BEATS[anchor]] - (DROP + dex * DEX_STEP);
  return next;
};

// The named story cast (fixed order, hand-tuned stats, signature cry/words).
// Two elites (semi-bosses) at levels 5 & 8, King Aldwin the boss (9), and Dread
// Volk the hidden boss (10). cryId/wordsId point at each one's catalog entry.
const ROSTER: Foe[] = ([
  { key: "farmhand", emoji: "🧑‍🌾", name: "Pip the Farmhand", cry: "Time to reap what you sow!", lastWords: "Well… I bought the farm…", maxHp: 18, str: 3, def: 0, agi: 1, dex: 0 },
  { key: "chef", emoji: "🧑‍🍳", name: "Chef Renard", cry: "You're getting roasted!", lastWords: "My soufflé… collapses…", maxHp: 30, str: 5, def: 2, agi: 2, dex: 1 },
  { key: "sentry", emoji: "💂", name: "Sentry Cole", cry: "None shall pass!", lastWords: "I had… one job…", maxHp: 46, str: 7, def: 3, agi: 2, dex: 1 },
  { key: "inspector", emoji: "🕵️", name: "Insp. Mora", cry: "Elementary. You lose.", lastWords: "The butler… did it…", maxHp: 66, str: 9, def: 6, agi: 4, dex: 2 },
  { key: "enchantress", emoji: "🧙‍♀️", name: "Morgause", cry: "Abraca-DIE-bra!", lastWords: "The threads… unravel…", maxHp: 92, str: 13, def: 7, agi: 6, dex: 3, tier: "semiboss" },
  { key: "ninja", emoji: "🥷", name: "Kaze", cry: "Blink and you're gone.", lastWords: "Didn't see… that one…", maxHp: 108, str: 14, def: 8, agi: 8, dex: 3 },
  { key: "magus", emoji: "🧑‍🎨", name: "Van Gore", cry: "I'll paint the town red.", lastWords: "Not my finest… stroke…", maxHp: 130, str: 17, def: 11, agi: 6, dex: 3 },
  { key: "valkyrie", emoji: "🧝‍♀️", name: "Valkyra", cry: "Winging it, as usual!", lastWords: "Clipped my… wings…", maxHp: 158, str: 21, def: 13, agi: 7, dex: 4, tier: "semiboss" },
  { key: "king", emoji: "🤴", name: "King Aldwin", cry: "Bow to the crown!", lastWords: "Heavy is… the head…", maxHp: 205, str: 26, def: 17, agi: 8, dex: 4, tier: "boss" },
  { key: "villain", emoji: "🦹", name: "Dread Volk", cry: "Behold my villain arc!", lastWords: "But I had… a trilogy planned…", maxHp: 275, str: 34, def: 22, agi: 11, dex: 5, tier: "hidden" },
] as Array<Omit<Foe, "cryId" | "wordsId">>).map((f) => ({
  ...f,
  cryId: `rps.foe.${f.key}.cry`,
  wordsId: `rps.foe.${f.key}.words`,
}));

// Beyond the roster, foes are generated. Each archetype (emoji + name) also
// carries a combat PROFILE that decides how its stat budget is spread — so a
// Kong berserks, a Siren darts, a Troll turtles. Roughly 40% are human-faced
// (undead, fae, merfolk…) for variety. Cries/last words come from shared pools.
type Profile =
  | "strong"
  | "wall"
  | "swift"
  | "balanced"
  | "trickster"
  | "glass"
  | "juggernaut"
  | "berserker"
  | "skirmisher"
  | "warlock";
const ARCHETYPES: { key: string; emoji: string; name: string; profile: Profile }[] = [
  // Human-faced / humanoid
  { key: "wanderer", emoji: "🧟", name: "Wanderer", profile: "juggernaut" },
  { key: "ghoul", emoji: "🧟‍♀️", name: "Ghoul", profile: "wall" },
  { key: "reaver", emoji: "🤺", name: "Reaver", profile: "skirmisher" },
  { key: "warden", emoji: "🧛", name: "Warden", profile: "balanced" },
  { key: "countess", emoji: "🧛‍♀️", name: "Countess", profile: "trickster" },
  { key: "specter", emoji: "🧝", name: "Specter", profile: "swift" },
  { key: "sylph", emoji: "🧚", name: "Sylph", profile: "skirmisher" },
  { key: "djinn", emoji: "🧞", name: "Djinn", profile: "warlock" },
  { key: "tideborn", emoji: "🧜‍♂️", name: "Tideborn", profile: "balanced" },
  { key: "siren", emoji: "🧜‍♀️", name: "Siren", profile: "swift" },
  { key: "troll", emoji: "🧌", name: "Troll", profile: "juggernaut" },
  { key: "hexen", emoji: "🧙‍♂️", name: "Hexen", profile: "warlock" },
  { key: "jester", emoji: "🤡", name: "Jester", profile: "trickster" },
  // Monstrous faces
  { key: "brute", emoji: "👹", name: "Brute", profile: "strong" },
  { key: "marauder", emoji: "👺", name: "Marauder", profile: "berserker" },
  { key: "imp", emoji: "👿", name: "Imp", profile: "glass" },
  { key: "wisp", emoji: "👻", name: "Wisp", profile: "swift" },
  { key: "bonelord", emoji: "💀", name: "Bonelord", profile: "balanced" },
  { key: "invader", emoji: "👾", name: "Invader", profile: "trickster" },
  { key: "sentinel", emoji: "🤖", name: "Sentinel", profile: "juggernaut" },
  { key: "hollow", emoji: "🎃", name: "Hollow", profile: "glass" },
  // Beasts
  { key: "wyrm", emoji: "🐉", name: "Wyrm", profile: "strong" },
  { key: "nightwing", emoji: "🦇", name: "Nightwing", profile: "skirmisher" },
  { key: "stinger", emoji: "🦂", name: "Stinger", profile: "berserker" },
  { key: "maw", emoji: "🦈", name: "Maw", profile: "strong" },
  { key: "fang", emoji: "🐺", name: "Fang", profile: "swift" },
  { key: "kong", emoji: "🦍", name: "Kong", profile: "berserker" },
  { key: "snapper", emoji: "🐊", name: "Snapper", profile: "wall" },
  { key: "rex", emoji: "🦖", name: "Rex", profile: "strong" },
  { key: "kraken", emoji: "🐙", name: "Kraken", profile: "wall" },
];

// Each profile is an HP multiplier + how the combat budget splits across the
// stats that actually matter in a fight (STR/DEF/AGI — weights sum to 1). DEX is
// a player-only stat (multiplier speed), so foes don't get one. HP and the
// combat budget scale separately so the ~10× HP scale never swamps the rest.
const PROFILES: Record<Profile, { hp: number; w: Record<"str" | "def" | "agi", number> }> = {
  strong: { hp: 1.0, w: { str: 0.57, def: 0.22, agi: 0.21 } }, // heavy hitter
  wall: { hp: 1.35, w: { str: 0.22, def: 0.6, agi: 0.18 } }, // defensive
  swift: { hp: 0.85, w: { str: 0.32, def: 0.13, agi: 0.55 } }, // fast, double-strikes
  balanced: { hp: 1.05, w: { str: 0.34, def: 0.33, agi: 0.33 } }, // all-rounder
  trickster: { hp: 0.9, w: { str: 0.4, def: 0.22, agi: 0.38 } }, // evasive duelist
  glass: { hp: 0.6, w: { str: 0.66, def: 0.09, agi: 0.25 } }, // glass cannon
  juggernaut: { hp: 1.7, w: { str: 0.24, def: 0.6, agi: 0.16 } }, // super tank
  berserker: { hp: 0.95, w: { str: 0.52, def: 0.1, agi: 0.38 } }, // reckless offense
  skirmisher: { hp: 0.8, w: { str: 0.46, def: 0.12, agi: 0.42 } }, // fast bruiser
  warlock: { hp: 0.75, w: { str: 0.62, def: 0.26, agi: 0.12 } }, // fragile nuker
};

const CRIES = [
  "You're toast!", "Come get a hug!", "Spoiler: you lose.", "I've fought scarier sneezes.",
  "No refunds!", "Bold of you to show up.", "Say your prayers!", "Out of your league, pal.",
  "Mind the gap — you're in it.", "This'll leave a mark.", "Is that fear, or cologne?", "My win rate is rude.",
  "Luck's on a break.", "Bow, or I rearrange you.", "I've been dying to win.", "Blink if you're scared.",
  "I called dibs on winning.", "Wrong doorbell, buddy.", "Cross me and cry.", "I've beaten tougher NPCs.",
  "Cardio won't save you.", "Feel my mild annoyance!", "Thanks for playing!", "You can still ragequit.",
  "Undefeated since breakfast.", "Wave bye-bye!", "Wrong opponent, champ.", "Time to git gud.",
];

const DEATHS = [
  "Ow. Rude.", "That's… allowed?", "Worth it. Mostly.", "Tell no one. Especially mum.",
  "Nerf this…", "GG…", "I regret… some things…", "Screenshot… that…",
  "That wasn't… in the tutorial…", "Not like this… lag…", "Respawning… surely…", "My loot… was rented…",
  "Mum said… desk job…", "Should've… dodged…", "Hacks… clearly…", "Rage… quitting… reality…",
  "Rate me… five stars…", "Was that… ranked…?", "Unsubscribe…", "Beaten… by YOU…?",
  "Skill issue… mine…", "GG no re…", "One-star… review…", "Loading… afterlife…",
  "Well… memed…", "Finally… a nap…", "Post this… clip…", "AFK… forever…",
];

const randOf = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
// Random ± swing around a base, widening a little with the run's depth.
const vary = (base: number, swing: number, min: number) =>
  Math.max(min, Math.round(base * (1 + (Math.random() * 2 - 1) * swing)));

// A generated foe's stat budget relative to the player it'll face. Foes have no
// DEX slot, so the same budget concentrates harder into STR/DEF/AGI — hence a
// normal foe sits below the player, a semiboss level, a boss just above.
const RATIO: Record<"normal" | "semiboss" | "boss", number> = {
  normal: 0.75,
  semiboss: 1.0,
  boss: 1.25,
};

// A generated foe, scaled to the player who'll fight it: HP and the combat
// budget (STR+DEF+AGI+DEX) each track the player's ×ratio, spread by the
// archetype's profile, then jittered per stat by a depth-widening swing. The
// elite tier is decided by the caller (see genTier).
function makeFoe(index: number, player: Stats = START, tier?: "semiboss" | "boss"): Foe {
  if (index < ROSTER.length) return ROSTER[index];
  const depth = index - ROSTER.length; // 0-based depth past the roster
  const ratio = tier ? RATIO[tier] : RATIO.normal;
  const swing = Math.min(0.45, 0.15 + depth * 0.02); // variance grows with depth
  const arch = randOf(ARCHETYPES);
  const { hp: hpMult, w } = PROFILES[arch.profile];
  const combat = ratio * Math.max(4, player.str + player.def + player.agi + player.dex);
  const cryIdx = Math.floor(Math.random() * CRIES.length);
  const wordIdx = Math.floor(Math.random() * DEATHS.length);
  return {
    key: arch.key,
    emoji: arch.emoji,
    name: arch.name,
    cryId: `rps.cry.${cryIdx}`,
    cry: CRIES[cryIdx],
    wordsId: `rps.death.${wordIdx}`,
    lastWords: DEATHS[wordIdx],
    tier,
    maxHp: vary(ratio * player.maxHp * hpMult, swing, 10),
    str: vary(combat * w.str, swing, 1),
    def: vary(combat * w.def, swing, 0),
    agi: vary(combat * w.agi, swing, 1),
    dex: 0, // DEX is a player-only stat — foes don't use or show it
  };
}

// Elite cadence for GENERATED foes: a boss every 10th level, plus one semiboss
// per decade at a level among 6–9. `seed` (per run) varies which one, so it's
// random run to run but consistent within a run.
function genTier(level: number, seed: number): "semiboss" | "boss" | undefined {
  if (level % 10 === 0) return "boss";
  const decade = Math.floor((level - 1) / 10);
  const semibossAt = 6 + (((seed ^ (decade * 0x9e3779b9)) >>> 0) % 4);
  return level - decade * 10 === semibossAt ? "semiboss" : undefined;
}

const pointsForLevel = (level: number) => 3 + Math.floor(level / 3);
const statValue = (s: Stats, k: StatKey) => (k === "hp" ? s.maxHp : s[k]);

const ROSTER_SIZE = ROSTER.length;
// Infinite mode: fight post-roster foes (foeIndex starts at ROSTER_SIZE) but
// count levels from 1, with a round war-chest of points to spend up front.
const INFINITE_POINTS = 50;

// Distinctive look for elites: a bigger, glowing emoji, a colored name + tag,
// a matching glow on the HP bar, and a subtly tinted arena. Normal foes render
// at text-7xl with none of this.
const TIER_STYLE: Record<
  FoeTier,
  {
    emoji: string;
    glow: string;
    name: string;
    chip: string;
    chipId: string;
    chipMsg: string;
    bg: string;
  }
> = {
  semiboss: {
    emoji: "text-8xl",
    glow: "drop-shadow(0 0 14px rgba(251,191,36,0.55))",
    name: "text-amber-200",
    chip: "bg-amber-500/25 text-amber-200 ring-amber-400/50",
    chipId: "rps.tier.semiboss",
    chipMsg: "Elite",
    bg: "bg-gradient-to-b from-amber-950/50 via-transparent to-transparent",
  },
  boss: {
    emoji: "text-8xl",
    glow: "drop-shadow(0 0 20px rgba(244,63,94,0.6))",
    name: "text-rose-300",
    chip: "bg-rose-500/25 text-rose-200 ring-rose-400/50",
    chipId: "rps.tier.boss",
    chipMsg: "Boss",
    bg: "bg-gradient-to-b from-rose-950/55 via-transparent to-transparent",
  },
  hidden: {
    emoji: "text-8xl",
    glow: "drop-shadow(0 0 24px rgba(167,139,250,0.7))",
    name: "text-violet-300",
    chip: "bg-violet-500/25 text-violet-200 ring-violet-400/50",
    chipId: "rps.tier.hidden",
    chipMsg: "Nemesis",
    bg: "bg-gradient-to-b from-violet-950/60 via-transparent to-transparent",
  },
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "RPS Saga — toto-victoto" },
    {
      name: "description",
      content:
        "An RPG on rock-paper-scissors: level up your stats and battle a cast of foes.",
    },
  ];
}

type Phase =
  | "splash"
  | "setup" // infinite-mode pre-fight point allocation
  | "intro"
  | "choose"
  | "count"
  | "clash"
  | "strike"
  | "death"
  | "levelup"
  | "gameover";
type Mode = "story" | "infinite";
type Round = {
  player: Move;
  foe: Move;
  outcome: Outcome;
  attacker: "you" | "foe" | null;
  dmg: number;
  hits: number[]; // split into two on an AGI double
  faster: boolean;
  mult: number; // the played move's multiplier, resolving this exchange
  doubled: boolean; // a draw reapplied the factors (repeat only)
  heal: number; // HP restored this round (a negative move heals, else 0)
  newMults: Mults; // per-move multipliers to commit once the round finishes
  newAnchor: Move; // anchor to commit once the round finishes
  resultFoeHp: number;
  resultHp: number;
};
type Hit = { key: number; dmg: number; target: "foe" | "you"; move: Move };

// ---- Run state machine -----------------------------------------------------
// One reducer owns everything that moves together during a run — the phase plus
// all the combat state. Independent UI concerns (the stats modal, the persisted
// record, the splash's saved-run) stay as plain useState in the component.
// Side effects (timers, sfx, localStorage) live in effects/handlers and only
// *dispatch* here; the reducer itself is pure.
type GameState = {
  phase: Phase;
  mode: Mode;
  player: Stats;
  hp: number;
  level: number;
  foeIndex: number;
  foe: Foe;
  foeHp: number;
  count: number;
  round: Round | null;
  hit: Hit | null;
  healPop: { key: number; amount: number } | null;
  points: number;
  alloc: Record<StatKey, number>;
  mults: Mults;
  anchor: Move | null;
  seed: number; // per-run seed driving the semiboss cadence (see genTier)
};

const ZERO_ALLOC: Record<StatKey, number> = { hp: 0, str: 0, def: 0, agi: 0, dex: 0 };

const initialState: GameState = {
  phase: "splash",
  mode: "story",
  player: START,
  hp: START.maxHp,
  level: 1,
  foeIndex: 0,
  foe: makeFoe(0),
  foeHp: makeFoe(0).maxHp,
  count: 0,
  round: null,
  hit: null,
  healPop: null,
  points: 0,
  alloc: ZERO_ALLOC,
  mults: FRESH_MULTS,
  anchor: null,
  seed: 0,
};

// Apply an allocation to a stat block. STAT_GAIN is per-point, so the numbers
// shown while allocating (alloc × STAT_GAIN) match exactly what lands here.
const applyAlloc = (p: Stats, a: Record<StatKey, number>): Stats => ({
  maxHp: p.maxHp + a.hp * STAT_GAIN.hp,
  str: p.str + a.str * STAT_GAIN.str,
  def: p.def + a.def * STAT_GAIN.def,
  agi: p.agi + a.agi * STAT_GAIN.agi,
  dex: p.dex + a.dex * STAT_GAIN.dex,
});

type Action =
  | { type: "continue"; save: RpsSave; seed: number }
  | { type: "restart"; foe: Foe; seed: number }
  | { type: "startInfinite"; foe: Foe; seed: number }
  | { type: "introDone" }
  | { type: "pick"; move: Move; foeMove: Move }
  | { type: "countTick" }
  | { type: "startClash" }
  | { type: "startStrike" }
  | { type: "heal"; amount: number; key: number }
  | { type: "damage"; target: "foe" | "you"; amount: number; move: Move; key: number }
  | { type: "finish" }
  | { type: "deathDone" }
  | { type: "addPoint"; stat: StatKey }
  | { type: "confirmSetup"; player: Stats; foe: Foe }
  | { type: "confirmLevelUp"; player: Stats; foe: Foe };

// Pure resolution of one exchange, given the played move and the foe's roll.
// The played move's carried multiplier scales the damage (or, when negative,
// heals and softens to a flat HEAL_DMG); then the per-move factors evolve
// around the anchor. Nothing here is committed until the "finish" action.
function resolveRound(state: GameState, move: Move, foeMove: Move): Round {
  const { player, foe, foeHp, hp, mults, anchor } = state;
  const outcome = judge(move, foeMove);
  const stk = mults[move];
  // Heal is |mult| × HEAL_RATE % of max HP, capped at a full 100%.
  const healPct = stk < 0 ? Math.min(1, (Math.abs(stk) * HEAL_RATE) / 100) : 0;
  const heal = stk < 0 ? Math.max(1, Math.round(healPct * player.maxHp)) : 0;
  const dmgMult = stk < 0 ? HEAL_DMG : stk;

  let attacker: "you" | "foe" | null = null;
  let dmg = 0;
  let faster = false;
  let resultFoeHp = foeHp;
  let resultHp = Math.min(player.maxHp, hp + heal); // healing lands first

  if (outcome === "win") {
    attacker = "you";
    faster = player.agi > foe.agi;
    let b = Math.max(1, player.str - foe.def);
    if (faster) b *= 2;
    dmg = Math.max(1, Math.round(b * dmgMult));
    resultFoeHp = Math.max(0, foeHp - dmg);
  } else if (outcome === "lose") {
    attacker = "foe";
    faster = foe.agi > player.agi;
    let b = Math.max(1, foe.str - player.def);
    if (faster) b *= 2;
    dmg = Math.max(1, Math.round(b * dmgMult));
    resultHp = Math.max(0, resultHp - dmg); // damage after the heal
  }

  // Evolve the multipliers for next turn.
  let newMults: Mults;
  let newAnchor: Move;
  let doubled = false;
  if (anchor === move) {
    // Repeat the anchor: apply the factors again (offence climbs, defence
    // drops). A draw reapplies them once more, fast-forwarding the lean.
    newAnchor = anchor;
    newMults = applyFactors(mults, anchor, player.dex);
    if (outcome === "draw") {
      // A draw reapplies the factors — but it only "deepens the stance" if
      // something can still move: offence below its cap, or defence not yet at
      // full-heal. When both are maxed, it's just a stalemate.
      const off = newMults[anchor];
      const def = newMults[BEATS[anchor]];
      newMults = applyFactors(newMults, anchor, player.dex);
      doubled = off < STAKE_MAX || def > -(100 / HEAL_RATE);
    }
  } else {
    // Switch: the exchange already cashed the current factors; re-anchor on
    // this move, reset all three to 1, and apply once.
    newAnchor = move;
    newMults = applyFactors(FRESH_MULTS, move, player.dex);
  }

  const hits = faster && dmg > 1 ? [Math.floor(dmg / 2), dmg - Math.floor(dmg / 2)] : [dmg];
  return { player: move, foe: foeMove, outcome, attacker, dmg, hits, faster, mult: stk, doubled, heal, newMults, newAnchor, resultFoeHp, resultHp };
}

function gameReducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "continue": {
      const s = action.save;
      return {
        ...state,
        mode: s.mode,
        player: s.player,
        hp: s.hp,
        level: s.level,
        foeIndex: s.foeIndex,
        foe: s.foe,
        foeHp: s.foeHp,
        mults: s.mults,
        anchor: s.anchor,
        seed: action.seed,
        round: null,
        hit: null,
        healPop: null,
        phase: "choose",
      };
    }
    case "restart":
      return { ...initialState, mode: "story", foe: action.foe, foeHp: action.foe.maxHp, seed: action.seed, phase: "intro" };
    case "startInfinite":
      // Fight post-roster foes (foeIndex past the roster) but count levels from
      // 1 like a fresh run, with a war-chest of points to spend up front. The
      // placeholder foe is hidden and regenerated (scaled to you) on confirm.
      return {
        ...initialState,
        mode: "infinite",
        level: 1,
        foeIndex: ROSTER_SIZE,
        foe: action.foe,
        foeHp: action.foe.maxHp,
        points: INFINITE_POINTS,
        seed: action.seed,
        phase: "setup",
      };
    case "introDone":
      return { ...state, phase: "choose" };
    case "pick":
      return {
        ...state,
        round: resolveRound(state, action.move, action.foeMove),
        count: 3,
        phase: "count",
      };
    case "countTick":
      return { ...state, count: Math.max(0, state.count - 1) };
    case "startClash":
      return { ...state, phase: "clash" };
    case "startStrike":
      return { ...state, phase: "strike" };
    case "heal":
      return {
        ...state,
        hp: Math.min(state.player.maxHp, state.hp + action.amount),
        healPop: { key: action.key, amount: action.amount },
      };
    case "damage": {
      const hit: Hit = { key: action.key, dmg: action.amount, target: action.target, move: action.move };
      return action.target === "foe"
        ? { ...state, foeHp: Math.max(0, state.foeHp - action.amount), hit }
        : { ...state, hp: Math.max(0, state.hp - action.amount), hit };
    }
    case "finish": {
      const r = state.round;
      if (!r) return state;
      // Commit the evolved multipliers + anchor now — after the exchange resolved.
      const base = { ...state, hit: null, healPop: null, mults: r.newMults, anchor: r.newAnchor };
      if (r.resultFoeHp <= 0) {
        const nl = state.level + 1;
        return { ...base, level: nl, points: pointsForLevel(nl), alloc: ZERO_ALLOC, phase: "death" };
      }
      if (r.resultHp <= 0) return { ...base, phase: "gameover" };
      return { ...base, phase: "choose" };
    }
    case "deathDone":
      return { ...state, phase: "levelup" };
    case "addPoint": {
      const spent = STAT_KEYS.reduce((n, k) => n + state.alloc[k], 0);
      if (spent >= state.points) return state;
      return { ...state, alloc: { ...state.alloc, [action.stat]: state.alloc[action.stat] + 1 } };
    }
    case "confirmSetup":
      // Infinite pre-fight: bank the points, then face a foe scaled to the
      // just-allocated player (built in the handler, after allocation).
      return {
        ...state,
        player: action.player,
        hp: action.player.maxHp,
        foe: action.foe,
        foeHp: action.foe.maxHp,
        alloc: ZERO_ALLOC,
        points: 0,
        phase: "intro",
      };
    case "confirmLevelUp":
      // player + next foe (scaled to the allocated player) come from the handler.
      return {
        ...state,
        player: action.player,
        hp: action.player.maxHp,
        foeIndex: state.foeIndex + 1,
        foe: action.foe,
        foeHp: action.foe.maxHp,
        mults: FRESH_MULTS,
        anchor: null,
        alloc: ZERO_ALLOC,
        phase: "intro",
      };
    default:
      return state;
  }
}

export default function RPS() {
  const [state, dispatch] = useReducer(gameReducer, initialState);
  const { phase, mode, player, hp, level, foeIndex, foe, foeHp, count, round, hit, healPop, points, alloc, mults, anchor, seed } = state;
  const [stored, setStored] = useStoredGame("rps", { bestLevel: 0 });
  const [showStats, setShowStats] = useState(false);
  const { i18n } = useLingui();
  const tLabel = (k: StatKey) =>
    i18n._(`rps.stat.label.${k}`, undefined, { message: STAT_LABEL[k] });
  // Guards the save-snapshot effect until the splash has read any prior run,
  // so we never overwrite a save before offering to continue it.
  const [resumed, setResumed] = useState(false);
  // Interrupted runs found on mount — one per mode, each offered as its own
  // "Continue" on the splash. null → no run to resume in that mode.
  const [storySave, setStorySave] = useState<RpsSave | null>(null);
  const [infiniteSave, setInfiniteSave] = useState<RpsSave | null>(null);

  // On mount, surface any interrupted runs for the splash's Continue buttons.
  useEffect(() => {
    const s = peekGame("rps");
    setStorySave(s?.save ?? null);
    setInfiniteSave(s?.infiniteSave ?? null);
    setResumed(true);
  }, []);

  // The looping title jingle plays while the splash is up.
  useEffect(() => {
    if (phase !== "splash") return;
    startTitleTheme();
    return () => stopTitleTheme();
  }, [phase]);

  const rollSeed = () => Math.floor(Math.random() * 0x7fffffff);

  const continueRun = (save: RpsSave) => {
    dispatch({ type: "continue", save, seed: save.seed ?? rollSeed() });
  };

  // Start a fresh story run; drop only the adventure snapshot (records survive).
  const restart = () => {
    dispatch({ type: "restart", foe: makeFoe(0), seed: rollSeed() });
    setStored((s) => ({ ...s, save: undefined }));
  };

  // Jump into a fresh infinite run; drop only the infinite snapshot.
  const startInfinite = () => {
    dispatch({ type: "startInfinite", foe: makeFoe(ROSTER_SIZE), seed: rollSeed() });
    setStored((s) => ({ ...s, infiniteSave: undefined }));
  };

  // Snapshot the run every time we land on the move-choice screen — the one
  // stable, resumable moment (never mid-animation). Each mode has its own slot.
  useEffect(() => {
    if (!resumed || phase !== "choose") return;
    const snap: RpsSave = { mode, player, hp, level, foeIndex, foe, foeHp, mults, anchor, seed };
    setStored((s) =>
      mode === "infinite" ? { ...s, infiniteSave: snap } : { ...s, save: snap },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumed, phase]);

  // Persist + sfx on the run's turning points: a kill records the best result
  // (per mode), a defeat drops the resume snapshot but keeps the records.
  useEffect(() => {
    if (phase === "death") {
      sfx.win();
      // Record foes DEFEATED (level - 1): on a kill `level` is already the next
      // level, so `level - 1` is the one just cleared. Dying with no win → 0.
      if (mode === "infinite")
        setStored((s) => ({ ...s, infiniteBest: Math.max(s.infiniteBest ?? 0, level - 1) }));
      else setStored((s) => ({ ...s, bestLevel: Math.max(s.bestLevel, level - 1) }));
    } else if (phase === "gameover") {
      sfx.lose();
      // Run's over — clear only this mode's snapshot, keep records + the other mode.
      setStored((s) =>
        mode === "infinite" ? { ...s, infiniteSave: undefined } : { ...s, save: undefined },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== "intro") return;
    sfx.ui();
    const t = setTimeout(() => dispatch({ type: "introDone" }), 2200);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "count") return;
    if (count <= 0) {
      dispatch({ type: "startClash" });
      return;
    }
    const t = setTimeout(() => {
      sfx.ui();
      dispatch({ type: "countTick" });
    }, 260);
    return () => clearTimeout(t);
  }, [phase, count]);

  useEffect(() => {
    if (phase !== "clash") return;
    const t = setTimeout(() => dispatch({ type: "startStrike" }), 500);
    return () => clearTimeout(t);
  }, [phase]);

  // Drive the strike animation: heal pop, staggered hit(s), then finish. Each
  // step dispatches into the reducer; the timing and sfx stay here.
  useEffect(() => {
    if (phase !== "strike" || !round) return;
    const r = round;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // A negative move heals FIRST — pop a green +N and lift the player's HP.
    if (r.heal > 0) {
      dispatch({ type: "heal", amount: r.heal, key: Date.now() });
      sfx.score();
    }
    const startDelay = r.heal > 0 ? 500 : 0; // let the heal read before damage lands

    if (r.outcome === "draw") {
      if (r.heal === 0) sfx.ui();
      timers.push(setTimeout(() => dispatch({ type: "finish" }), startDelay + 700));
      return () => timers.forEach(clearTimeout);
    }

    const target: "foe" | "you" = r.outcome === "win" ? "foe" : "you";
    r.hits.forEach((c, i) => {
      timers.push(
        setTimeout(() => {
          dispatch({ type: "damage", target, amount: c, move: r.player, key: Date.now() + i });
          if (target === "foe") sfx.score();
          else sfx.ui();
        }, startDelay + i * 300),
      );
    });
    timers.push(setTimeout(() => dispatch({ type: "finish" }), startDelay + (r.hits.length - 1) * 300 + 1050));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== "death") return;
    const t = setTimeout(() => dispatch({ type: "deathDone" }), 1700);
    return () => clearTimeout(t);
  }, [phase]);

  const pick = (move: Move) => {
    if (phase !== "choose") return;
    dispatch({ type: "pick", move, foeMove: randomMove() });
  };

  const spent = STAT_KEYS.reduce((n, k) => n + alloc[k], 0);
  const remaining = points - spent;
  const addPoint = (k: StatKey) => dispatch({ type: "addPoint", stat: k });
  // The foe you'll fight is built HERE — after the allocation — so it's always
  // scaled to the player who faces it, and never before your points are spent.
  const confirmSetup = () => {
    const np = applyAlloc(player, alloc);
    dispatch({ type: "confirmSetup", player: np, foe: makeFoe(foeIndex, np, genTier(level, seed)) });
  };
  const confirmLevelUp = () => {
    const np = applyAlloc(player, alloc);
    const nextLevel = level + 1;
    dispatch({
      type: "confirmLevelUp",
      player: np,
      foe: makeFoe(foeIndex + 1, np, genTier(nextLevel, seed)),
    });
  };

  const foeHitting = hit?.target === "foe";
  const youHit = hit?.target === "you";
  const foeAnim = foeHitting ? `rps-hit-${hit.move} 480ms ease-out` : undefined;
  const showingTomb = phase === "death" || phase === "levelup";
  // During the infinite pre-fight, the foe is a mystery until points are spent.
  const hideFoe = phase === "setup";
  const foeEmoji = showingTomb ? "🪦" : hideFoe ? "❔" : foe.emoji;
  const tierStyle = foe.tier ? TIER_STYLE[foe.tier] : null;
  // Full elite treatment (badge/name/glow/tint) only during the live fight…
  const ts = !showingTomb && !hideFoe ? tierStyle : null;
  // …but keep the emoji SIZE through the gravestone so the layout doesn't jump.
  const foeSize = !hideFoe && tierStyle ? tierStyle.emoji : "text-7xl";
  // Localized foe flavor — the stored English literals are the fallbacks.
  const foeName = i18n._(`rps.foe.${foe.key}.name`, undefined, { message: foe.name });
  const foeCry = i18n._(foe.cryId, undefined, { message: foe.cry });
  const foeWords = i18n._(foe.wordsId, undefined, { message: foe.lastWords });

  // Infinite runs measure progress as levels past the roster.
  const infinite = mode === "infinite";
  const record = infinite ? stored.infiniteBest ?? 0 : stored.bestLevel;
  // Infinite unlocks once the adventure record hits 9 (beat the King).
  const infiniteUnlocked = stored.bestLevel >= 9;

  // Title screen — shown on load, before any fight. Offers Continue (when a
  // run was interrupted) and Start / Restart.
  if (phase === "splash") {
    return (
      <>
        <BackButton />
        <GameLayout>
          <div className="flex flex-1 flex-col items-center justify-center gap-12 text-center">
            <div className="space-y-4 motion-safe:animate-rps-tick">
              <div className="flex items-center justify-center gap-3 text-5xl">
                <span aria-hidden="true">✊</span>
                <span aria-hidden="true">✋</span>
                <span aria-hidden="true">✌️</span>
              </div>
              <h1
                className="bg-gradient-to-br from-amber-200 via-orange-400 to-rose-500 bg-clip-text text-6xl font-black tracking-tighter text-transparent"
                style={{ filter: "drop-shadow(0 2px 12px rgba(251,146,60,0.35))" }}
              >
                RPS Saga
              </h1>
              <p className="text-sm text-neutral-500">
                <Trans id="rps.splash.tagline" message="An RPG on rock-paper-scissors" />
              </p>
            </div>
            {/* Hold the buttons until localStorage is read, so the correct
                Continue/Start set appears at once instead of flashing Start. */}
            <div className="flex min-h-[3.25rem] w-full max-w-xs flex-col gap-3">
              {resumed && (
                <>
                  {storySave && (
                    <button
                      onClick={() => continueRun(storySave)}
                      className="w-full rounded-full bg-emerald-500 py-3 font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-95"
                    >
                      <Trans id="rps.rpg.continue" message="Continue" /> ·{" "}
                      <span className="tabular-nums">Lv {storySave.level}</span>
                    </button>
                  )}
                  {infiniteUnlocked && infiniteSave && (
                    <button
                      onClick={() => continueRun(infiniteSave)}
                      className="w-full rounded-full bg-fuchsia-500 py-3 font-semibold text-neutral-950 transition hover:bg-fuchsia-400 active:scale-95"
                    >
                      ♾️ <Trans id="rps.rpg.continue" message="Continue" /> ·{" "}
                      <span className="tabular-nums">Lv {infiniteSave.level}</span>
                    </button>
                  )}
                  <button
                    onClick={restart}
                    className={`w-full rounded-full py-3 font-semibold transition active:scale-95 ${
                      storySave
                        ? "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                        : "bg-sky-500 text-neutral-950 hover:bg-sky-400"
                    }`}
                  >
                    {storySave ? (
                      <Trans id="rps.splash.restart" message="Restart" />
                    ) : (
                      <Trans id="rps.splash.start" message="Start" />
                    )}
                  </button>
                  {infiniteUnlocked && (
                    <button
                      onClick={startInfinite}
                      className="w-full rounded-full bg-neutral-800 py-3 font-semibold text-fuchsia-300 ring-1 ring-fuchsia-500/40 transition hover:bg-neutral-700 active:scale-95"
                    >
                      ♾️ <Trans id="rps.splash.infinite" message="Infinite" />
                      {(stored.infiniteBest ?? 0) > 0 && (
                        <span className="ml-1 text-fuchsia-400/70 tabular-nums">
                          · 🏆 {stored.infiniteBest}
                        </span>
                      )}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </GameLayout>
      </>
    );
  }

  return (
    <>
      <BackButton />
      <GameLayout tint={ts?.bg}>
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans id="rps.title" message="RPS Saga" />
          </h1>
          <span className="text-sm font-bold tabular-nums text-amber-300">
            {infinite && "♾️ "}
            Lv {level}
          </span>
        </header>

        {/* Foe */}
        <section className="relative space-y-1 text-center">
          <div
            key={foeHitting ? `foe-${hit.key}` : "foe-static"}
            className={`inline-block leading-none will-change-transform ${foeSize}`}
            style={{ animation: foeAnim, filter: ts?.glow }}
            aria-hidden="true"
          >
            {foeEmoji}
          </div>
          {foeHitting && (
            <div
              key={`mark-${hit.key}`}
              className="pointer-events-none absolute inset-x-0 top-0 text-center text-3xl font-black"
              style={{ animation: "rps-float 900ms ease-out forwards" }}
              aria-hidden="true"
            >
              {MARKER[hit.move]}
              <span className="ml-1 text-rose-300">-{hit.dmg}</span>
            </div>
          )}
          {ts && (
            <div
              className={`relative z-10 mx-auto mt-1.5 w-fit rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${ts.chip}`}
            >
              <Trans id={ts.chipId} message={ts.chipMsg} />
            </div>
          )}
          <div
            className={`font-semibold ${ts ? ts.name : hideFoe ? "text-neutral-500" : "text-neutral-200"}`}
          >
            {hideFoe ? "???" : foeName}
          </div>
          <div
            key={foeHitting ? `bar-${hit.key}` : "bar"}
            style={foeHitting ? { animation: "rps-shake 380ms ease-out" } : undefined}
          >
            {hideFoe ? (
              <div className="space-y-0.5">
                <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                  <div className="h-full w-full rounded-full bg-neutral-700/50" />
                </div>
                <div className="text-right text-[11px] tabular-nums text-neutral-600">???</div>
              </div>
            ) : (
              <HpBar hp={foeHp} max={foe.maxHp} className="bg-rose-500" glow={ts?.glow} />
            )}
          </div>
          {hideFoe ? (
            <div className="flex justify-center gap-3 text-[11px] tabular-nums text-neutral-600">
              {FOE_STAT_KEYS.map((k) => (
                <span key={k}>
                  <span>{tLabel(k)}</span> ?
                </span>
              ))}
            </div>
          ) : (
            <StatLine stats={foe} omitDex />
          )}
        </section>

        {/* Middle — phase content */}
        <section className="flex min-h-0 flex-1 items-center justify-center">
          {phase === "intro" && (
            <p className="mx-auto max-w-xs rounded-2xl bg-neutral-800 px-4 py-2 text-sm italic text-neutral-300 motion-safe:animate-rps-tick">
              “{foeCry}”
            </p>
          )}

          {phase === "death" && (
            <div className="space-y-2 text-center">
              <p className="text-sm text-neutral-500">
                <Trans id="rps.rip" message="R.I.P. {name}" values={{ name: foeName }} />
              </p>
              <p className="mx-auto max-w-xs rounded-2xl bg-neutral-800 px-4 py-2 text-sm italic text-neutral-300 motion-safe:animate-rps-tick">
                “{foeWords}”
              </p>
            </div>
          )}

          {phase === "choose" && (
            <p className="text-neutral-400">
              <Trans id="rps.choose" message="Choose your move" />
            </p>
          )}

          {phase === "count" && round && (
            <div className="space-y-2 text-center">
              <div className="text-5xl" aria-hidden="true">
                {emojiOf(round.player)}
              </div>
              <div
                key={count}
                className="text-3xl font-bold tabular-nums text-neutral-400 motion-safe:animate-rps-tick"
                aria-live="polite"
              >
                {count}
              </div>
            </div>
          )}

          {(phase === "clash" || phase === "strike") && round && (
            <div className="space-y-3 text-center">
              <div className="flex items-center justify-center gap-6 text-5xl">
                <span aria-hidden="true">{emojiOf(round.player)}</span>
                <span className="text-2xl text-neutral-600">vs</span>
                <span aria-hidden="true">{emojiOf(round.foe)}</span>
              </div>
              {phase === "clash" ? (
                <p
                  className={`text-lg font-medium ${
                    round.outcome === "win"
                      ? "text-emerald-400"
                      : round.outcome === "lose"
                        ? "text-rose-400"
                        : "text-neutral-400"
                  }`}
                >
                  {round.outcome === "win" && (
                    <Trans id="rps.round.win" message="You win the round!" />
                  )}
                  {round.outcome === "lose" && (
                    <Trans
                      id="rps.round.lose"
                      message="{name} wins the round"
                      values={{ name: foeName }}
                    />
                  )}
                  {round.outcome === "draw" && <Trans id="rps.draw" message="Draw" />}
                </p>
              ) : (
                <StrikeBanner round={round} foeName={foeName} />
              )}
            </div>
          )}

          {(phase === "levelup" || phase === "setup") && (
            <div className="w-full max-w-xs space-y-3">
              <div className="text-center">
                <p className="text-xl font-bold text-amber-300">
                  {phase === "setup" ? (
                    <Trans id="rps.setup.title" message="Gear up" />
                  ) : (
                    <Trans id="rps.rpg.levelup" message="Level up!" />
                  )}
                </p>
                <p className="text-sm text-neutral-400">
                  <Trans id="rps.rpg.spend" message="Spend your points" /> ·{" "}
                  <span className="font-bold tabular-nums text-neutral-100">{remaining}</span>
                </p>
              </div>
              <div className="space-y-1.5">
                {STAT_KEYS.map((k) => (
                  <div key={k} className="flex items-center gap-3">
                    <span className="w-10 text-neutral-400">{tLabel(k)}</span>
                    <span className="flex-1 tabular-nums text-neutral-200">
                      {statValue(player, k)}
                      {alloc[k] > 0 && (
                        <span className="text-emerald-400"> +{alloc[k] * STAT_GAIN[k]}</span>
                      )}
                    </span>
                    <button
                      onClick={() => addPoint(k)}
                      disabled={remaining <= 0}
                      className="h-7 w-7 rounded-full bg-neutral-800 text-lg font-bold leading-none text-emerald-300 transition hover:bg-neutral-700 active:scale-95 disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={phase === "setup" ? confirmSetup : confirmLevelUp}
                disabled={remaining > 0}
                className="w-full rounded-full bg-emerald-500 py-2.5 font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-95 disabled:opacity-40"
              >
                {phase === "setup" ? (
                  <Trans id="rps.rpg.fight" message="Fight!" />
                ) : (
                  <Trans id="rps.rpg.continue" message="Continue" />
                )}
              </button>
            </div>
          )}

          {phase === "gameover" && (
            <div className="space-y-3 text-center">
              <p className="text-xl font-bold text-rose-300">
                <Trans id="rps.rpg.defeated" message="You were defeated" />
              </p>
              <p className="text-sm text-neutral-400">
                {infinite && "♾️ "}
                <Trans id="rps.rpg.reached" message="Reached level {level}" values={{ level }} />
              </p>
              <p className="text-sm font-semibold text-amber-300">
                <Trans id="common.best" message="Best" /> · Lv <span className="tabular-nums">{record}</span>
              </p>
              <button
                onClick={infinite ? startInfinite : restart}
                className="rounded-full bg-sky-500 px-8 py-3 font-semibold text-neutral-950 transition hover:bg-sky-400 active:scale-95"
              >
                <Trans id="rps.rpg.tryagain" message="Try again" />
              </button>
            </div>
          )}
        </section>

        {/* Player */}
        <section
          key={youHit ? `you-${hit.key}` : "you"}
          className="relative space-y-1"
          style={youHit ? { animation: "rps-shake 440ms ease-out" } : undefined}
        >
          {youHit && (
            <div
              className="pointer-events-none absolute inset-x-0 -top-6 text-center text-lg font-black text-rose-300"
              style={{ animation: "rps-float 900ms ease-out forwards" }}
              aria-hidden="true"
            >
              -{hit.dmg}
            </div>
          )}
          {healPop && (
            <div
              key={`heal-${healPop.key}`}
              className="pointer-events-none absolute inset-x-0 -top-11 text-center text-lg font-black text-emerald-300"
              style={{ animation: "rps-float 1100ms ease-out forwards" }}
              aria-hidden="true"
            >
              +{healPop.amount}
            </div>
          )}
          <HpBar hp={hp} max={player.maxHp} className="bg-emerald-500" />
          <div className="flex items-center justify-center gap-2">
            <StatLine stats={player} highlight />
            <button
              type="button"
              onClick={() => setShowStats(true)}
              aria-label="What do the stats mean?"
              className="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-bold text-neutral-400 transition hover:bg-neutral-700 hover:text-neutral-200"
            >
              ?
            </button>
          </div>
        </section>

        <section
          key={youHit ? `moves-${hit.key}` : "moves"}
          className="grid grid-cols-3 gap-4"
          style={youHit ? { animation: "rps-shake 440ms ease-out" } : undefined}
        >
          {MOVES.map((m) => {
            const role = roleOf(m.id, anchor);
            const val = mults[m.id];
            const heals = val < 0; // dropped past 0 → this move now heals
            return (
              <button
                key={m.id}
                onClick={() => pick(m.id)}
                disabled={phase !== "choose"}
                aria-label={m.id}
                className={`flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl text-5xl ring-2 transition active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${
                  heals
                    ? "bg-emerald-900/40 ring-emerald-400 hover:bg-emerald-900/60"
                    : role === "up"
                      ? "bg-neutral-700 ring-amber-400"
                      : role === "down"
                        ? "bg-neutral-800 ring-sky-500/40 hover:bg-neutral-700"
                        : "bg-neutral-800 ring-transparent hover:bg-neutral-700"
                }`}
              >
                <span aria-hidden="true">{m.emoji}</span>
                {heals ? (
                  <span className="flex flex-col items-center pt-1 leading-none">
                    <span className="text-[10px] font-bold tabular-nums text-sky-300">
                      ×{HEAL_DMG}
                    </span>
                    <span className="pt-0.5 text-xs font-bold tabular-nums text-emerald-300">
                      ♥{Math.min(100, Math.abs(val) * HEAL_RATE).toFixed(0)}%
                    </span>
                  </span>
                ) : (
                  <span className={`pt-1 text-xs font-bold tabular-nums ${ROLE_COLOR[role]}`}>
                    ×{val.toFixed(1)}
                  </span>
                )}
              </button>
            );
          })}
        </section>

        {showStats && (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
            onClick={() => setShowStats(false)}
          >
            <div
              className="w-full max-w-xs space-y-3 rounded-2xl bg-neutral-900 p-5 ring-1 ring-neutral-700"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold text-neutral-100">
                <Trans id="rps.stats.title" message="Stats" />
              </h2>
              <dl className="space-y-2 text-sm">
                {STAT_KEYS.map((k) => (
                  <div key={k} className="flex gap-3">
                    <dt className="w-9 shrink-0 font-bold text-neutral-300">{tLabel(k)}</dt>
                    <dd className="text-neutral-400">
                      <Trans id={STAT_HELP_ID[k]} message={STAT_HELP[k]} />
                    </dd>
                  </div>
                ))}
              </dl>
              <button
                type="button"
                onClick={() => setShowStats(false)}
                className="w-full rounded-full bg-neutral-800 py-2 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-700 active:scale-95"
              >
                <Trans id="rps.stats.gotit" message="Got it" />
              </button>
            </div>
          </div>
        )}
      </GameLayout>
    </>
  );
}

// The combat call-outs — the move's multiplier, the AGI double, or a draw's
// deepened stance all get a pop.
function StrikeBanner({ round, foeName }: { round: Round; foeName: string }) {
  const lines: React.ReactNode[] = [];
  if (round.heal > 0)
    lines.push(
      <span className="text-emerald-300">
        💚 <Trans id="rps.banner.healed" message="Healed {amount}" values={{ amount: round.heal }} />
      </span>,
    );

  if (round.outcome === "draw") {
    lines.push(
      <span className="text-amber-300">
        {round.doubled ? (
          <Trans id="rps.banner.stalemate_deep" message="Stalemate — stance deepens!" />
        ) : (
          <Trans id="rps.banner.stalemate" message="Stalemate!" />
        )}
      </span>,
    );
    return (
      <div className="space-y-1 text-lg font-bold">
        {lines.map((l, i) => (
          <p key={i} className="motion-safe:animate-rps-tick">
            {l}
          </p>
        ))}
      </div>
    );
  }
  // Skip the damage-multiplier call-outs when the move healed — its damage is a flat ×1.
  if (round.heal === 0 && round.mult >= 1.15)
    lines.push(
      <span className="text-amber-300">
        ⚔{" "}
        <Trans
          id="rps.banner.stakes"
          message="Stakes ×{mult}!"
          values={{ mult: round.mult.toFixed(1) }}
        />
      </span>,
    );
  else if (round.heal === 0 && round.mult >= 0 && round.mult <= 0.85)
    lines.push(
      <span className="text-sky-300">
        <Trans
          id="rps.banner.softened"
          message="Softened ×{mult}"
          values={{ mult: round.mult.toFixed(1) }}
        />
      </span>,
    );
  if (round.faster)
    lines.push(
      <span className="text-amber-300">
        {round.attacker === "you" ? (
          <Trans id="rps.banner.faster_you" message="You're faster!" />
        ) : (
          <Trans id="rps.banner.faster_foe" message="{name} is faster!" values={{ name: foeName }} />
        )}{" "}
        <span className="text-amber-200">×2</span>
      </span>,
    );
  if (lines.length === 0)
    lines.push(
      <span className={round.attacker === "you" ? "text-emerald-400" : "text-rose-400"}>
        {round.attacker === "you" ? (
          <Trans id="rps.banner.hit" message="Hit!" />
        ) : (
          <Trans id="rps.banner.youhit" message="You're hit!" />
        )}
      </span>,
    );
  return (
    <div className="space-y-1 text-lg font-bold">
      {lines.map((l, i) => (
        <p key={i} className="motion-safe:animate-rps-tick">
          {l}
        </p>
      ))}
    </div>
  );
}

function HpBar({
  hp,
  max,
  className,
  glow,
}: {
  hp: number;
  max: number;
  className: string;
  glow?: string;
}) {
  const pct = Math.max(0, Math.min(100, (hp / max) * 100));
  return (
    <div className="space-y-0.5">
      <div className="h-2 overflow-hidden rounded-full bg-neutral-800" style={{ filter: glow }}>
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${className}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-right text-[11px] tabular-nums text-neutral-500">
        {hp}/{max}
      </div>
    </div>
  );
}

function StatLine({
  stats,
  highlight,
  omitDex,
}: {
  stats: Stats;
  highlight?: boolean;
  omitDex?: boolean;
}) {
  const { i18n } = useLingui();
  const keys = omitDex ? FOE_STAT_KEYS : STAT_KEYS;
  return (
    <div
      className={`flex justify-center gap-3 text-[11px] tabular-nums ${
        highlight ? "text-neutral-300" : "text-neutral-500"
      }`}
    >
      {keys.map((k) => (
        <span key={k}>
          <span className="text-neutral-500">
            {i18n._(`rps.stat.label.${k}`, undefined, { message: STAT_LABEL[k] })}
          </span>{" "}
          {statValue(stats, k)}
        </span>
      ))}
    </div>
  );
}
