import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/roulette";
import { BackButton } from "../components/BackButton";

const START_BALANCE = 100;
const STAKES = [1, 5, 10, 25];

// European single-zero wheel. Reds don't follow a formula, so they're the one
// thing we keep as a lookup; color/parity/range of any number derive from it.
const RED = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

type Color = "red" | "black" | "green";

function colorOf(n: number): Color {
  if (n === 0) return "green";
  return RED.has(n) ? "red" : "black";
}

function colorClass(c: Color): string {
  return c === "red"
    ? "bg-red-600"
    : c === "black"
      ? "bg-neutral-800"
      : "bg-green-600";
}

function textClass(c: Color): string {
  return c === "red"
    ? "text-red-500"
    : c === "green"
      ? "text-emerald-400"
      : "text-neutral-100";
}

// Pure resolution of a single bet against the winning number.
function wins(key: string, r: number): boolean {
  if (key.startsWith("n:")) return Number(key.slice(2)) === r;
  if (r === 0) return false; // outside bets all lose on the zero
  switch (key) {
    case "red":
      return colorOf(r) === "red";
    case "black":
      return colorOf(r) === "black";
    case "even":
      return r % 2 === 0;
    case "odd":
      return r % 2 === 1;
    case "low":
      return r <= 18;
    case "high":
      return r >= 19;
    default:
      return false;
  }
}

// Profit per unit staked: straight up pays 35:1, even-money bets 1:1.
function payoutOf(key: string): number {
  return key.startsWith("n:") ? 35 : 1;
}

const NUMBERS = Array.from({ length: 36 }, (_, i) => i + 1);

// Physical pocket order on a European wheel (not sequential). Used to map a
// result number to its angular position so the wheel lands under the pointer.
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const STEP = 360 / 37; // degrees per pocket
const HEX: Record<Color, string> = {
  red: "#dc2626",
  black: "#1f1f1f",
  green: "#16a34a",
};
const WHEEL_BG = `conic-gradient(from ${-STEP / 2}deg, ${WHEEL_ORDER.map(
  (n, i) => `${HEX[colorOf(n)]} ${i * STEP}deg ${(i + 1) * STEP}deg`,
).join(", ")})`;
const SPIN_TURNS = 5;
const SPIN_MS = 4000;
const SPIN_EASING = "cubic-bezier(0.16, 0.84, 0.3, 1)";
const BETTING_SECONDS = 10; // betting window before the wheel auto-spins

const OUTSIDE: { key: string; id?: string; label: string; tone: string }[] = [
  { key: "red", id: "roulette.red", label: "Red", tone: "bg-red-600" },
  { key: "black", id: "roulette.black", label: "Black", tone: "bg-neutral-800" },
  { key: "even", id: "roulette.even", label: "Even", tone: "bg-neutral-700" },
  { key: "odd", id: "roulette.odd", label: "Odd", tone: "bg-neutral-700" },
  { key: "low", label: "1–18", tone: "bg-neutral-700" },
  { key: "high", label: "19–36", tone: "bg-neutral-700" },
];

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Roulette — toto-victoto" },
    { name: "description", content: "A European roulette mini-game." },
  ];
}

