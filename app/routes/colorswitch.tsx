import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/colorswitch";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";

// All positions are expressed in % of the playfield so the game is
// resolution-independent and scales with its responsive container.
const BALL_X = 50; // % from the left edge — fixed horizontally
const BALL_RADIUS = 3; // % vertical half-size of the ball's hitbox
const FLOOR_Y = 88; // % — ball auto-bounces back up when it reaches this
const START_Y = 50;

// Physics in %-of-field per second. Multiplying by dt keeps the motion
// identical regardless of the screen's refresh rate.
const GRAVITY = 460; // %/s² downward acceleration
const TAP_VELOCITY = -90; // %/s upward impulse on tap (replaces velocity)
const BOUNCE_VELOCITY = -55; // %/s automatic bounce off the floor
const MAX_DT = 0.05; // clamp dt so a backgrounded tab can't teleport the ball

// Obstacles scroll down past the ball.
const OBSTACLE_SPEED = 24; // %/s scroll velocity
const OBSTACLE_SPACING = 32; // % vertical gap between consecutive obstacles
const BAR_HEIGHT = 2.5; // % thickness of a colored bar
const STAR_RADIUS = 2.8; // % half-size of a color-changing star
const STAR_FREQUENCY = 3; // every Nth obstacle is a color-changing star

type Color = "red" | "blue" | "green" | "yellow";

const COLORS: Color[] = ["red", "blue", "green", "yellow"];

const COLOR_BG: Record<Color, string> = {
  red: "bg-rose-500",
  blue: "bg-sky-500",
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
};

type Obstacle = {
  id: number;
  type: "bar" | "star";
  color: Color;
  y: number;
};

type Phase = "idle" | "playing" | "gameover";

function randomColor(): Color {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// Pick a colour different from `not` so collecting a star always changes
// the ball's hue (otherwise the pickup feels invisible).
function randomColorExcept(not: Color): Color {
  const choices = COLORS.filter((c) => c !== not);
  return choices[Math.floor(Math.random() * choices.length)];
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Color Switch — toto-victoto" },
    {
      name: "description",
      content:
        "Bounce a colored ball through matching bars — collect stars to swap colors.",
    },
  ];
}

