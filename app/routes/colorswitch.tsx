import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/colorswitch";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";

// All positions are expressed in % of the playfield so the game is
// resolution-independent and scales with its responsive container.
const BALL_X = 50; // % from the left edge
const BALL_Y = 72; // % — ball sits at a fixed line near the bottom
const BALL_RADIUS = 3.2; // % vertical half-size of the ball's hitbox

const BAR_HEIGHT = 3; // % thickness of a colored bar
// The window between consecutive bars. The faster the game runs, the less
// time the player has to plan their colour-cycle taps.
const BAR_SPACING_START = 40; // % between consecutive bars at score 0
const BAR_SPACING_MIN = 24; // % at high scores
const BAR_SPEED_START = 22; // %/s at score 0
const BAR_SPEED_MAX = 40; // %/s at high scores
const RAMP_SCORE = 30; // score at which the game reaches max speed
const MAX_DT = 0.05; // clamp dt so a backgrounded tab can't teleport bars

const COLORS = ["red", "blue", "green", "yellow"] as const;
type Color = (typeof COLORS)[number];

const COLOR_BG: Record<Color, string> = {
  red: "bg-rose-500",
  blue: "bg-sky-500",
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
};

type Bar = { id: number; color: Color; y: number };
type Phase = "idle" | "playing" | "gameover";

function randomColor(): Color {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// Pick a colour different from `not` so consecutive bars never repeat the
// same colour — otherwise the player can score multiple bars in a row
// without cycling, which kills the rhythm.
function randomColorExcept(not: Color): Color {
  const choices = COLORS.filter((c) => c !== not);
  return choices[Math.floor(Math.random() * choices.length)];
}

// Difficulty ramps with score: bars get a bit faster and a bit closer
// together. Caps so it never becomes literally impossible.
function speedFor(score: number): number {
  const t = Math.min(score / RAMP_SCORE, 1);
  return BAR_SPEED_START + (BAR_SPEED_MAX - BAR_SPEED_START) * t;
}
function spacingFor(score: number): number {
  const t = Math.min(score / RAMP_SCORE, 1);
  return BAR_SPACING_START + (BAR_SPACING_MIN - BAR_SPACING_START) * t;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Color Switch — toto-victoto" },
    {
      name: "description",
      content:
        "Tap to cycle your color — match each bar before it reaches you.",
    },
  ];
}

