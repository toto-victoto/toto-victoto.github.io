import { useEffect, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/rps";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { sfx } from "../sound";

// A gimmicky RPG on top of rock-paper-scissors: each RPS round is one exchange.
// Win the RPS and you strike; lose it and the foe strikes. First POC — numbers
// are meant to be tuned.

type Move = "rock" | "paper" | "scissors";
type Outcome = "win" | "lose" | "draw";

const MOVES: { id: Move; emoji: string }[] = [
  { id: "rock", emoji: "✊" },
  { id: "paper", emoji: "✋" },
  { id: "scissors", emoji: "✌️" },
];
const BEATS: Record<Move, Move> = { rock: "scissors", paper: "rock", scissors: "paper" };
const judge = (p: Move, c: Move): Outcome =>
  p === c ? "draw" : BEATS[p] === c ? "win" : "lose";
const randomMove = (): Move => MOVES[Math.floor(Math.random() * MOVES.length)].id;
const emojiOf = (m: Move) => MOVES.find((x) => x.id === m)!.emoji;
// The hit marker that flies off the foe, keyed to the winning move.
const MARKER: Record<Move, string> = { rock: "💥", paper: "👋", scissors: "✂️" };

type Stats = { maxHp: number; str: number; def: number; agi: number; luk: number };
type Foe = Stats & { emoji: string; name: string; cry: string };
type StatKey = "hp" | "str" | "def" | "agi" | "luk";

const STAT_KEYS: StatKey[] = ["hp", "str", "def", "agi", "luk"];
const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  str: "STR",
  def: "DEF",
  agi: "AGI",
  luk: "LUK",
};
const STAT_GAIN: Record<StatKey, number> = { hp: 4, str: 1, def: 1, agi: 1, luk: 1 };

const START: Stats = { maxHp: 20, str: 5, def: 2, agi: 3, luk: 1 };

const ROSTER: Foe[] = [
  { emoji: "🧑‍🌾", name: "Pip the Farmhand", cry: "Get off my field!", maxHp: 3, str: 1, def: 0, agi: 1, luk: 0 },
  { emoji: "🧑‍🍳", name: "Chef Renard", cry: "You'll be minced!", maxHp: 6, str: 2, def: 1, agi: 2, luk: 1 },
  { emoji: "💂", name: "Sentry Cole", cry: "None shall pass!", maxHp: 11, str: 3, def: 2, agi: 2, luk: 1 },
  { emoji: "🕵️", name: "Insp. Mora", cry: "The trail ends here.", maxHp: 15, str: 4, def: 3, agi: 4, luk: 2 },
  { emoji: "🥷", name: "Kaze", cry: "Blink and you're gone.", maxHp: 19, str: 6, def: 3, agi: 7, luk: 4 },
  { emoji: "🧙", name: "Magus Orin", cry: "Feel the arcane!", maxHp: 26, str: 8, def: 5, agi: 5, luk: 5 },
  { emoji: "👑", name: "King Aldwin", cry: "Kneel before me!", maxHp: 34, str: 10, def: 7, agi: 6, luk: 4 },
  { emoji: "🦹", name: "Dread Volk", cry: "Your story ends.", maxHp: 48, str: 14, def: 9, agi: 9, luk: 8 },
];

const EXTRA_EMOJI = ["🧟", "👹", "🤺", "🧛", "🦸", "👺", "🧝", "🐉"];
const EXTRA_NAME = ["Wanderer", "Brute", "Reaver", "Warden", "Fiend", "Marauder", "Specter", "Wyrm"];
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

function makeFoe(index: number): Foe {
  if (index < ROSTER.length) return ROSTER[index];
  const t = index - ROSTER.length;
  const i = t % EXTRA_EMOJI.length;
  return {
    emoji: EXTRA_EMOJI[i],
    name: EXTRA_NAME[i],
    cry: EXTRA_CRY[i],
    maxHp: 52 + t * 9,
    str: 15 + t * 2,
    def: 9 + t,
    agi: 9 + t,
    luk: 6 + Math.floor(t / 2),
  };
}

const luckPct = (luk: number) => Math.min(10, Math.max(0, luk));
const pointsForLevel = (level: number) => 2 + Math.floor(level / 3);
const statValue = (s: Stats, k: StatKey) => (k === "hp" ? s.maxHp : s[k]);

