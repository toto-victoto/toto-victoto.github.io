import { useEffect, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/rps";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { sfx } from "../sound";

// An RPG on rock-paper-scissors. The RPS itself stays pure & random — the
// strategy is a REPETITION multiplier: repeat a move and its multipliers climb
// (almost exponentially), switch and they reset. ✊ escalates both attack and
// damage-taken, ✌️ shrinks both (turtle), ✋ is neutral. A draw doubles them.
// DEX governs how fast the multipliers move. First POC — numbers to tune.

type Move = "rock" | "paper" | "scissors";
type Outcome = "win" | "lose" | "draw";

const MOVES: { id: Move; emoji: string }[] = [
  { id: "rock", emoji: "✊" },
  { id: "paper", emoji: "✋" },
  { id: "scissors", emoji: "✌️" },
];
const BEATS: Record<Move, Move> = { rock: "scissors", paper: "rock", scissors: "paper" };

// Stakes change relative to your LAST move (not a fixed one): repeat it to
// escalate, play the move it beats to soften, play the third to hold.
const roleOf = (m: Move, last: Move | null): "up" | "down" | "flat" =>
  last === null ? "flat" : m === last ? "up" : m === BEATS[last] ? "down" : "flat";
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
type Foe = Stats & { emoji: string; name: string; cry: string; lastWords: string };
type StatKey = "hp" | "str" | "def" | "agi" | "dex";

const STAT_KEYS: StatKey[] = ["hp", "str", "def", "agi", "dex"];
const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  str: "STR",
  def: "DEF",
  agi: "AGI",
  dex: "DEX",
};
const STAT_GAIN: Record<StatKey, number> = { hp: 8, str: 1, def: 1, agi: 1, dex: 1 };

const START: Stats = { maxHp: 45, str: 6, def: 3, agi: 3, dex: 2 };

// Stakes tuning: per-repeat growth (DEX quickens it) and bounds. One "stakes"
// multiplier scales BOTH damage dealt and damage taken.
const growthRate = (dex: number) => 0.5 + dex * 0.13;
const STAKE_MIN = 0.25;
const STAKE_MAX = 64;
const clampStake = (v: number) => Math.max(STAKE_MIN, Math.min(STAKE_MAX, v));

const ROSTER: Foe[] = [
  { emoji: "🧑‍🌾", name: "Pip the Farmhand", cry: "Get off my field!", lastWords: "Tell the cows… I tried.", maxHp: 8, str: 2, def: 0, agi: 1, dex: 0 },
  { emoji: "🧑‍🍳", name: "Chef Renard", cry: "You'll be minced!", lastWords: "My soufflé… collapses…", maxHp: 14, str: 3, def: 1, agi: 2, dex: 1 },
  { emoji: "💂", name: "Sentry Cole", cry: "None shall pass!", lastWords: "I had… one job…", maxHp: 22, str: 4, def: 2, agi: 2, dex: 1 },
  { emoji: "🕵️", name: "Insp. Mora", cry: "The trail ends here.", lastWords: "The butler… did it…", maxHp: 30, str: 5, def: 4, agi: 4, dex: 2 },
  { emoji: "🥷", name: "Kaze", cry: "Blink and you're gone.", lastWords: "Didn't see… that one…", maxHp: 38, str: 7, def: 4, agi: 7, dex: 3 },
  { emoji: "🧙", name: "Magus Orin", cry: "Feel the arcane!", lastWords: "My magic… was 60% vibes…", maxHp: 50, str: 9, def: 6, agi: 5, dex: 3 },
  { emoji: "🤴", name: "King Aldwin", cry: "Kneel before me!", lastWords: "Heavy is… the head…", maxHp: 64, str: 12, def: 8, agi: 6, dex: 3 },
  { emoji: "🦹", name: "Dread Volk", cry: "Your story ends.", lastWords: "But I had… a trilogy planned…", maxHp: 85, str: 16, def: 10, agi: 9, dex: 4 },
];

