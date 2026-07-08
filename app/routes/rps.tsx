import { useEffect, useReducer, useState } from "react";
import { Trans, useLingui } from "@lingui/react";
import type { Route } from "./+types/rps";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { peekGame, useStoredGame, type Persisted } from "../storage";
import { sfx } from "../sound";

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
// `key` slugs the foe for its i18n ids (rps.foe.<key>.name/.cry/.words); the
// name/cry/lastWords literals are the English fallbacks.
type Foe = Stats & { key: string; emoji: string; name: string; cry: string; lastWords: string };
type StatKey = "hp" | "str" | "def" | "agi" | "dex";

const STAT_KEYS: StatKey[] = ["hp", "str", "def", "agi", "dex"];
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
const STAT_GAIN: Record<StatKey, number> = { hp: 18, str: 2, def: 2, agi: 1, dex: 1 };

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
const STAKE_MAX = 64; // ceiling on the climbing offensive multiplier
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

const ROSTER: Foe[] = [
  { key: "farmhand", emoji: "🧑‍🌾", name: "Pip the Farmhand", cry: "Get off my field!", lastWords: "Tell the cows… I tried.", maxHp: 18, str: 3, def: 0, agi: 1, dex: 0 },
  { key: "chef", emoji: "🧑‍🍳", name: "Chef Renard", cry: "You'll be minced!", lastWords: "My soufflé… collapses…", maxHp: 31, str: 5, def: 2, agi: 2, dex: 1 },
  { key: "sentry", emoji: "💂", name: "Sentry Cole", cry: "None shall pass!", lastWords: "I had… one job…", maxHp: 49, str: 7, def: 3, agi: 2, dex: 1 },
  { key: "inspector", emoji: "🕵️", name: "Insp. Mora", cry: "The trail ends here.", lastWords: "The butler… did it…", maxHp: 67, str: 8, def: 7, agi: 4, dex: 2 },
  { key: "ninja", emoji: "🥷", name: "Kaze", cry: "Blink and you're gone.", lastWords: "Didn't see… that one…", maxHp: 84, str: 12, def: 7, agi: 7, dex: 3 },
  { key: "magus", emoji: "🧙", name: "Magus Orin", cry: "Feel the arcane!", lastWords: "My magic… was 60% vibes…", maxHp: 111, str: 15, def: 10, agi: 5, dex: 3 },
  { key: "king", emoji: "🤴", name: "King Aldwin", cry: "Kneel before me!", lastWords: "Heavy is… the head…", maxHp: 142, str: 20, def: 13, agi: 6, dex: 3 },
  { key: "villain", emoji: "🦹", name: "Dread Volk", cry: "Your story ends.", lastWords: "But I had… a trilogy planned…", maxHp: 189, str: 27, def: 17, agi: 9, dex: 4 },
];

const EXTRA_EMOJI = ["🧟", "👹", "🤺", "🧛", "🦸", "👺", "🧝", "🧌"];
const EXTRA_KEY = ["wanderer", "brute", "reaver", "warden", "fiend", "marauder", "specter", "troll"];
const EXTRA_NAME = ["Wanderer", "Brute", "Reaver", "Warden", "Fiend", "Marauder", "Specter", "Troll"];
const EXTRA_CRY = [
  "You're finished!",
  "Come closer.",
  "This ends now.",
  "I've faced worse.",
  "No mercy.",
  "You dare?",
  "Breathe your last.",
  "Beyond your reach.",
];
const EXTRA_LASTWORDS = [
  "Ow.",
  "That's it?",
  "Worth it.",
  "Tell no one.",
  "Rats…",
  "So it ends.",
  "I regret… nothing.",
  "Glorious…",
];

function makeFoe(index: number): Foe {
  if (index < ROSTER.length) return ROSTER[index];
  const t = index - ROSTER.length;
  const i = t % EXTRA_EMOJI.length;
  return {
    key: EXTRA_KEY[i],
    emoji: EXTRA_EMOJI[i],
    name: EXTRA_NAME[i],
    cry: EXTRA_CRY[i],
    lastWords: EXTRA_LASTWORDS[i],
    maxHp: 200 + t * 36,
    str: 28 + t * 3,
    def: 18 + t * 2,
    agi: 10 + t,
    dex: 4 + Math.floor(t / 2),
  };
}

const pointsForLevel = (level: number) => 3 + Math.floor(level / 3);
const statValue = (s: Stats, k: StatKey) => (k === "hp" ? s.maxHp : s[k]);

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
  | "intro"
  | "choose"
  | "count"
  | "clash"
  | "strike"
  | "death"
  | "levelup"
  | "gameover";
// The snapshot persisted at the move-choice screen (see storage's Persisted.rps).
type SavedRun = NonNullable<Persisted["rps"]["save"]>;
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
};

const ZERO_ALLOC: Record<StatKey, number> = { hp: 0, str: 0, def: 0, agi: 0, dex: 0 };

