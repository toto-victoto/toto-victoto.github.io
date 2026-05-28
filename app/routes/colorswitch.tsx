import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/colorswitch";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";

// All positions are expressed in % of the playfield so the game is
// resolution-independent and scales with its responsive container.
const AVATAR_X = 50; // % from the left edge
const AVATAR_Y = 72; // % — avatar sits on a fixed aim line
const AVATAR_SIZE = 9; // % side length of the avatar's bounding box
const RIBBON_HEIGHT = AVATAR_SIZE; // matches the avatar so a perfect pass aligns
const COLLISION_HALF = AVATAR_SIZE / 2; // collide when ribbon Y is within this of the avatar

// Difficulty ramps with score: bars either get faster or pack closer
// together. Each ramp is one of the two, drawn at random.
const SPEED_START = 15; // %/s
const SPEED_MAX = 42;
const SPEED_STEP = 3;
const SPACING_START = 63; // % between consecutive ribbons
const SPACING_MIN = 24;
const SPACING_STEP = 3;
const RAMP_EVERY = 10; // points per difficulty step
const MAX_DT = 0.05; // clamp dt so a backgrounded tab can't teleport bars

const SHAPES = ["circle", "triangle", "square"] as const;
type ShapeName = (typeof SHAPES)[number];

const COLORS = ["green", "blue", "red"] as const;
type Color = (typeof COLORS)[number];

const COLOR_BG: Record<Color, string> = {
  green: "bg-emerald-500",
  blue: "bg-sky-500",
  red: "bg-rose-500",
};

const COLOR_FILL: Record<Color, string> = {
  green: "fill-emerald-500",
  blue: "fill-sky-500",
  red: "fill-rose-500",
};

type Ribbon = { id: number; shape: ShapeName; color: Color; y: number };
type Phase = "idle" | "playing" | "gameover";
type RampType = "speed" | "spacing";

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Background classes used when rendering a shape as a "hole" cut out of a
// ribbon — same colour as the playfield, so the shape reads as a real hole.
const HOLE_BG = "bg-neutral-900";
const HOLE_FILL = "fill-neutral-900";

// Reusable shape renderer: circle / square are plain divs; triangle is an SVG
// polygon so its colour can be controlled by the same `fill-*` palette.
// Callers pass the bg + fill classes explicitly so the same component renders
// either a coloured game piece (avatar) or a dark "hole" inside a ribbon.
function ShapeView({
  shape,
  bgClass,
  fillClass,
  className,
  style,
}: {
  shape: ShapeName;
  bgClass: string;
  fillClass: string;
  className?: string;
  style?: CSSProperties;
}) {
  if (shape === "circle")
    return (
      <div
        className={`rounded-full ${bgClass} ${className ?? ""}`}
        style={style}
      />
    );
  if (shape === "square")
    return (
      <div
        className={`rounded-sm ${bgClass} ${className ?? ""}`}
        style={style}
      />
    );
  return (
    <svg
      viewBox="0 0 10 10"
      className={`${fillClass} ${className ?? ""}`}
      style={style}
      aria-hidden="true"
    >
      {/* Triangle fills the viewBox so it matches the visual weight of the
          circle and square at the same container size. */}
      <polygon points="5,0 10,10 0,10" />
    </svg>
  );
}

// A ribbon: a full-width band painted in the target colour with a shape-
// punched "hole" in the middle. The hole is rendered in the playfield's own
// background colour so the dark shape on a coloured band reads as a real
// cutout, and that's the form/colour combo the avatar must match.
function RibbonView({
  shape,
  color,
  y,
}: {
  shape: ShapeName;
  color: Color;
  y: number;
}) {
  return (
    <div
      className="absolute inset-x-0"
      style={{
        top: `${y - RIBBON_HEIGHT / 2}%`,
        height: `${RIBBON_HEIGHT}%`,
      }}
      aria-hidden="true"
    >
      {/* The coloured band itself. */}
      <div className={`absolute inset-0 ${COLOR_BG[color]}`} />
      {/* The hole — a square (in pixels) sized to match the ribbon's height,
          so the shape stays undistorted regardless of the playfield's
          aspect ratio. */}
      <div className="absolute top-1/2 left-1/2 aspect-square h-full -translate-x-1/2 -translate-y-1/2">
        <ShapeView
          shape={shape}
          bgClass={HOLE_BG}
          fillClass={HOLE_FILL}
          className="h-full w-full"
        />
      </div>
    </div>
  );
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Threader — toto-victoto" },
    {
      name: "description",
      content:
        "Cycle shape on the left, colour on the right — thread each ribbon's hole.",
    },
  ];
}