export default function ColorSwitch() {
  const [ballY, setBallY] = useState(START_Y);
  const [ballColor, setBallColor] = useState<Color>("red");
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [{ best }, setStored] = useStoredGame("colorswitch", { best: 0 });

  const velocityRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const obstacleIdRef = useRef(0);
  // Once an obstacle has been resolved against the ball (passed cleanly or
  // collected as a star) we don't want to re-trigger on subsequent frames.
  const handledRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  function makeObstacle(y: number): Obstacle {
    const id = obstacleIdRef.current++;
    const isStar = id > 0 && id % STAR_FREQUENCY === 0;
    return {
      id,
      type: isStar ? "star" : "bar",
      color: randomColor(),
      y,
    };
  }

  function seedObstacles(): Obstacle[] {
    obstacleIdRef.current = 0;
    handledRef.current = new Set();
    const seeded: Obstacle[] = [];
    // Seed five obstacles waiting above the screen so the very first bar
    // doesn't drop on top of the ball at t=0.
    for (let i = 0; i < 5; i++) {
      seeded.push(makeObstacle(-OBSTACLE_SPACING - i * OBSTACLE_SPACING));
    }
    return seeded;
  }

  const tap = () => {
    if (phaseRef.current === "gameover") return;
    if (phaseRef.current === "idle") {
      setPhase("playing");
      setObstacles(seedObstacles());
    }
    velocityRef.current = TAP_VELOCITY;
  };

  const reset = () => {
    setBallY(START_Y);
    setBallColor(COLORS[0]);
    setScore(0);
    velocityRef.current = 0;
    lastTimeRef.current = null;
    setObstacles(seedObstacles());
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

  // Movement loop: gravity, floor bounce, obstacle scroll, spawn.
  useEffect(() => {
    const step = (t: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);

        velocityRef.current += GRAVITY * dt;
        setBallY((prev) => {
          let next = prev + velocityRef.current * dt;
          if (next >= FLOOR_Y) {
            next = FLOOR_Y;
            velocityRef.current = BOUNCE_VELOCITY;
          }
          return next;
        });

        setObstacles((prev) => {
          const moved = prev
            .map((o) => ({ ...o, y: o.y + OBSTACLE_SPEED * dt }))
            .filter((o) => o.y < 110);
          // Topmost (last spawned) is at the end of the array. Once it has
          // drifted past one full SPACING below its spawn point, add a new
          // one a SPACING above so the chain stays evenly paced.
          const top = moved[moved.length - 1];
          if (!top || top.y > -OBSTACLE_SPACING) {
            const spawnY = top ? top.y - OBSTACLE_SPACING : -OBSTACLE_SPACING;
            moved.push(makeObstacle(spawnY));
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

  // Collision + scoring + color change. Re-runs whenever the ball or the
  // obstacle list changes; handledRef makes it idempotent so the same
  // obstacle can't be scored or kill twice.
  useEffect(() => {
    if (phase !== "playing") return;
    let died = false;
    let gained = 0;
    let nextColor: Color | null = null;
    for (const o of obstacles) {
      if (handledRef.current.has(o.id)) continue;
      const halfH = o.type === "bar" ? BAR_HEIGHT / 2 : STAR_RADIUS;
      if (Math.abs(o.y - ballY) < BALL_RADIUS + halfH) {
        handledRef.current.add(o.id);
        if (o.type === "bar") {
          if (o.color === ballColor) gained++;
          else died = true;
        } else {
          nextColor = randomColorExcept(ballColor);
        }
      }
    }
    if (died) setPhase("gameover");
    if (gained) setScore((s) => s + gained);
    if (nextColor) setBallColor(nextColor);
  }, [ballY, obstacles, ballColor, phase]);

  // Track the best score of the session.
  useEffect(() => {
    if (phase === "gameover")
      setStored((s) => ({ best: Math.max(s.best, score) }));
  }, [phase, score, setStored]);

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
            {obstacles.map((o) =>
              handledRef.current.has(o.id) && o.type === "star" ? null : (
                o.type === "bar" ? (
                  <div
                    key={o.id}
                    className={`absolute inset-x-0 ${COLOR_BG[o.color]}`}
                    style={{
                      top: `${o.y - BAR_HEIGHT / 2}%`,
                      height: `${BAR_HEIGHT}%`,
                    }}
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    key={o.id}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white/70 ${COLOR_BG[o.color]}`}
                    style={{
                      left: `${BALL_X}%`,
                      top: `${o.y}%`,
                      width: `${STAR_RADIUS * 2}%`,
                      height: `${STAR_RADIUS * 2}%`,
                    }}
                    aria-hidden="true"
                  />
                )
              ),
            )}

            {/* Floor line — visual cue for the auto-bounce surface. */}
            <div
              className="absolute inset-x-0 border-t border-neutral-700"
              style={{ top: `${FLOOR_Y}%` }}
              aria-hidden="true"
            />

            {/* Ball */}
            <div
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white/40 transition-colors ${COLOR_BG[ballColor]}`}
              style={{
                left: `${BALL_X}%`,
                top: `${ballY}%`,
                width: `${BALL_RADIUS * 2}%`,
                height: `${BALL_RADIUS * 2}%`,
              }}
              aria-hidden="true"
            />

            {/* Score */}
            <div className="absolute top-3 inset-x-0 text-center text-4xl font-bold tabular-nums text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
              {score}
            </div>

            {phase !== "playing" && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className={`absolute inset-0 flex items-center justify-center bg-neutral-950/50 backdrop-blur-[1px] ${
                  phase === "idle" ? "pointer-events-none" : ""
                }`}
              >
                <div className="space-y-3 px-6 text-center">
                  {phase === "idle" ? (
                    <p className="text-lg font-medium text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
                      <Trans
                        id="colorswitch.start"
                        message="Tap to bounce — match the color"
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