const initialState: GameState = {
  phase: "splash",
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
};

type Action =
  | { type: "continue"; save: SavedRun }
  | { type: "restart" }
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
  | { type: "confirmLevelUp" };

// Pure resolution of one exchange, given the played move and the foe's roll.
// The played move's carried multiplier scales the damage (or, when negative,
// heals and softens to a flat HEAL_DMG); then the per-move factors evolve
// around the anchor. Nothing here is committed until the "finish" action.
function resolveRound(state: GameState, move: Move, foeMove: Move): Round {
  const { player, foe, foeHp, hp, mults, anchor } = state;
  const outcome = judge(move, foeMove);
  const stk = mults[move];
  const heal = stk < 0 ? Math.max(1, Math.round((Math.abs(stk) * HEAL_RATE) / 100 * player.maxHp)) : 0;
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
      newMults = applyFactors(newMults, anchor, player.dex);
      doubled = true;
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
        player: s.player,
        hp: s.hp,
        level: s.level,
        foeIndex: s.foeIndex,
        foe: makeFoe(s.foeIndex),
        foeHp: s.foeHp,
        mults: s.mults,
        anchor: s.anchor,
        round: null,
        hit: null,
        healPop: null,
        phase: "choose",
      };
    }
    case "restart":
      return { ...initialState, foe: makeFoe(0), foeHp: makeFoe(0).maxHp, phase: "intro" };
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
    case "confirmLevelUp": {
      const a = state.alloc;
      const np: Stats = {
        maxHp: state.player.maxHp + a.hp * STAT_GAIN.hp,
        str: state.player.str + a.str,
        def: state.player.def + a.def,
        agi: state.player.agi + a.agi,
        dex: state.player.dex + a.dex,
      };
      const next = state.foeIndex + 1;
      const nf = makeFoe(next);
      return {
        ...state,
        player: np,
        hp: np.maxHp,
        foeIndex: next,
        foe: nf,
        foeHp: nf.maxHp,
        mults: FRESH_MULTS,
        anchor: null,
        alloc: ZERO_ALLOC,
        phase: "intro",
      };
    }
    default:
      return state;
  }
}

