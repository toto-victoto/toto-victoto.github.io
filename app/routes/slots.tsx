import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/slots";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";
import { sfx, tone, startSlotSpin, stopSlotSpin } from "../sound";

// Faithful to the SMB3 "Spade Panel": each prize (🍄 / 🌸 / ⭐) is sliced into
// three horizontal bands. Reel 0 carries the top bands, reel 1 the middle, reel
// 2 the bottom. Stop all three so one column shows the SAME prize top-to-bottom
// and its bands reassemble into a whole picture — that wins the lives.
//
// A reel is ONE number — its `offset`, how many cells its band-strip has
// rolled. Everything drawn is DERIVED from that offset by arithmetic; the `% N`
// (modulo) wraps the tiny 3-symbol strip into an endless ribbon.
const SYMBOLS = ["🍄", "🌸", "⭐"] as const;
const N = SYMBOLS.length;
const REELS = 3;

// Spade Panel payout, indexed like SYMBOLS: three 🍄 award 2 lives, three 🌸
// award 3, three ⭐ award 5. Any mismatch pays nothing.
const PAYOUTS = [2, 3, 5];

// Geometry, in px. One band is BAND tall; a whole icon spans all three
// (ICON = 3 × BAND). GLYPH is the emoji size — kept under one cell's width so a
// prize never clips sideways and the matched column reassembles seamlessly.
const BAND = 34;
const ICON = BAND * REELS;
const GLYPH = 80;
const CELL = 24; // % of the reel's width taken by one cell
const HALF_WINDOW = 3; // cells drawn on each side of center

// One speed for every reel, like the original. The middle reel scrolls RIGHT
// while the outer two scroll left. +1 = left (offset grows), −1 = right.
const SPIN_SPEED = 7; // cells per second
const DIRECTIONS = [1, -1, 1];
const MAX_DT = 0.05; // clamp so a backgrounded tab can't teleport the reels

// The stop is weighted, not instant — the original reels coast to a halt and
// resist a pinpoint stop. On a tap the reel picks a whole-cell target a short,
// slightly random distance ahead, then eases in. Timing mostly wins; the slip
// keeps it from being a metronome.
const STOP_APPROACH = 9; // higher = snappier ease-in
const STOP_EXTRA_MIN = 1; // cells of coast after the tap
const STOP_EXTRA_RAND = 1; // plus up to this many, random
const SNAP_EPS = 0.02; // land when this close to the target cell

// Reels start phase-shifted so the payline reads 🍄 / 🌸 / ⭐ — three prizes
// mid-reassembly, the game's signature look. Deterministic, so the prerendered
// HTML and the first client render agree (no hydration mismatch).
const START_OFFSETS = [0, 1, 2];

type Phase = "idle" | "spinning" | "result";
type ReelPhase = "spinning" | "stopping" | "stopped";
type Result = { symbol: string; prize: number };

// Fold an offset back into [0, N). The strip has period N, so this is invisible
// on screen but keeps the number tiny forever (perfect float precision).
const wrap = (offset: number): number => ((offset % N) + N) % N;

// The prize index parked on the payline for a given offset — pure arithmetic.
export function centered(offset: number): number {
  return ((Math.round(offset) % N) + N) % N;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "1-UP Slots — toto-victoto" },
    { name: "description", content: "An SMB3-style prize slot machine." },
  ];
}