export default function ColorSwitch() {
  const [avatarShape, setAvatarShape] = useState<ShapeName>(SHAPES[0]);
  const [avatarColor, setAvatarColor] = useState<Color>(COLORS[0]);
  const [ribbons, setRibbons] = useState<Ribbon[]>([]);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [{ best }, setStored] = useStoredGame("colorswitch", { best: 0 });

  // Difficulty: live, since ramps mutate them. Stored in refs too so the
  // animation loop reads the latest without re-creating itself.
  const [speed, setSpeed] = useState(SPEED_START);
  const [spacing, setSpacing] = useState(SPACING_START);
  const speedRef = useRef(speed);
  const spacingRef = useRef(spacing);
  speedRef.current = speed;
  spacingRef.current = spacing;

  // Brief visual flash on the score whenever a ramp fires.
  const [lastRamp, setLastRamp] = useState<{ type: RampType; key: number } | null>(
    null,
  );
  const prevTierRef = useRef(0);

  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const idRef = useRef(0);
  // Each ribbon is resolved against the avatar at most once.
  const handledRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  function makeRibbon(y: number, prev: Ribbon | null): Ribbon {
    let shape: ShapeName;
    let color: Color;
    // Always differ from the previous ribbon on at least one axis so the
    // player must input something between any two ribbons.
    do {
      shape = randomFrom(SHAPES);
      color = randomFrom(COLORS);
    } while (prev && shape === prev.shape && color === prev.color);
    return { id: idRef.current++, shape, color, y };
  }

  function seedRibbons(): Ribbon[] {
    idRef.current = 0;
    handledRef.current = new Set();
    const seeded: Ribbon[] = [];
    let prev: Ribbon | null = null;
    for (let i = 0; i < 5; i++) {
      const y = -SPACING_START * (i + 1);
      const r = makeRibbon(y, prev);
      seeded.push(r);
      prev = r;
    }
    return seeded;
  }

  const cycleShape = () =>
    setAvatarShape((s) => SHAPES[(SHAPES.indexOf(s) + 1) % SHAPES.length]);
  const cycleColor = () =>
    setAvatarColor((c) => COLORS[(COLORS.indexOf(c) + 1) % COLORS.length]);

  // Left half cycles shape, right half cycles colour. The very first input
  // also starts the round (and re-seeds the ribbons).
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phaseRef.current === "gameover") return;
    e.preventDefault();
    if (phaseRef.current === "idle") {
      setPhase("playing");
      setRibbons(seedRibbons());
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) cycleShape();
    else cycleColor();
  };

  const reset = () => {
    setAvatarShape(SHAPES[0]);
    setAvatarColor(COLORS[0]);
    setScore(0);
    setSpeed(SPEED_START);
    setSpacing(SPACING_START);
    prevTierRef.current = 0;
    lastTimeRef.current = null;
    setRibbons(seedRibbons());
    setPhase("playing");
  };

  // Keyboard: ArrowLeft cycles shape, ArrowRight cycles colour. Restart on
  // game-over with any key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === "gameover") {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          reset();
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (phaseRef.current === "idle") {
          setPhase("playing");
          setRibbons(seedRibbons());
        }
        cycleShape();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (phaseRef.current === "idle") {
          setPhase("playing");
          setRibbons(seedRibbons());
        }
        cycleColor();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Movement loop: scroll ribbons down at the current speed, spawn fresh
  // ones to keep the chain evenly paced.
  useEffect(() => {
    const step = (t: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);
        const v = speedRef.current;
        const gap = spacingRef.current;
        setRibbons((prev) => {
          const moved = prev
            .map((r) => ({ ...r, y: r.y + v * dt }))
            .filter((r) => r.y < 110);
          const top = moved[moved.length - 1];
          if (!top || top.y > -gap) {
            const spawnY = top ? top.y - gap : -gap;
            moved.push(makeRibbon(spawnY, top ?? null));
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

  // Collision + scoring. handledRef makes this idempotent across re-renders.
  useEffect(() => {
    if (phase !== "playing") return;
    let died = false;
    let gained = 0;
    for (const r of ribbons) {
      if (handledRef.current.has(r.id)) continue;
      if (Math.abs(r.y - AVATAR_Y) < COLLISION_HALF) {
        handledRef.current.add(r.id);
        if (r.shape === avatarShape && r.color === avatarColor) gained++;
        else died = true;
      }
    }
    if (died) setPhase("gameover");
    if (gained) setScore((s) => s + gained);
  }, [ribbons, avatarShape, avatarColor, phase]);

  // Every RAMP_EVERY points, randomly bump speed or shrink spacing.
  useEffect(() => {
    if (phase !== "playing") return;
    const tier = Math.floor(score / RAMP_EVERY);
    if (tier <= prevTierRef.current) return;
    prevTierRef.current = tier;
    const speedCapped = speedRef.current >= SPEED_MAX;
    const spacingCapped = spacingRef.current <= SPACING_MIN;
    if (speedCapped && spacingCapped) return; // both maxed, nothing left
    let type: RampType;
    if (speedCapped) type = "spacing";
    else if (spacingCapped) type = "speed";
    else type = Math.random() < 0.5 ? "speed" : "spacing";
    if (type === "speed")
      setSpeed((s) => Math.min(s + SPEED_STEP, SPEED_MAX));
    else setSpacing((s) => Math.max(s - SPACING_STEP, SPACING_MIN));
    setLastRamp({ type, key: Date.now() });
  }, [score, phase]);

  // Clear the ramp flash after a moment so the icon doesn't linger.
  useEffect(() => {
    if (!lastRamp) return;
    const t = setTimeout(() => setLastRamp(null), 1200);
    return () => clearTimeout(t);
  }, [lastRamp]);

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
            <Trans id="colorswitch.title" message="Threader 🪡" />
          </h1>
        </header>

        {/* Playfield: largest 3:4 portrait that fits. Top-aligned so any
            leftover height lands at the bottom. */}
        <div className="flex min-h-0 flex-1 items-start justify-center">
          <div
            onPointerDown={phase === "gameover" ? undefined : handlePointerDown}
            className={`relative aspect-[3/4] h-full max-h-full w-auto max-w-full overflow-hidden rounded-2xl bg-neutral-900 select-none touch-none ${
              phase === "gameover" ? "" : "cursor-pointer"
            }`}
          >
            {/* Halves: left = shape, right = colour. Faint dividers so the
                player can see the tap zones. */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-white/5"
              aria-hidden="true"
            />

            {ribbons.map((r) => (
              <RibbonView
                key={r.id}
                shape={r.shape}
                color={r.color}
                y={r.y}
              />
            ))}

            {/* Aim line under the avatar — gives the eye a fixed reference. */}
            <div
              className="absolute inset-x-0 border-t border-dashed border-white/15"
              style={{ top: `${AVATAR_Y}%` }}
              aria-hidden="true"
            />

            {/* Avatar — sized by playfield height so its pixel dimensions
                match the ribbon's hole (both AVATAR_SIZE % of height with
                aspect-square forcing a true pixel-square). Width-based
                sizing would distort the shape because the playfield is
                aspect-[3/4]. */}
            <div
              className="absolute aspect-square -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${AVATAR_X}%`,
                top: `${AVATAR_Y}%`,
                height: `${AVATAR_SIZE}%`,
              }}
            >
              <ShapeView
                shape={avatarShape}
                bgClass={COLOR_BG[avatarColor]}
                fillClass={COLOR_FILL[avatarColor]}
                className="h-full w-full"
              />
            </div>

            {/* Tap-zone hints — only while waiting to start. */}
            {phase === "idle" && (
              <>
                <div
                  className="pointer-events-none absolute top-1/4 left-2 text-xs uppercase tracking-wider text-white/40"
                  aria-hidden="true"
                >
                  ◧ shape
                </div>
                <div
                  className="pointer-events-none absolute top-1/4 right-2 text-xs uppercase tracking-wider text-white/40"
                  aria-hidden="true"
                >
                  color ◨
                </div>
              </>
            )}

            {/* Score + ramp flash */}
            <div className="absolute top-3 inset-x-0 flex items-center justify-center gap-2 text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
              <span
                key={lastRamp?.key ?? "stable"}
                className={`inline-block text-4xl font-bold tabular-nums ${
                  lastRamp ? "motion-safe:animate-rps-tick" : ""
                }`}
              >
                {score}
              </span>
              {lastRamp && (
                <span
                  key={`badge-${lastRamp.key}`}
                  className={`text-2xl motion-safe:animate-rps-tick ${
                    lastRamp.type === "speed"
                      ? "text-amber-300"
                      : "text-sky-300"
                  }`}
                  aria-hidden="true"
                >
                  {lastRamp.type === "speed" ? "⚡" : "⇲"}
                </span>
              )}
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
                        message="Left tap = shape · right tap = color"
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
                        className={`rounded-full px-8 py-3 text-lg font-semibold text-neutral-950 transition hover:opacity-90 active:scale-95 ${COLOR_BG[avatarColor]}`}
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