export default function RPS() {
  const [state, dispatch] = useReducer(gameReducer, initialState);
  const { phase, player, hp, level, foeIndex, foe, foeHp, count, round, hit, healPop, points, alloc, mults, anchor } = state;
  const [stored, setStored] = useStoredGame("rps", { bestLevel: 0 });
  const [showStats, setShowStats] = useState(false);
  const { i18n } = useLingui();
  // Guards the save-snapshot effect until the splash has read any prior run,
  // so we never overwrite a save before offering to continue it.
  const [resumed, setResumed] = useState(false);
  // An interrupted run found on mount (snapshotted at the move-choice screen),
  // offered as "Continue" on the splash. null → no run to resume.
  const [savedRun, setSavedRun] = useState<SavedRun | null>(null);

  // On mount, surface any interrupted run for the splash's Continue button.
  useEffect(() => {
    setSavedRun(peekGame("rps")?.save ?? null);
    setResumed(true);
  }, []);

  const continueRun = () => {
    if (savedRun) dispatch({ type: "continue", save: savedRun });
  };

  // Start a fresh run and drop any resume snapshot (the record survives).
  const restart = () => {
    dispatch({ type: "restart" });
    setStored((s) => ({ bestLevel: s.bestLevel }));
  };

  // Snapshot the run every time we land on the move-choice screen — the one
  // stable, resumable moment (never mid-animation).
  useEffect(() => {
    if (!resumed || phase !== "choose") return;
    setStored((s) => ({
      ...s,
      save: { player, hp, level, foeIndex, foeHp, mults, anchor },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumed, phase]);

  // Persist + sfx on the run's turning points: a kill records the best level,
  // a defeat drops the resume snapshot.
  useEffect(() => {
    if (phase === "death") {
      sfx.win();
      setStored((s) => ({ ...s, bestLevel: Math.max(s.bestLevel, level) }));
    } else if (phase === "gameover") {
      sfx.lose();
      setStored((s) => ({ bestLevel: s.bestLevel }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== "intro") return;
    sfx.ui();
    const t = setTimeout(() => dispatch({ type: "introDone" }), 1600);
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
  const confirmLevelUp = () => dispatch({ type: "confirmLevelUp" });

  const foeHitting = hit?.target === "foe";
  const youHit = hit?.target === "you";
  const foeAnim = foeHitting ? `rps-hit-${hit.move} 480ms ease-out` : undefined;
  const foeEmoji = phase === "death" || phase === "levelup" ? "🪦" : foe.emoji;
  // Localized foe flavor — the stored English literals are the fallbacks.
  const foeName = i18n._(`rps.foe.${foe.key}.name`, undefined, { message: foe.name });
  const foeCry = i18n._(`rps.foe.${foe.key}.cry`, undefined, { message: foe.cry });
  const foeWords = i18n._(`rps.foe.${foe.key}.words`, undefined, { message: foe.lastWords });

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
              <h1 className="bg-gradient-to-br from-amber-200 via-orange-400 to-rose-500 bg-clip-text text-6xl font-black tracking-tighter text-transparent drop-shadow-[0_2px_12px_rgba(251,146,60,0.35)]">
                RPS Saga
              </h1>
              <p className="text-sm text-neutral-500">
                <Trans id="rps.splash.tagline" message="An RPG on rock-paper-scissors" />
              </p>
            </div>
            <div className="flex w-full max-w-xs flex-col gap-3">
              {savedRun && (
                <button
                  onClick={continueRun}
                  className="w-full rounded-full bg-emerald-500 py-3 font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-95"
                >
                  <Trans id="rps.rpg.continue" message="Continue" /> ·{" "}
                  <span className="tabular-nums">Lv {savedRun.level}</span>
                </button>
              )}
              <button
                onClick={restart}
                className={`w-full rounded-full py-3 font-semibold transition active:scale-95 ${
                  savedRun
                    ? "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                    : "bg-sky-500 text-neutral-950 hover:bg-sky-400"
                }`}
              >
                {savedRun ? (
                  <Trans id="rps.splash.restart" message="Restart" />
                ) : (
                  <Trans id="rps.splash.start" message="Start" />
                )}
              </button>
            </div>
          </div>
        </GameLayout>
      </>
    );
  }

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans id="rps.title" message="RPS Saga" />
          </h1>
          <span className="text-sm font-bold tabular-nums text-amber-300">Lv {level}</span>
        </header>

        {/* Foe */}
        <section className="relative space-y-1 text-center">
          <div
            key={foeHitting ? `foe-${hit.key}` : "foe-static"}
            className="inline-block text-7xl leading-none will-change-transform"
            style={foeAnim ? { animation: foeAnim } : undefined}
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
          <div className="font-semibold text-neutral-200">{foeName}</div>
          <div
            key={foeHitting ? `bar-${hit.key}` : "bar"}
            style={foeHitting ? { animation: "rps-shake 380ms ease-out" } : undefined}
          >
            <HpBar hp={foeHp} max={foe.maxHp} className="bg-rose-500" />
          </div>
          <StatLine stats={foe} />
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

          {phase === "levelup" && (
            <div className="w-full max-w-xs space-y-3">
              <div className="text-center">
                <p className="text-xl font-bold text-amber-300">
                  <Trans id="rps.rpg.levelup" message="Level up!" />
                </p>
                <p className="text-sm text-neutral-400">
                  <Trans id="rps.rpg.spend" message="Spend your points" /> ·{" "}
                  <span className="font-bold tabular-nums text-neutral-100">{remaining}</span>
                </p>
              </div>
              <div className="space-y-1.5">
                {STAT_KEYS.map((k) => (
                  <div key={k} className="flex items-center gap-3">
                    <span className="w-10 text-neutral-400">{STAT_LABEL[k]}</span>
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
                onClick={confirmLevelUp}
                disabled={remaining > 0}
                className="w-full rounded-full bg-emerald-500 py-2.5 font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-95 disabled:opacity-40"
              >
                <Trans id="rps.rpg.continue" message="Continue" />
              </button>
            </div>
          )}

          {phase === "gameover" && (
            <div className="space-y-3 text-center">
              <p className="text-xl font-bold text-rose-300">
                <Trans id="rps.rpg.defeated" message="You were defeated" />
              </p>
              <p className="text-sm text-neutral-400">
                <Trans
                  id="rps.rpg.reached"
                  message="Reached level {level}"
                  values={{ level }}
                />
              </p>
              <p className="text-sm font-semibold text-amber-300">
                <Trans id="common.best" message="Best" /> · Lv {stored.bestLevel}
              </p>
              <button
                onClick={restart}
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
                      ♥{(Math.abs(val) * HEAL_RATE).toFixed(0)}%
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
                    <dt className="w-9 shrink-0 font-bold text-neutral-300">{STAT_LABEL[k]}</dt>
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

function HpBar({ hp, max, className }: { hp: number; max: number; className: string }) {
  const pct = Math.max(0, Math.min(100, (hp / max) * 100));
  return (
    <div className="space-y-0.5">
      <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
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

function StatLine({ stats, highlight }: { stats: Stats; highlight?: boolean }) {
  return (
    <div
      className={`flex justify-center gap-3 text-[11px] tabular-nums ${
        highlight ? "text-neutral-300" : "text-neutral-500"
      }`}
    >
      {STAT_KEYS.map((k) => (
        <span key={k}>
          <span className="text-neutral-500">{STAT_LABEL[k]}</span> {statValue(stats, k)}
        </span>
      ))}
    </div>
  );
}