export default function ColorSwitch() {
  const [ballColor, setBallColor] = useState<Color>(COLORS[0]);
  const [bars, setBars] = useState<Bar[]>([]);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [{ best }, setStored] = useStoredGame("colorswitch", { best: 0 });

  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const barIdRef = useRef(0);
  // We resolve each bar against the ball at most once.
  const handledRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>(phase);
  const scoreRef = useRef(0);
  phaseRef.current = phase;
  scoreRef.current = score;

  function makeBar(y: number, lastColor: Color): Bar {
    return {
      id: barIdRef.current++,
      color: randomColorExcept(lastColor),
      y,
    };
  }

  function seedBars(): Bar[] {
    barIdRef.current = 0;
    handledRef.current = new Set();
    const seeded: Bar[] = [];
    let prevColor: Color = ballColor;
    // Start the first bar far above the screen so the player has time to
    // read it and plan their first tap.
    for (let i = 0; i < 5; i++) {
      const y = -BAR_SPACING_START * (i + 1);
      const bar = makeBar(y, prevColor);
      seeded.push(bar);
      prevColor = bar.color;
    }
    return seeded;
  }

  const tap = () => {
    if (phaseRef.current === "gameover") return;
    if (phaseRef.current === "idle") {
      setPhase("playing");
      setBars(seedBars());
    }
    // Cycle to the next colour. The player has full control of when this
    // happens — that's the entire skill loop.
    setBallColor((c) => {
      const i = COLORS.indexOf(c);
      return COLORS[(i + 1) % COLORS.length];
    });
  };

  const reset = () => {
    setBallColor(COLORS[0]);
    setScore(0);
    lastTimeRef.current = null;
    setBars(seedBars());
    setPhase("playing");
  };

  // Keyboard: spacebar mirrors a tap (and restarts on game-over).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      if (phaseRef.current === "gameover") reset();
      else tap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Movement loop: scroll the bars down, spawn a new one as the topmost
  // drifts off the spawn line. Speed and spacing both ramp with score.
  useEffect(() => {
    const step = (t: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);
        const speed = speedFor(scoreRef.current);
        const spacing = spacingFor(scoreRef.current);

        setBars((prev) => {
          const moved = prev
            .map((b) => ({ ...b, y: b.y + speed * dt }))
            .filter((b) => b.y < 110);
          const top = moved[moved.length - 1];
          if (!top || top.y > -spacing) {
            const spawnY = top ? top.y - spacing : -spacing;
            moved.push(makeBar(spawnY, top?.color ?? ballColor));
          }
          return moved;
        });
      }
      lastTimeRef.current = t;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
    };
  }, []);

  // Collision + scoring. handledRef makes it idempotent so the same bar
  // can't be scored or kill twice across re-renders.
  useEffect(() => {
    if (phase !== "playing") return;
    let died = false;
    let gained = 0;
    for (const b of bars) {
      if (handledRef.current.has(b.id)) continue;
      if (Math.abs(b.y - BALL_Y) < BALL_RADIUS + BAR_HEIGHT / 2) {
        handledRef.current.add(b.id);
        if (b.color === ballColor) gained++;
        else died = true;
      }
    }
    if (died) setPhase("gameover");
    if (gained) setScore((s) => s + gained);
  }, [bars, ballColor, phase]);

  // Track the best score of the session.
  useEffect(() => {
    if (phase === "gameover")
      setStored((s) => ({ best: Math.max(s.best, score) }));
  }, [phase, score, setStored]);

  // Next-bar hint: the player needs to know what colour is coming so they
  // can plan their taps. Compute the colour of the bar currently closest
  // to the ball that hasn't been resolved yet.
  const nextBar = bars
    .filter((b) => !handledRef.current.has(b.id) && b.y < BALL_Y)
    .reduce<Bar | null>(
      (closest, b) =>
        !closest || Math.abs(b.y - BALL_Y) < Math.abs(closest.y - BALL_Y)
          ? b
          : closest,
      null,
    );

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            <Trans id="colorswitch.title" message="Color Switch" />
          </h1>
        </header>

        {/* Playfield is the largest 3:4 portrait box that fits the remaining
            area. Top-aligned so any leftover height lands at the bottom. */}
        <div className="flex min-h-0 flex-1 items-start justify-center">
          <div
            onPointerDown={
              phase === "gameover"
                ? undefined
                : (e) => {
                    e.preventDefault();
                    tap();
                  }
            }
            className={`relative aspect-[3/4] h-full max-h-full w-auto max-w-full overflow-hidden rounded-2xl bg-neutral-900 select-none touch-none ${
              phase === "gameover" ? "" : "cursor-pointer"
            }`}
          >
            {bars.map((b) => (
              <div
                key={b.id}
                className={`absolute inset-x-0 ${COLOR_BG[b.color]}`}
                style={{
                  top: `${b.y - BAR_HEIGHT / 2}%`,
                  height: `${BAR_HEIGHT}%`,
                }}
                aria-hidden="true"
              />
            ))}

            {/* Ball */}
            <div
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white/40 transition-colors duration-75 ${COLOR_BG[ballColor]}`}
              style={{
                left: `${BALL_X}%`,
                top: `${BALL_Y}%`,
                width: `${BALL_RADIUS * 2}%`,
                height: `${BALL_RADIUS * 2}%`,
              }}
              aria-hidden="true"
            />

            {/* Aim line — a faint guide at the ball's Y so the player can
                read incoming bars against it. */}
            <div
              className="absolute inset-x-0 border-t border-dashed border-white/15"
              style={{ top: `${BALL_Y}%` }}
              aria-hidden="true"
            />

            {/* Next-bar preview chip on the right edge: the colour of the
                next bar the ball will cross. Helps the player plan taps. */}
            {nextBar && phase === "playing" && (
              <div
                className={`absolute right-2 h-2 w-2 -translate-y-1/2 rounded-full ring-1 ring-white/40 ${COLOR_BG[nextBar.color]}`}
                style={{ top: `${BALL_Y}%` }}
                aria-hidden="true"
              />
            )}

            {/* Score */}
            <div className="absolute top-3 inset-x-0 text-center text-4xl font-bold tabular-nums text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
              {score}
            </div>

            {phase !== "playing" && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className={`absolute inset-0 flex items-center justify-center bg-neutral-950/55 backdrop-blur-[1px] ${
                  phase === "idle" ? "pointer-events-none" : ""
                }`}
              >
                <div className="space-y-3 px-6 text-center">
                  {phase === "idle" ? (
                    <p className="text-lg font-medium text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
                      <Trans
                        id="colorswitch.start"
                        message="Tap to cycle color — match every bar"
                      />
                    </p>
                  ) : (
                    <>
                      <p className="text-3xl font-bold text-white">
                        <Trans id="colorswitch.gameover" message="Game over" />
                      </p>
                      <p className="text-sm text-white/90">
                        <Trans id="common.best" message="Best" />{" "}
                        <span className="font-bold tabular-nums">{best}</span>
                      </p>
                      <button
                        onClick={reset}
                        className={`rounded-full px-8 py-3 text-lg font-semibold text-neutral-950 transition hover:opacity-90 active:scale-95 ${COLOR_BG[ballColor]}`}
                      >
                        <Trans id="common.play_again" message="Play again" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </GameLayout>
    </>
  );
}