const EXTRA_EMOJI = ["🧟", "👹", "🤺", "🧛", "🦸", "👺", "🧝", "🧌"];
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
    emoji: EXTRA_EMOJI[i],
    name: EXTRA_NAME[i],
    cry: EXTRA_CRY[i],
    lastWords: EXTRA_LASTWORDS[i],
    maxHp: 90 + t * 16,
    str: 17 + t * 2,
    def: 11 + t,
    agi: 10 + t,
    dex: 4 + Math.floor(t / 2),
  };
}

const pointsForLevel = (level: number) => 2 + Math.floor(level / 3);
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
  | "intro"
  | "choose"
  | "count"
  | "clash"
  | "strike"
  | "death"
  | "levelup"
  | "gameover";
type Round = {
  player: Move;
  foe: Move;
  outcome: Outcome;
  attacker: "you" | "foe" | null;
  dmg: number;
  hits: number[]; // split into two on an AGI double
  faster: boolean;
  mult: number; // multiplier applied to this exchange (off on win, def on loss)
  doubled: boolean; // a draw doubled the stakes
  resultFoeHp: number;
  resultHp: number;
};
type Hit = { key: number; dmg: number; target: "foe" | "you"; move: Move };

export default function RPS() {
  const [player, setPlayer] = useState<Stats>(START);
  const [hp, setHp] = useState(START.maxHp);
  const [level, setLevel] = useState(1);
  const [foeIndex, setFoeIndex] = useState(0);
  const [foe, setFoe] = useState<Foe>(() => makeFoe(0));
  const [foeHp, setFoeHp] = useState(() => makeFoe(0).maxHp);
  const [phase, setPhase] = useState<Phase>("intro");
  const [count, setCount] = useState(0);
  const [round, setRound] = useState<Round | null>(null);
  const [hit, setHit] = useState<Hit | null>(null);
  const [points, setPoints] = useState(0);
  const [alloc, setAlloc] = useState<Record<StatKey, number>>({
    hp: 0,
    str: 0,
    def: 0,
    agi: 0,
    dex: 0,
  });
  // One "stakes" multiplier (scales damage dealt AND taken), driven by how each
  // move relates to the last one played.
  const [stakes, setStakes] = useState(1);
  const [lastMove, setLastMove] = useState<Move | null>(null);
  const [, setStored] = useStoredGame("rps", { bestLevel: 0 });

  useEffect(() => {
    if (phase !== "intro") return;
    sfx.ui();
    const t = setTimeout(() => setPhase("choose"), 1600);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "count") return;
    if (count <= 0) {
      setPhase("clash");
      return;
    }
    const t = setTimeout(() => {
      sfx.ui();
      setCount((c) => c - 1);
    }, 260);
    return () => clearTimeout(t);
  }, [phase, count]);

  useEffect(() => {
    if (phase !== "clash") return;
    const t = setTimeout(() => setPhase("strike"), 500);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "strike" || !round) return;
    const r = round;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = () => {
      setHit(null);
      if (r.resultFoeHp <= 0) {
        const nl = level + 1;
        setLevel(nl);
        setPoints(pointsForLevel(nl));
        setAlloc({ hp: 0, str: 0, def: 0, agi: 0, dex: 0 });
        setStored((s) => ({ bestLevel: Math.max(s.bestLevel, nl) }));
        setPhase("death");
        sfx.win();
      } else if (r.resultHp <= 0) {
        setPhase("gameover");
        sfx.lose();
      } else {
        setPhase("choose");
      }
    };

    if (r.outcome === "draw") {
      setHit(null);
      sfx.ui();
      timers.push(setTimeout(finish, 700));
      return () => timers.forEach(clearTimeout);
    }

    const target: "foe" | "you" = r.outcome === "win" ? "foe" : "you";
    const base = target === "foe" ? foeHp : hp;
    const apply = target === "foe" ? setFoeHp : setHp;
    let cum = 0;
    r.hits.forEach((c, i) => {
      timers.push(
        setTimeout(() => {
          cum += c;
          apply(Math.max(0, base - cum));
          setHit({ key: Date.now() + i, dmg: c, target, move: r.player });
          if (target === "foe") sfx.score();
          else sfx.ui();
        }, i * 300),
      );
    });
    timers.push(setTimeout(finish, (r.hits.length - 1) * 300 + 1050));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== "death") return;
    const t = setTimeout(() => setPhase("levelup"), 1700);
    return () => clearTimeout(t);
  }, [phase]);

  const pick = (move: Move) => {
    if (phase !== "choose") return;
    const foeMove = randomMove();
    const outcome = judge(move, foeMove);

    // Move the stakes based on this throw's relation to the last move.
    let stk = stakes;
    if (lastMove !== null) {
      const r = growthRate(player.dex);
      if (move === lastMove) stk = clampStake(stk * (1 + r)); // repeat → escalate
      else if (move === BEATS[lastMove]) stk = clampStake(stk * (1 - r * 0.55)); // soften
      // the third move: unchanged (hold)
    }

    let attacker: "you" | "foe" | null = null;
    let dmg = 0;
    let faster = false;
    let mult = stk;
    let doubled = false;
    let resultFoeHp = foeHp;
    let resultHp = hp;

    if (outcome === "win") {
      attacker = "you";
      faster = player.agi > foe.agi;
      let b = Math.max(1, player.str - foe.def);
      if (faster) b *= 2;
      dmg = Math.max(1, Math.round(b * stk));
      resultFoeHp = Math.max(0, foeHp - dmg);
    } else if (outcome === "lose") {
      attacker = "foe";
      faster = foe.agi > player.agi;
      let b = Math.max(1, foe.str - player.def);
      if (faster) b *= 2;
      dmg = Math.max(1, Math.round(b * stk));
      resultHp = Math.max(0, hp - dmg);
    } else {
      // draw — double the stakes for what comes next
      stk = clampStake(stk * 2);
      mult = stk;
      doubled = true;
    }

    setStakes(stk);
    setLastMove(move);

    const hits = faster && dmg > 1 ? [Math.floor(dmg / 2), dmg - Math.floor(dmg / 2)] : [dmg];
    setRound({ player: move, foe: foeMove, outcome, attacker, dmg, hits, faster, mult, doubled, resultFoeHp, resultHp });
    setCount(3);
    setPhase("count");
  };

  const spent = STAT_KEYS.reduce((n, k) => n + alloc[k], 0);
  const remaining = points - spent;
  const addPoint = (k: StatKey) => {
    if (remaining <= 0) return;
    setAlloc((a) => ({ ...a, [k]: a[k] + 1 }));
  };

  const nextFoe = () => {
    setStakes(1);
    setLastMove(null);
  };

  const confirmLevelUp = () => {
    const np: Stats = {
      maxHp: player.maxHp + alloc.hp * STAT_GAIN.hp,
      str: player.str + alloc.str,
      def: player.def + alloc.def,
      agi: player.agi + alloc.agi,
      dex: player.dex + alloc.dex,
    };
    setPlayer(np);
    setHp(np.maxHp);
    const next = foeIndex + 1;
    setFoeIndex(next);
    const nf = makeFoe(next);
    setFoe(nf);
    setFoeHp(nf.maxHp);
    nextFoe();
    setPhase("intro");
  };

  const restart = () => {
    setPlayer(START);
    setHp(START.maxHp);
    setLevel(1);
    setFoeIndex(0);
    const nf = makeFoe(0);
    setFoe(nf);
    setFoeHp(nf.maxHp);
    setRound(null);
    nextFoe();
    setPhase("intro");
  };

  const foeHitting = hit?.target === "foe";
  const youHit = hit?.target === "you";
  const foeAnim = foeHitting ? `rps-hit-${hit.move} 480ms ease-out` : undefined;
  const foeEmoji = phase === "death" || phase === "levelup" ? "🪦" : foe.emoji;
  // What the stakes multiplier would become if you played each move now.
  const growth = growthRate(player.dex);
  const projectStakes = (m: Move): number => {
    if (lastMove === null) return stakes;
    if (m === lastMove) return clampStake(stakes * (1 + growth));
    if (m === BEATS[lastMove]) return clampStake(stakes * (1 - growth * 0.55));
    return stakes;
  };

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
          <div className="font-semibold text-neutral-200">{foe.name}</div>
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
              “{foe.cry}”
            </p>
          )}

          {phase === "death" && (
            <div className="space-y-2 text-center">
              <p className="text-sm text-neutral-500">R.I.P. {foe.name}</p>
              <p className="mx-auto max-w-xs rounded-2xl bg-neutral-800 px-4 py-2 text-sm italic text-neutral-300 motion-safe:animate-rps-tick">
                “{foe.lastWords}”
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
                  {round.outcome === "win" && "You win the round!"}
                  {round.outcome === "lose" && `${foe.name} wins the round`}
                  {round.outcome === "draw" && "Draw"}
                </p>
              ) : (
                <StrikeBanner round={round} foe={foe} />
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
          <HpBar hp={hp} max={player.maxHp} className="bg-emerald-500" />
          <StatLine stats={player} highlight />
        </section>

        <section
          key={youHit ? `moves-${hit.key}` : "moves"}
          className="grid grid-cols-3 gap-4"
          style={youHit ? { animation: "rps-shake 440ms ease-out" } : undefined}
        >
          {MOVES.map((m) => {
            const role = roleOf(m.id, lastMove);
            const proj = projectStakes(m.id);
            return (
              <button
                key={m.id}
                onClick={() => pick(m.id)}
                disabled={phase !== "choose"}
                aria-label={m.id}
                className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-2xl text-5xl ring-2 transition active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${
                  role === "up"
                    ? "bg-neutral-700 ring-amber-400"
                    : role === "down"
                      ? "bg-neutral-800 ring-sky-500/40 hover:bg-neutral-700"
                      : "bg-neutral-800 ring-transparent hover:bg-neutral-700"
                }`}
              >
                <span aria-hidden="true">{m.emoji}</span>
                <span className={`text-xs font-bold tabular-nums ${ROLE_COLOR[role]}`}>
                  ×{proj.toFixed(1)}
                </span>
              </button>
            );
          })}
        </section>
      </GameLayout>
    </>
  );
}

// The combat call-outs — the streak multiplier, the AGI double, or a draw's
// doubled stakes all get a pop.
function StrikeBanner({ round, foe }: { round: Round; foe: Foe }) {
  if (round.outcome === "draw") {
    return (
      <p className="text-lg font-bold text-amber-300 motion-safe:animate-rps-tick">
        Stalemate — stakes doubled! ×2
      </p>
    );
  }
  const lines: React.ReactNode[] = [];
  if (round.mult >= 1.15)
    lines.push(<span className="text-amber-300">⚔ Stakes ×{round.mult.toFixed(1)}!</span>);
  else if (round.mult <= 0.85)
    lines.push(<span className="text-sky-300">Softened ×{round.mult.toFixed(1)}</span>);
  if (round.faster)
    lines.push(
      <span className="text-amber-300">
        {round.attacker === "you" ? "You're faster!" : `${foe.name} is faster!`}{" "}
        <span className="text-amber-200">×2</span>
      </span>,
    );
  if (lines.length === 0)
    lines.push(
      <span className={round.attacker === "you" ? "text-emerald-400" : "text-rose-400"}>
        {round.attacker === "you" ? "Hit!" : "You're hit!"}
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