export default function Slots() {
  // One offset per reel. The screen must redraw as they roll → useState.
  const [offsets, setOffsets] = useState<number[]>(START_OFFSETS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stopped, setStopped] = useState(0); // reels the player has tapped (0–3)
  const [result, setResult] = useState<Result | null>(null);
  const [lives, setLives] = useState(0);
  const [{ best }, setBest] = useStoredGame("slots", { best: 0 });

  // The rAF loop runs once (empty deps) and reads live values from refs, not
  // captured state (the Flappy pattern). All the reel motion is computed in the
  // callback and handed to setOffsets as a finished array, so the updater stays
  // pure.
  const offsetsRef = useRef<number[]>(START_OFFSETS);
  const phaseRef = useRef<Phase>("idle");
  const reelPhaseRef = useRef<ReelPhase[]>(["stopped", "stopped", "stopped"]);
  const stopTargetRef = useRef<number[]>([0, 0, 0]);
  const tappedRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Pull the lever: every reel rolls again from where it rests.
  const pull = () => {
    setResult(null);
    reelPhaseRef.current = ["spinning", "spinning", "spinning"];
    tappedRef.current = 0;
    setStopped(0);
    phaseRef.current = "spinning";
    setPhase("spinning");
    sfx.spin();
    startSlotSpin();
  };

  // Stop the next reel: aim it at a whole cell a short, weighted distance ahead.
  const stop = () => {
    if (phaseRef.current !== "spinning") return;
    const i = tappedRef.current;
    if (i >= REELS) return;
    const from = offsetsRef.current[i];
    const extra = STOP_EXTRA_MIN + Math.random() * STOP_EXTRA_RAND;
    stopTargetRef.current[i] = Math.round(from + DIRECTIONS[i] * extra);
    reelPhaseRef.current[i] = "stopping";
    tappedRef.current = i + 1;
    setStopped(i + 1);
    sfx.place();
  };

  // Score the payline once all three reels rest.
  const score = () => {
    phaseRef.current = "result";
    stopSlotSpin();
    const symbols = offsetsRef.current.map(centered);
    const win = symbols[0] === symbols[1] && symbols[1] === symbols[2];
    const prize = win ? PAYOUTS[symbols[0]] : 0;
    setResult({ symbol: SYMBOLS[symbols[0]], prize });
    if (prize > 0) {
      setLives((l) => l + prize);
      sfx.win();
    } else {
      tone(330, 0.12, { type: "triangle" });
      tone(247, 0.16, { type: "triangle", delay: 0.1 });
    }
    setPhase("result");
  };

  const primary = phase === "spinning" ? stop : pull;

  // The reel loop. Each frame: advance spinning reels, ease stopping ones toward
  // their target cell, hold stopped ones. When the third rests, score.
  useEffect(() => {
    const stepFrame = (t: number) => {
      if (lastTimeRef.current !== null) {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);
        const cur = offsetsRef.current;
        const next = cur.map((o, i) => {
          const rp = reelPhaseRef.current[i];
          if (rp === "stopped") return o;
          if (rp === "stopping") {
            const target = stopTargetRef.current[i];
            const eased =
              o + (target - o) * (1 - Math.exp(-STOP_APPROACH * dt));
            if (Math.abs(target - eased) < SNAP_EPS) {
              reelPhaseRef.current[i] = "stopped";
              return wrap(target);
            }
            return eased;
          }
          return wrap(o + DIRECTIONS[i] * SPIN_SPEED * dt);
        });
        offsetsRef.current = next;
        setOffsets(next);

        if (
          phaseRef.current === "spinning" &&
          reelPhaseRef.current.every((p) => p === "stopped")
        ) {
          score();
        }
      }
      lastTimeRef.current = t;
      rafRef.current = requestAnimationFrame(stepFrame);
    };
    rafRef.current = requestAnimationFrame(stepFrame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
    };
  }, []);

  // Keyboard: Space / Enter pulls, then stops each reel in turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      primary();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Best is the most lives ever banked in one session.
  useEffect(() => {
    if (lives > 0) setBest((s) => ({ best: Math.max(s.best, lives) }));
  }, [lives, setBest]);

  // Silence the spin loop if the player leaves mid-spin.
  useEffect(() => stopSlotSpin, []);

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            <Trans id="slots.title" message="1-UP Slots" />
          </h1>
          <p className="mt-1 text-lg font-semibold text-amber-400 tabular-nums">
            🍄 {lives}
            {best > 0 && (
              <span className="ml-2 text-sm font-medium text-neutral-500">
                <Trans id="common.best" message="Best" /> {best}
              </span>
            )}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5">
          {/* The cabinet: a Spade Panel marquee over the three sliced reels. */}
          <div className="w-full max-w-sm">
            <div className="relative rounded-3xl bg-gradient-to-b from-red-800 to-red-950 p-4 shadow-2xl ring-4 ring-amber-400/90">
              <div className="mb-3 flex items-center justify-center gap-2 text-amber-300">
                <span className="text-xl leading-none">♠</span>
                <span className="text-xs font-bold uppercase tracking-[0.25em]">
                  Spade Panel
                </span>
                <span className="text-xl leading-none">♠</span>
              </div>

              {/* Reels window. Tapping it stops the next reel, like the lever. */}
              <div
                onPointerDown={() => phase === "spinning" && stop()}
                className="relative overflow-hidden rounded-xl bg-neutral-950 ring-2 ring-amber-900/70 select-none"
                style={{ height: `${ICON}px` }}
              >
                {[0, 1, 2].map((r) => {
                  const offset = offsets[r];
                  // Only the handful of cells near the payline are drawn. Cell k
                  // shows band r of SYMBOLS[k mod N] and sits at
                  // x = 50% + (k − offset) cells, so cells slide and wrap.
                  const base = Math.floor(offset);
                  const cells = [];
                  for (
                    let k = base - HALF_WINDOW;
                    k <= base + HALF_WINDOW + 1;
                    k++
                  ) {
                    const sym = SYMBOLS[((k % N) + N) % N];
                    const x = 50 + (k - offset) * CELL;
                    cells.push(
                      <div
                        key={k}
                        className="absolute top-0 overflow-hidden"
                        style={{
                          left: `${x}%`,
                          width: `${CELL}%`,
                          height: `${BAND}px`,
                          transform: "translateX(-50%)",
                        }}
                      >
                        {/* A full icon, shifted up so this band shows. Identical
                            geometry on every reel, so a matched column stacks
                            back into one seamless picture. */}
                        <div
                          className="absolute left-0 flex w-full items-center justify-center"
                          style={{
                            top: 0,
                            height: `${ICON}px`,
                            transform: `translateY(-${r * BAND}px)`,
                            fontSize: `${GLYPH}px`,
                            lineHeight: 1,
                          }}
                        >
                          {sym}
                        </div>
                      </div>,
                    );
                  }
                  return (
                    <div
                      key={r}
                      className="absolute inset-x-0"
                      style={{ top: `${r * BAND}px`, height: `${BAND}px` }}
                    >
                      {cells}
                    </div>
                  );
                })}

                {/* Payline: the center column the bands must line up in. */}
                <div
                  className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-md border-2 border-amber-400/90"
                  style={{ width: `${CELL}%` }}
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>

          <div className="flex h-7 items-center justify-center">
            {result &&
              (result.prize > 0 ? (
                <p className="text-lg font-semibold text-amber-400">
                  {result.symbol} 1-UP! +{result.prize}
                </p>
              ) : (
                <p className="text-lg font-semibold text-neutral-400">
                  No match — pull again
                </p>
              ))}
          </div>

          <button
            onClick={primary}
            className="rounded-full bg-amber-500 px-8 py-3 text-lg font-semibold text-neutral-900 hover:bg-amber-400"
          >
            {phase === "spinning" ? (
              <Trans id="slots.stop" message="Stop" />
            ) : phase === "result" ? (
              <Trans id="slots.again" message="Pull again" />
            ) : (
              <Trans id="slots.pull" message="Pull the lever" />
            )}
          </button>
        </div>
      </GameLayout>
    </>
  );
}