export default function Roulette() {
  const [balance, setBalance] = useState(START_BALANCE);
  const [displayBalance, setDisplayBalance] = useState(START_BALANCE);
  const [best, setBest] = useState(START_BALANCE);
  const [bets, setBets] = useState<Record<string, number>>({});
  const [stake, setStake] = useState(STAKES[1]);
  const [result, setResult] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [countdown, setCountdown] = useState(BETTING_SECONDS);
  const [liveNum, setLiveNum] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]); // most recent first
  const [statsOpen, setStatsOpen] = useState(false);
  const rotationRef = useRef(0);
  const wheelRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<Animation | null>(null);
  const spinRangeRef = useRef({ from: 0, to: 0 });
  const displayRef = useRef(START_BALANCE);
  const scoreRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLDivElement>(null);
  const wageredRef = useRef<HTMLSpanElement>(null);
  displayRef.current = displayBalance;

  const wagered = Object.values(bets).reduce((sum, n) => sum + n, 0);
  const gameOver = balance === 0 && wagered === 0;

  const replay = () => {
    setBalance(START_BALANCE);
    setBets({});
    setResult(null);
    setHistory([]);
  };

  const recent = history.slice(0, 3);
  const stats = computeStats(history);

  const spin = () => {
    if (spinning) return;
    const el = wheelRef.current;
    if (!el) return;
    const r = Math.floor(Math.random() * 37);
    const idx = WHEEL_ORDER.indexOf(r);
    // Rotate so pocket idx (at idx*STEP from the top) ends up under the pointer.
    const desired = (360 - idx * STEP) % 360;
    const from = rotationRef.current;
    const currentMod = ((from % 360) + 360) % 360;
    const delta = (desired - currentMod + 360) % 360;
    const to = from + SPIN_TURNS * 360 + delta;
    rotationRef.current = to;
    spinRangeRef.current = { from, to };

    // Drive the spin with the Web Animations API instead of a CSS transition.
    animRef.current?.cancel();
    const anim = el.animate(
      [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }],
      { duration: SPIN_MS, easing: SPIN_EASING, fill: "forwards" },
    );
    animRef.current = anim;
    anim.onfinish = () => {
      setRotation(to); // commit resting angle (matches the held end frame)
      resolveSpin(r); // pass r — onfinish's closure predates setResult(r)
    };

    setResult(r);
    setSpinning(true);
  };

  // Fling coin particles from the board's centre toward the score readout.
  const flyCoins = () => {
    const fx = fxRef.current;
    const board = boardRef.current;
    const score = scoreRef.current;
    if (!fx || !board || !score) return;
    const b = board.getBoundingClientRect();
    const s = score.getBoundingClientRect();
    const ox = b.left + b.width / 2;
    const oy = b.top + b.height / 2;
    const tx = s.left + s.width / 2;
    const ty = s.top + s.height / 2;
    for (let i = 0; i < 12; i++) {
      const coin = document.createElement("div");
      coin.style.cssText =
        "position:fixed;left:0;top:0;width:14px;height:14px;border-radius:9999px;background:#fbbf24;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;will-change:transform,opacity";
      fx.appendChild(coin);
      const jx = (Math.random() - 0.5) * 70;
      const jy = (Math.random() - 0.5) * 70;
      const anim = coin.animate(
        [
          { transform: `translate(${ox + jx}px, ${oy + jy}px) scale(1)`, opacity: 1 },
          { transform: `translate(${tx}px, ${ty}px) scale(0.4)`, opacity: 0.3 },
        ],
        {
          duration: 650,
          delay: i * 45,
          easing: "cubic-bezier(0.5, 0, 0.2, 1)",
          fill: "forwards",
        },
      );
      anim.onfinish = () => coin.remove();
    }
  };

  // Lost chips: spill out of the stake readout, scatter downward, and vanish.
  const loseCoins = (count: number) => {
    const fx = fxRef.current;
    const origin = wageredRef.current ?? boardRef.current;
    if (!fx || !origin) return;
    const o = origin.getBoundingClientRect();
    const ox = o.left + o.width / 2;
    const oy = o.top + o.height / 2;
    for (let i = 0; i < count; i++) {
      const coin = document.createElement("div");
      coin.style.cssText =
        "position:fixed;left:0;top:0;width:12px;height:12px;border-radius:9999px;background:#fbbf24;box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;will-change:transform,opacity";
      fx.appendChild(coin);
      const dx = (Math.random() - 0.5) * 130;
      const dy = 50 + Math.random() * 90; // fall away
      const anim = coin.animate(
        [
          { transform: `translate(${ox}px, ${oy}px) scale(1)`, opacity: 0.9 },
          {
            transform: `translate(${ox + dx}px, ${oy + dy}px) scale(0.3)`,
            opacity: 0,
          },
        ],
        {
          duration: 600,
          delay: i * 35,
          easing: "cubic-bezier(0.4, 0, 1, 1)",
          fill: "forwards",
        },
      );
      anim.onfinish = () => coin.remove();
    }
  };

  // Pay the winning bets once the wheel settles.
  const resolveSpin = (r: number) => {
    setSpinning(false);
    let returned = 0;
    let wonStake = 0;
    for (const [key, amount] of Object.entries(bets)) {
      if (wins(key, r)) {
        returned += amount * (payoutOf(key) + 1);
        wonStake += amount;
      }
    }
    if (returned > 0) {
      setBalance((b) => b + returned); // count-up + best are handled by effects
      flyCoins();
    }
    const lostStake = wagered - wonStake;
    if (lostStake > 0) {
      loseCoins(Math.min(12, Math.max(5, Math.round(lostStake / 5))));
    }
    setHistory((h) => [r, ...h]);
    setBets({});
    setCountdown(BETTING_SECONDS);
  };

  const placeBet = (key: string) => {
    if (spinning) return;
    if (stake > balance) return;
    setBalance((b) => b - stake);
    setBets((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + stake }));
  };

  const clearBets = () => {
    setBalance((b) => b + wagered);
    setBets({});
  };

  // Pull a single bet back off the board (tap its chip, or long-press the cell).
  const removeBet = (key: string) => {
    if (spinning) return;
    const amount = bets[key];
    if (!amount) return;
    setBalance((b) => b + amount);
    setBets((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // The table runs itself: the betting window counts down once per second and
  // auto-spins at zero. resolveSpin resets the counter to restart the cycle.
  // Frozen once the player is out of chips (nothing left to bet or resolve).
  useEffect(() => {
    if (spinning || gameOver || statsOpen) return;
    if (countdown <= 0) {
      spin();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [spinning, countdown, gameOver, statsOpen]);

  // While the wheel turns, sample the animation's eased progress (cheap — no
  // style flush) and map it to the number currently under the pointer.
  useEffect(() => {
    if (!spinning) {
      setLiveNum(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const anim = animRef.current;
      if (anim?.effect) {
        const progress = anim.effect.getComputedTiming().progress ?? 1;
        const { from, to } = spinRangeRef.current;
        const angle = from + progress * (to - from);
        const norm = ((-angle % 360) + 360) % 360;
        setLiveNum(WHEEL_ORDER[Math.round(norm / STEP) % 37]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spinning]);

  // Displayed score snaps down instantly (bets) but counts up over time (wins).
  useEffect(() => {
    const from = displayRef.current;
    if (balance <= from) {
      setDisplayBalance(balance);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / 900, 1);
      const eased = 1 - (1 - t) * (1 - t);
      setDisplayBalance(Math.round(from + (balance - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [balance]);

  useEffect(() => {
    setBest((b) => Math.max(b, balance));
  }, [balance]);

  return (
    <>
      <BackButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-sm mx-auto space-y-4">
          <header className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              <Trans id="roulette.title" message="Roulette" />
            </h1>
          </header>

          <section className="flex items-center justify-center gap-6 text-center">
            <button
              type="button"
              onClick={() => history.length > 0 && setStatsOpen(true)}
              disabled={history.length === 0}
              aria-label="Show statistics"
              className="flex w-8 flex-col items-center gap-1 transition active:scale-95 disabled:opacity-30"
            >
              {recent.length > 0 ? (
                recent.map((n, i) => (
                  <span
                    key={`${n}-${i}`}
                    className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold tabular-nums text-white ring-1 ring-black/30 ${colorClass(
                      colorOf(n),
                    )}`}
                  >
                    {n}
                  </span>
                ))
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-full text-xs font-bold text-neutral-600 ring-1 ring-neutral-800">
                  ?
                </span>
              )}
            </button>
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-500">
                <Trans id="roulette.balance" message="Balance" />
              </div>
              <div ref={scoreRef} className="text-3xl font-bold tabular-nums">
                {displayBalance}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-500">
                <Trans id="common.best" message="Best" />
              </div>
              <div className="text-3xl font-bold tabular-nums text-amber-400">
                {best}
              </div>
            </div>
          </section>

          <section className="flex min-h-16 flex-col items-center justify-center text-center">
            {spinning ? (
              <p className="text-2xl font-bold text-amber-200 motion-safe:animate-fade-in">
                <Trans id="roulette.no_more_bets" message="No more bets" />
              </p>
            ) : gameOver ? null : (
              <div className="flex items-center justify-center gap-3">
                <p className="text-2xl font-bold text-amber-200">
                  <Trans id="roulette.place_bets" message="Place your bets" />
                </p>
                <div
                  aria-hidden="true"
                  className="h-2 w-16 overflow-hidden rounded-full bg-neutral-800"
                >
                  <div
                    className="h-full rounded-full bg-red-500 transition-[width] duration-1000 ease-linear"
                    style={{ width: `${(countdown / BETTING_SECONDS) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </section>

          <section ref={boardRef} className="relative">
            <div
              className={`space-y-1 transition ${spinning ? "pointer-events-none opacity-40" : ""}`}
            >
              <div className="grid grid-cols-6 gap-1">
                <BetCell
                  onPlace={() => placeBet("n:0")}
                  onRemove={() => removeBet("n:0")}
                  amount={bets["n:0"]}
                  className={`col-span-6 py-2 ${colorClass("green")}`}
                >
                  0
                </BetCell>
                {NUMBERS.map((n) => (
                  <BetCell
                    key={n}
                    onPlace={() => placeBet(`n:${n}`)}
                    onRemove={() => removeBet(`n:${n}`)}
                    amount={bets[`n:${n}`]}
                    className={`aspect-square ${colorClass(colorOf(n))}`}
                  >
                    {n}
                  </BetCell>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-1 text-xs font-medium">
                {OUTSIDE.map((o) => (
                  <BetCell
                    key={o.key}
                    onPlace={() => placeBet(o.key)}
                    onRemove={() => removeBet(o.key)}
                    amount={bets[o.key]}
                    className={`py-2 ${o.tone}`}
                  >
                    {o.id ? <Trans id={o.id} message={o.label} /> : o.label}
                  </BetCell>
                ))}
              </div>
            </div>

            {/* Wheel overlay — kept mounted at all times so the CSS rotation
                can animate; only made visible while the wheel is spinning. */}
            <div
              className={`pointer-events-none absolute inset-0 z-10 grid place-items-center transition-opacity duration-300 ${
                spinning ? "opacity-100" : "opacity-0"
              }`}
            >
              <div className="absolute inset-0 bg-neutral-950/80" />
              <div className="relative aspect-square w-[92%] max-w-sm">
                <div className="absolute left-1/2 top-0 z-20 h-0 w-0 -translate-x-1/2 border-x-8 border-t-[14px] border-x-transparent border-t-amber-300" />
                <div
                  ref={wheelRef}
                  className="absolute inset-0 overflow-hidden rounded-full ring-4 ring-neutral-700"
                  style={{
                    background: WHEEL_BG,
                    transform: `rotate(${rotation}deg)`,
                  }}
                >
                  {WHEEL_ORDER.map((n, i) => (
                    <div
                      key={n}
                      className="absolute inset-0 flex items-start justify-center"
                      style={{ transform: `rotate(${i * STEP}deg)` }}
                    >
                      <span className="pt-1 text-[11px] font-bold leading-none text-white [text-shadow:0_1px_1px_rgb(0_0_0/0.6)]">
                        {n}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="absolute left-1/2 top-1/2 z-10 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-neutral-950 text-2xl font-bold tabular-nums ring-2 ring-neutral-700">
                  {liveNum !== null ? (
                    <span className={textClass(colorOf(liveNum))}>{liveNum}</span>
                  ) : result !== null ? (
                    <span className={textClass(colorOf(result))}>{result}</span>
                  ) : (
                    <span className="text-neutral-600">?</span>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            {!gameOver && (
              <>
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-neutral-500">
                      <Trans id="roulette.chip" message="Chip" />
                    </span>
                    {STAKES.map((s) => (
                      <button
                        key={s}
                        onClick={() => setStake(s)}
                        disabled={spinning}
                        className={`h-9 w-9 rounded-full text-sm font-bold tabular-nums ring-2 transition disabled:opacity-50 ${
                          stake === s
                            ? "bg-amber-400 text-neutral-900 ring-amber-200"
                            : "bg-neutral-800 text-neutral-200 ring-transparent hover:bg-neutral-700"
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={clearBets}
                    disabled={wagered === 0 || spinning}
                    className="rounded-full bg-neutral-800 px-3 py-1.5 text-sm font-medium text-neutral-200 transition hover:bg-neutral-700 active:scale-95 disabled:opacity-40 disabled:hover:bg-neutral-800 disabled:active:scale-100"
                  >
                    <Trans id="roulette.clear" message="Clear bets" />
                  </button>
                </div>
                <div className="text-center text-sm text-neutral-400">
                  <Trans id="roulette.wagered" message="In play" />{" "}
                  <span
                    ref={wageredRef}
                    className="font-bold tabular-nums text-amber-400"
                  >
                    {wagered}
                  </span>
                </div>
              </>
            )}

            {gameOver && (
              <div className="space-y-2 text-center">
                <p className="font-semibold text-rose-300">
                  <Trans id="roulette.broke" message="Out of chips" />
                </p>
                <button
                  onClick={replay}
                  className="w-full rounded-full bg-emerald-500 py-3 font-semibold text-neutral-950 transition hover:bg-emerald-400 active:scale-[0.99]"
                >
                  <Trans id="common.play_again" message="Play again" />
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
      {statsOpen && (
        <StatsOverlay
          history={history}
          stats={stats}
          onClose={() => setStatsOpen(false)}
        />
      )}
      <div
        ref={fxRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50"
      />
    </>
  );
}

type Stats = {
  spins: number;
  redPct: number;
  blackPct: number;
  evenPct: number;
  oddPct: number;
  hot: { n: number; count: number }[];
  cold: { n: number; count: number }[];
};

// Derive the classic display stats from the spin history. Red/black are over
// all spins (so the zero dilutes both); even/odd are over non-zero spins only
// since the zero is neither. Hot/cold rank every pocket by how often it landed.
function computeStats(history: number[]): Stats {
  const spins = history.length;
  const counts = new Array(37).fill(0) as number[];
  let red = 0;
  let even = 0;
  let zero = 0;
  for (const n of history) {
    counts[n]++;
    if (n === 0) zero++;
    else {
      if (colorOf(n) === "red") red++;
      if (n % 2 === 0) even++;
    }
  }
  const black = spins - zero - red;
  const nonZero = spins - zero;
  const odd = nonZero - even;
  const pct = (part: number, whole: number) =>
    whole === 0 ? 0 : Math.round((part / whole) * 100);
  const ranked = counts.map((count, n) => ({ n, count }));
  const hot = [...ranked]
    .sort((a, b) => b.count - a.count || a.n - b.n)
    .slice(0, 3);
  const cold = [...ranked]
    .sort((a, b) => a.count - b.count || a.n - b.n)
    .slice(0, 3);
  return {
    spins,
    redPct: pct(red, spins),
    blackPct: pct(black, spins),
    evenPct: pct(even, nonZero),
    oddPct: pct(odd, nonZero),
    hot,
    cold,
  };
}

function StatChip({ n }: { n: number }) {
  return (
    <span
      className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold tabular-nums text-white ring-1 ring-black/30 ${colorClass(
        colorOf(n),
      )}`}
    >
      {n}
    </span>
  );
}

function PctBar({
  leftPct,
  leftLabel,
  rightLabel,
  leftTone,
  rightTone,
}: {
  leftPct: number;
  leftLabel: React.ReactNode;
  rightLabel: React.ReactNode;
  leftTone: string;
  rightTone: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs font-medium text-neutral-300">
        <span>
          {leftLabel} <span className="tabular-nums">{leftPct}%</span>
        </span>
        <span>
          <span className="tabular-nums">{100 - leftPct}%</span> {rightLabel}
        </span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-neutral-800">
        <div className={leftTone} style={{ width: `${leftPct}%` }} />
        <div className={`flex-1 ${rightTone}`} />
      </div>
    </div>
  );
}

function StatsOverlay({
  history,
  stats,
  onClose,
}: {
  history: number[];
  stats: Stats;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 motion-safe:animate-fade-in">
      <div className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-2xl bg-neutral-900 p-5 ring-1 ring-neutral-700">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            <Trans id="roulette.stats_title" message="Statistics" />
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full bg-neutral-800 text-lg leading-none text-neutral-300 transition hover:bg-neutral-700 active:scale-95"
          >
            ×
          </button>
        </div>

        <div className="mb-4 text-center text-sm text-neutral-400">
          <Trans id="roulette.spins" message="Spins" />{" "}
          <span className="font-bold tabular-nums text-neutral-100">
            {stats.spins}
          </span>
        </div>

        <div className="space-y-3">
          <PctBar
            leftPct={stats.redPct}
            leftLabel={<Trans id="roulette.red" message="Red" />}
            rightLabel={<Trans id="roulette.black" message="Black" />}
            leftTone="bg-red-600"
            rightTone="bg-neutral-700"
          />
          <PctBar
            leftPct={stats.evenPct}
            leftLabel={<Trans id="roulette.even" message="Even" />}
            rightLabel={<Trans id="roulette.odd" message="Odd" />}
            leftTone="bg-sky-600"
            rightTone="bg-amber-600"
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-neutral-800/60 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-400">
              <Trans id="roulette.hot" message="Hot" />
            </div>
            <div className="flex gap-1.5">
              {stats.hot.map(({ n }) => (
                <StatChip key={n} n={n} />
              ))}
            </div>
          </div>
          <div className="rounded-xl bg-neutral-800/60 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-400">
              <Trans id="roulette.cold" message="Cold" />
            </div>
            <div className="flex gap-1.5">
              {stats.cold.map(({ n }) => (
                <StatChip key={n} n={n} />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {history.map((n, i) => (
            <StatChip key={`${n}-${i}`} n={n} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BetCell({
  onPlace,
  onRemove,
  amount,
  className,
  children,
}: {
  onPlace: () => void;
  onRemove: () => void;
  amount?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const timer = useRef<number | null>(null);
  const longFired = useRef(false);

  const startPress = () => {
    longFired.current = false;
    timer.current = window.setTimeout(() => {
      longFired.current = true;
      onRemove();
    }, 450);
  };
  const cancelPress = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const handleClick = () => {
    if (longFired.current) {
      longFired.current = false; // long-press already removed the bet
      return;
    }
    onPlace();
  };

  return (
    <button
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onClick={handleClick}
      className={`relative grid select-none place-items-center rounded-md font-semibold transition active:scale-95 ${className ?? ""}`}
    >
      {children}
      {amount ? (
        <span
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute left-0.5 top-0.5 grid h-4 min-w-4 cursor-pointer place-items-center rounded-full bg-amber-400 px-1 text-[10px] font-bold tabular-nums text-neutral-900 ring-1 ring-neutral-950"
        >
          {amount}
        </span>
      ) : null}
    </button>
  );
}