function strike(att: Stats, def: Stats): { dmg: number; crit: boolean; dodged: boolean } {
  if (Math.random() * 100 < luckPct(def.luk)) return { dmg: 0, crit: false, dodged: true };
  const crit = Math.random() * 100 < luckPct(att.luk);
  let dmg = crit ? att.str : Math.max(1, att.str - def.def);
  if (att.agi > def.agi) dmg *= 2;
  return { dmg, crit, dodged: false };
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Rock Paper Scissors — toto-victoto" },
    {
      name: "description",
      content:
        "An RPG on rock-paper-scissors: level up your stats and battle a cast of foes.",
    },
  ];
}

type Phase = "intro" | "choose" | "count" | "clash" | "strike" | "levelup" | "gameover";
type Round = {
  player: Move;
  foe: Move;
  outcome: Outcome;
  attacker: "you" | "foe" | null;
  dmg: number;
  crit: boolean;
  dodged: boolean;
  faster: boolean;
  resultFoeHp: number;
  resultHp: number;
};

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
  const [points, setPoints] = useState(0);
  const [alloc, setAlloc] = useState<Record<StatKey, number>>({
    hp: 0,
    str: 0,
    def: 0,
    agi: 0,
    luk: 0,
  });
  const [, setStored] = useStoredGame("rps", { bestLevel: 0 });

  // The battle cry shows itself, then hands over to the choice.
  useEffect(() => {
    if (phase !== "intro") return;
    sfx.ui();
    const t = setTimeout(() => setPhase("choose"), 1600);
    return () => clearTimeout(t);
  }, [phase]);

  // Rock… paper… scissors… — the 3-2-1 that adds the tension.
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

  // Show who won the toss for a beat before the blow lands.
  useEffect(() => {
    if (phase !== "clash") return;
    const t = setTimeout(() => setPhase("strike"), 500);
    return () => clearTimeout(t);
  }, [phase]);

  // The blow: apply HP (bars animate), then resolve KO / level-up / next.
  useEffect(() => {
    if (phase !== "strike" || !round) return;
    const r = round;
    setFoeHp(r.resultFoeHp);
    setHp(r.resultHp);
    if (r.outcome !== "draw" && !r.dodged && r.crit) sfx.win();
    else if (r.outcome === "win" && !r.dodged) sfx.score();
    else sfx.ui();
    const t = setTimeout(
      () => {
        if (r.resultFoeHp <= 0) {
          const nl = level + 1;
          setLevel(nl);
          setPoints(pointsForLevel(nl));
          setAlloc({ hp: 0, str: 0, def: 0, agi: 0, luk: 0 });
          setStored((s) => ({ bestLevel: Math.max(s.bestLevel, nl) }));
          setPhase("levelup");
          sfx.win();
        } else if (r.resultHp <= 0) {
          setPhase("gameover");
          sfx.lose();
        } else {
          setPhase("choose");
        }
      },
      r.outcome === "draw" ? 650 : 1150,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const pick = (move: Move) => {
    if (phase !== "choose") return;
    const foeMove = randomMove();
    const outcome = judge(move, foeMove);
    let attacker: "you" | "foe" | null = null;
    let dmg = 0;
    let crit = false;
    let dodged = false;
    let faster = false;
    let resultFoeHp = foeHp;
    let resultHp = hp;
    if (outcome === "win") {
      attacker = "you";
      const s = strike(player, foe);
      crit = s.crit;
      dodged = s.dodged;
      dmg = s.dmg;
      faster = player.agi > foe.agi;
      if (!dodged) resultFoeHp = Math.max(0, foeHp - dmg);
    } else if (outcome === "lose") {
      attacker = "foe";
      const s = strike(foe, player);
      crit = s.crit;
      dodged = s.dodged;
      dmg = s.dmg;
      faster = foe.agi > player.agi;
      if (!dodged) resultHp = Math.max(0, hp - dmg);
    }
    setRound({ player: move, foe: foeMove, outcome, attacker, dmg, crit, dodged, faster, resultFoeHp, resultHp });
    setCount(3);
    setPhase("count");
  };

  const spent = STAT_KEYS.reduce((n, k) => n + alloc[k], 0);
  const remaining = points - spent;
  const addPoint = (k: StatKey) => {
    if (remaining <= 0) return;
    setAlloc((a) => ({ ...a, [k]: a[k] + 1 }));
  };

  const confirmLevelUp = () => {
    const np: Stats = {
      maxHp: player.maxHp + alloc.hp * STAT_GAIN.hp,
      str: player.str + alloc.str,
      def: player.def + alloc.def,
      agi: player.agi + alloc.agi,
      luk: player.luk + alloc.luk,
    };
    setPlayer(np);
    setHp(np.maxHp);
    const next = foeIndex + 1;
    setFoeIndex(next);
    const nf = makeFoe(next);
    setFoe(nf);
    setFoeHp(nf.maxHp);
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
    setPhase("intro");
  };

  const striking = phase === "strike" && round;
  const foeAnim =
    striking && round.outcome === "win"
      ? round.dodged
        ? "rps-dodge 440ms ease-out"
        : `rps-hit-${round.player} ${round.faster ? "340ms ease-out 2" : "440ms ease-out"}`
      : undefined;
  const playerAnim =
    striking && round.outcome === "lose" && !round.dodged
      ? "rps-shake 440ms ease-out"
      : undefined;

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans id="rps.title" message="Rock Paper Scissors" />
          </h1>
          <span className="text-sm font-bold tabular-nums text-amber-300">Lv {level}</span>
        </header>

        {/* Foe */}
        <section className="relative space-y-1 text-center">
          <div
            className="text-6xl leading-none"
            style={foeAnim ? { animation: foeAnim } : undefined}
            aria-hidden="true"
          >
            {foe.emoji}
          </div>
          {striking && round.outcome === "win" && !round.dodged && (
            <div
              className="pointer-events-none absolute inset-x-0 top-1 text-center text-2xl font-black"
              style={{ animation: "rps-float 900ms ease-out forwards" }}
              aria-hidden="true"
            >
              {MARKER[round.player]}
              <span className="ml-1 text-rose-300">-{round.dmg}</span>
            </div>
          )}
          <div className="font-semibold text-neutral-200">{foe.name}</div>
          <HpBar hp={foeHp} max={foe.maxHp} className="bg-rose-500" />
          <StatLine stats={foe} />
        </section>

        {/* Middle — phase content */}
        <section className="flex min-h-0 flex-1 items-center justify-center">
          {phase === "intro" && (
            <p className="mx-auto max-w-xs rounded-2xl bg-neutral-800 px-4 py-2 text-sm italic text-neutral-300 motion-safe:animate-rps-tick">
              “{foe.cry}”
            </p>
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
          className="relative space-y-1"
          style={playerAnim ? { animation: playerAnim } : undefined}
        >
          {striking && round.outcome === "lose" && !round.dodged && (
            <div
              className="pointer-events-none absolute inset-x-0 -top-6 text-center text-lg font-black text-rose-300"
              style={{ animation: "rps-float 900ms ease-out forwards" }}
              aria-hidden="true"
            >
              -{round.dmg}
            </div>
          )}
          <HpBar hp={hp} max={player.maxHp} className="bg-emerald-500" />
          <StatLine stats={player} highlight />
        </section>

        <section className="grid grid-cols-3 gap-4">
          {MOVES.map((m) => (
            <button
              key={m.id}
              onClick={() => pick(m.id)}
              disabled={phase !== "choose"}
              aria-label={m.id}
              className="flex aspect-square items-center justify-center rounded-2xl bg-neutral-800 text-5xl transition hover:bg-neutral-700 active:scale-95 disabled:opacity-40 disabled:hover:bg-neutral-800 disabled:active:scale-100"
            >
              <span aria-hidden="true">{m.emoji}</span>
            </button>
          ))}
        </section>
      </GameLayout>
    </>
  );
}

// The combat call-outs — AGI advantage, crit, and dodge all get a pop.
function StrikeBanner({ round, foe }: { round: Round; foe: Foe }) {
  if (round.outcome === "draw") {
    return <p className="text-lg font-medium text-neutral-400">Stand-off</p>;
  }
  if (round.dodged) {
    const you = round.attacker === "foe"; // foe attacked, you dodged
    return (
      <p
        className={`text-lg font-bold motion-safe:animate-rps-tick ${
          you ? "text-sky-300" : "text-neutral-400"
        }`}
      >
        {you ? "You dodge!" : `${foe.name} dodges!`}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {round.faster && (
        <p className="text-lg font-bold text-amber-300 motion-safe:animate-rps-tick">
          {round.attacker === "you" ? "You're faster!" : `${foe.name} is faster!`}{" "}
          <span className="text-amber-200">×2</span>
        </p>
      )}
      {round.crit && (
        <p className="text-lg font-bold text-fuchsia-300 motion-safe:animate-rps-tick">
          Critical!
        </p>
      )}
      {!round.faster && !round.crit && (
        <p
          className={`text-lg font-medium ${
            round.attacker === "you" ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {round.attacker === "you" ? "Hit!" : "You're hit!"}
        </p>
      )}
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
