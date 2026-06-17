import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/colorswitch";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";

// All positions are expressed in % of the playfield so the game is
// resolution-independent and scales with its responsive container. X is % of
// width, Y is % of height.
const AVATAR_Y = 74; // % — avatar rides a fixed aim line
const RIBBON_HEIGHT = 11; // % of height; the hole is a square of this side
const AVATAR_SIZE = 7; // % of height; smaller than the hole so passing has leeway
const COLLISION_Y = AVATAR_Y; // resolve a ribbon as it crosses the aim line
const DEFAULT_ASPECT = 3 / 4; // playfield width:height before it's measured

// The playfield's real width:height isn't guaranteed to be 3:4 — a tall, narrow
// viewport makes it taller — so we MEASURE it and derive every width-% value
// from the live aspect. A pixel-square sized by HEIGHT is 1/aspect as wide in
// width-% terms, hence the `/ a` below. Keeping the hole geometry, the collision
// test, and the cutout's viewBox all keyed to the same measured aspect is what
// keeps the shape un-stretched and the visual hole aligned with the hit-test.
const holeHalfW = (a: number) => RIBBON_HEIGHT / 2 / a; // %width
const avatarHalfW = (a: number) => AVATAR_SIZE / 2 / a;
// Leeway: how far the avatar's centre may sit from the hole's and still thread.
const passTolerance = (a: number) => (RIBBON_HEIGHT - AVATAR_SIZE) / 2 / a;

// The ribbon is one full-width SVG (no slab seams). Setting the viewBox to
// 100·aspect × RIBBON_HEIGHT makes its units square under
// preserveAspectRatio="none" for ANY measured aspect, so the cutout never
// distorts; the shape is authored in a 0..10 box, hence HOLE_SCALE.
const VB_H = RIBBON_HEIGHT;
const HOLE_SCALE = RIBBON_HEIGHT / 10;

// Difficulty ramps with score along three independent levers, one bumped at
// random per step: ribbons fall faster, pack closer, or slide sideways faster.
const SPEED_START = 16; // vertical %/s
const SPEED_MAX = 42;
const SPEED_STEP = 3;
const SPACING_START = 58; // % between consecutive ribbons
const SPACING_MIN = 26;
const SPACING_STEP = 3;
const HSPEED_START = 10; // horizontal %/s of the hole's drift
const HSPEED_MAX = 48;
const HSPEED_STEP = 4;
const RAMP_EVERY = 8; // points per difficulty step
const MAX_DT = 0.05; // clamp dt so a backgrounded tab can't teleport ribbons

const KEY_STEP = 5; // %/keypress for arrow-key avatar movement
const TAP_SLOP = 6; // px of travel before a press counts as a drag, not a tap

// Sleeker than triangle/circle/square: a five-point star, a rhombus, and a
// hexagon — distinct silhouettes that read clearly even as small holes. Points
// are in a 0..10 viewBox, reused for both the avatar and the ribbon's cutout.
const SHAPES = ["star", "diamond", "hexagon"] as const;
type ShapeName = (typeof SHAPES)[number];

const SHAPE_POINTS: Record<ShapeName, string> = {
  star: "5,0.2 6.18,3.38 9.56,3.52 6.9,5.62 7.82,8.88 5,7 2.18,8.88 3.1,5.62 0.44,3.52 3.82,3.38",
  diamond: "5,0.3 9.7,5 5,9.7 0.3,5",
  hexagon: "5,0.2 9.16,2.6 9.16,7.4 5,9.8 0.84,7.4 0.84,2.6",
};

type Ribbon = { id: number; shape: ShapeName; x: number; dir: 1 | -1; y: number };
type Phase = "idle" | "playing" | "gameover";
type RampType = "speed" | "spacing" | "hspeed";
type Spark = { id: number; dx: number; dy: number; color: string };

const RAMP_BADGE: Record<RampType, { glyph: string; color: string }> = {
  speed: { glyph: "⚡", color: "text-amber-300" },
  spacing: { glyph: "⇲", color: "text-sky-300" },
  hspeed: { glyph: "↔", color: "text-fuchsia-300" },
};

const SPARK_COLORS = ["#fde047", "#fb7185", "#ffffff"];

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// One horizontal half of a ribbon, drawn as a single full-width SVG with the
// target shape punched clean through it via a mask. The two halves of a ribbon
// render in different z-layers (top behind the avatar, bottom in front), so a
// threading shape weaves through the band — over the top, under the bottom —
// for a real sense of passing *through* it. Each half clips a full-band SVG, so
// the gradient stays seamless across the cut and across x.
function RibbonHalf({
  id,
  shape,
  x,
  y,
  half,
  aspect,
}: {
  id: number;
  shape: ShapeName;
  x: number;
  y: number;
  half: "top" | "bottom";
  aspect: number;
}) {
  const vbW = 100 * aspect; // viewBox width in (now square) units
  const cx = x * aspect; // hole centre in viewBox units
  const maskId = `hole-${half}-${id}`;
  const gradId = `rib-${half}-${id}`;
  const bandTop = y - RIBBON_HEIGHT / 2;
  const top = half === "top" ? bandTop : bandTop + RIBBON_HEIGHT / 2;
  return (
    <div
      className="absolute inset-x-0 overflow-hidden"
      style={{ top: `${top}%`, height: `${RIBBON_HEIGHT / 2}%` }}
      aria-hidden="true"
    >
      <svg
        viewBox={`0 0 ${vbW} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-x-0 w-full"
        style={{ top: half === "top" ? "0" : "-100%", height: "200%" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="1" stopColor="#6d28d9" />
          </linearGradient>
          <mask id={maskId}>
            {/* White keeps the ribbon; the black shape carves the hole. */}
            <rect width={vbW} height={VB_H} fill="white" />
            <g transform={`translate(${cx - VB_H / 2} 0) scale(${HOLE_SCALE})`}>
              <polygon points={SHAPE_POINTS[shape]} fill="black" />
            </g>
          </mask>
        </defs>
        <rect
          width={vbW}
          height={VB_H}
          fill={`url(#${gradId})`}
          mask={`url(#${maskId})`}
        />
      </svg>
    </div>
  );
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Threader — toto-victoto" },
    {
      name: "description",
      content:
        "Thread the sliding gate: tap to switch shape, drag to line your shape up with the moving hole.",
    },
  ];
}

export default function ColorSwitch() {
  const [avatarShape, setAvatarShape] = useState<ShapeName>(SHAPES[0]);
  const [avatarX, setAvatarX] = useState(50);
  const [ribbons, setRibbons] = useState<Ribbon[]>([]);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [{ best }, setStored] = useStoredGame("colorswitch", { best: 0 });

  // Difficulty: live, since ramps mutate them. Mirrored into refs so the
  // animation loop reads the latest without re-creating itself.
  const [speed, setSpeed] = useState(SPEED_START);
  const [spacing, setSpacing] = useState(SPACING_START);
  const [hspeed, setHspeed] = useState(HSPEED_START);
  const speedRef = useRef(speed);
  const spacingRef = useRef(spacing);
  const hspeedRef = useRef(hspeed);
  speedRef.current = speed;
  spacingRef.current = spacing;
  hspeedRef.current = hspeed;

  // Brief visual flash on the score whenever a ramp fires.
  const [lastRamp, setLastRamp] = useState<{ type: RampType; key: number } | null>(
    null,
  );
  const prevTierRef = useRef(0);

  // Validation burst when a shape threads its hole: a ring + radial sparks at
  // the pass point.
  const [pass, setPass] = useState<{ key: number; x: number } | null>(null);
  const [sparks, setSparks] = useState<Spark[]>([]);

  // Measured playfield aspect (width/height); geometry derives from it live.
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const aspectRef = useRef(DEFAULT_ASPECT);
  aspectRef.current = aspect;
  const fieldRef = useRef<HTMLDivElement | null>(null);

  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const idRef = useRef(0);
  // Each ribbon is resolved against the avatar at most once.
  const handledRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  // Active pointer drag (vs. a tap), tracked imperatively to avoid re-renders.
  const dragRef = useRef<{
    startX: number;
    lastX: number;
    moved: boolean;
    id: number;
  } | null>(null);

  function makeRibbon(y: number): Ribbon {
    const half = holeHalfW(aspectRef.current);
    const lo = half;
    const hi = 100 - half;
    return {
      id: idRef.current++,
      shape: randomFrom(SHAPES),
      x: lo + Math.random() * (hi - lo),
      dir: Math.random() < 0.5 ? -1 : 1,
      y,
    };
  }

  function seedRibbons(): Ribbon[] {
    idRef.current = 0;
    handledRef.current = new Set();
    return Array.from({ length: 5 }, (_, i) => makeRibbon(-SPACING_START * (i + 1)));
  }

  const cycleShape = () =>
    setAvatarShape((s) => SHAPES[(SHAPES.indexOf(s) + 1) % SHAPES.length]);
  const moveAvatar = (dx: number) =>
    setAvatarX((x) => {
      const h = avatarHalfW(aspectRef.current);
      return clamp(x + dx, h, 100 - h);
    });

  const startGame = () => {
    setPhase("playing");
    setRibbons(seedRibbons());
  };

  const reset = () => {
    setAvatarShape(SHAPES[0]);
    setAvatarX(50);
    setScore(0);
    setSpeed(SPEED_START);
    setSpacing(SPACING_START);
    setHspeed(HSPEED_START);
    prevTierRef.current = 0;
    lastTimeRef.current = null;
    setPass(null);
    setSparks([]);
    setRibbons(seedRibbons());
    setPhase("playing");
  };

  // Tap (a press that doesn't travel) switches shape; press-and-drag slides the
  // avatar. The first input also starts the round.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phaseRef.current === "gameover") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (phaseRef.current === "idle") startGame();
    dragRef.current = { startX: e.clientX, lastX: e.clientX, moved: false, id: e.pointerId };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (Math.abs(e.clientX - d.startX) > TAP_SLOP) d.moved = true;
    const dxPct = ((e.clientX - d.lastX) / rect.width) * 100;
    d.lastX = e.clientX;
    if (d.moved && dxPct !== 0) moveAvatar(dxPct);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved) cycleShape(); // a clean tap → switch shape
  };

  // Keyboard: arrows slide the avatar, space/up switches shape, both start the
  // round; on game-over, space/enter restarts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === "gameover") {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          reset();
        }
        return;
      }
      const start = () => phaseRef.current === "idle" && startGame();
      switch (e.key) {
        case "ArrowLeft":
          start();
          moveAvatar(-KEY_STEP);
          break;
        case "ArrowRight":
          start();
          moveAvatar(KEY_STEP);
          break;
        case " ":
        case "ArrowUp":
        case "Enter":
          start();
          cycleShape();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure the playfield's real aspect ratio — it's not reliably 3:4 (a tall
  // viewport stretches it taller) — so the hole geometry and the cutout stay
  // un-distorted. Re-measures on resize / rotation.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setAspect(r.width / r.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Movement loop: scroll ribbons down and drift their holes sideways (bouncing
  // off the walls), spawning fresh ones to keep the chain evenly paced.
  useEffect(() => {
    const step = (t: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);
        const v = speedRef.current;
        const gap = spacingRef.current;
        const hv = hspeedRef.current;
        const xMin = holeHalfW(aspectRef.current);
        const xMax = 100 - xMin;
        setRibbons((prev) => {
          const moved = prev
            .map((r) => {
              let x = r.x + r.dir * hv * dt;
              let dir = r.dir;
              if (x < xMin) {
                x = xMin;
                dir = 1;
              } else if (x > xMax) {
                x = xMax;
                dir = -1;
              }
              return { ...r, y: r.y + v * dt, x, dir };
            })
            .filter((r) => r.y < 115);
          const top = moved[moved.length - 1];
          if (!top || top.y > -gap) {
            moved.push(makeRibbon(top ? top.y - gap : -gap));
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

  // Fling a small radial spark burst from the pass point.
  const burstSparks = () => {
    setSparks(
      Array.from({ length: 9 }, (_, i) => {
        const a = (i / 9) * Math.PI * 2;
        const d = 38 + Math.random() * 26;
        return {
          id: idRef.current * 100 + i, // unlikely to collide within a burst
          dx: Math.cos(a) * d,
          dy: Math.sin(a) * d,
          color: SPARK_COLORS[i % SPARK_COLORS.length],
        };
      }),
    );
  };

  // Collision + scoring, resolved once per ribbon as it crosses the aim line:
  // a pass needs the matching shape AND the avatar centred within the hole.
  useEffect(() => {
    if (phase !== "playing") return;
    let died = false;
    let gained = 0;
    const tol = passTolerance(aspectRef.current);
    for (const r of ribbons) {
      if (handledRef.current.has(r.id)) continue;
      if (r.y >= COLLISION_Y) {
        handledRef.current.add(r.id);
        const aligned = Math.abs(avatarX - r.x) <= tol;
        if (r.shape === avatarShape && aligned) gained++;
        else died = true;
      }
    }
    if (gained) {
      setScore((s) => s + gained);
      setPass({ key: Date.now(), x: avatarX });
      burstSparks();
    }
    if (died) setPhase("gameover");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ribbons, avatarShape, avatarX, phase]);

  // Every RAMP_EVERY points, bump a random un-maxed lever.
  useEffect(() => {
    if (phase !== "playing") return;
    const tier = Math.floor(score / RAMP_EVERY);
    if (tier <= prevTierRef.current) return;
    prevTierRef.current = tier;
    const options: RampType[] = [];
    if (speedRef.current < SPEED_MAX) options.push("speed");
    if (spacingRef.current > SPACING_MIN) options.push("spacing");
    if (hspeedRef.current < HSPEED_MAX) options.push("hspeed");
    if (options.length === 0) return; // everything maxed
    const type = randomFrom(options);
    if (type === "speed") setSpeed((s) => Math.min(s + SPEED_STEP, SPEED_MAX));
    else if (type === "spacing")
      setSpacing((s) => Math.max(s - SPACING_STEP, SPACING_MIN));
    else setHspeed((s) => Math.min(s + HSPEED_STEP, HSPEED_MAX));
    setLastRamp({ type, key: Date.now() });
  }, [score, phase]);

  // Clear the transient flashes after their animations finish.
  useEffect(() => {
    if (!lastRamp) return;
    const t = setTimeout(() => setLastRamp(null), 1200);
    return () => clearTimeout(t);
  }, [lastRamp]);
  useEffect(() => {
    if (!pass) return;
    const t = setTimeout(() => setPass(null), 520);
    return () => clearTimeout(t);
  }, [pass]);
  useEffect(() => {
    if (sparks.length === 0) return;
    const t = setTimeout(() => setSparks([]), 600);
    return () => clearTimeout(t);
  }, [sparks]);

  // Track the best score of the session.
  useEffect(() => {
    if (phase === "gameover")
      setStored((s) => ({ best: Math.max(s.best, score) }));
  }, [phase, score, setStored]);

  const avatarStyle: CSSProperties = {
    left: `${avatarX}%`,
    top: `${AVATAR_Y}%`,
    height: `${AVATAR_SIZE}%`,
    filter: "drop-shadow(0 0 6px rgba(251, 191, 36, 0.55))",
  };

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="bg-gradient-to-r from-amber-300 to-rose-400 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            <Trans id="colorswitch.title" message="Threader 🪡" />
          </h1>
        </header>

        {/* Playfield: largest 3:4 portrait that fits. Top-aligned so any
            leftover height lands at the bottom. */}
        <div className="flex min-h-0 flex-1 items-start justify-center">
          <div
            ref={fieldRef}
            onPointerDown={phase === "gameover" ? undefined : onPointerDown}
            onPointerMove={phase === "gameover" ? undefined : onPointerMove}
            onPointerUp={phase === "gameover" ? undefined : onPointerUp}
            className={`relative aspect-[3/4] h-full max-h-full w-auto max-w-full overflow-hidden rounded-2xl bg-gradient-to-b from-slate-950 to-neutral-950 ring-1 ring-white/5 select-none touch-none ${
              phase === "gameover" ? "" : "cursor-pointer"
            }`}
          >
            {/* Bottom halves — z-10, behind the avatar (the shape passes over). */}
            <div className="absolute inset-0 z-10" aria-hidden="true">
              {ribbons.map((r) => (
                <RibbonHalf key={r.id} id={r.id} shape={r.shape} x={r.x} y={r.y} half="bottom" aspect={aspect} />
              ))}
            </div>

            {/* Avatar — z-20, woven between the ribbon halves. Slightly smaller
                than the hole, giving the pass some leeway. */}
            <div
              className="absolute z-20 aspect-square -translate-x-1/2 -translate-y-1/2"
              style={avatarStyle}
            >
              <svg
                viewBox="0 0 10 10"
                className="h-full w-full overflow-visible"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="avatar-grad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#fde047" />
                    <stop offset="1" stopColor="#fb7185" />
                  </linearGradient>
                </defs>
                <polygon points={SHAPE_POINTS[avatarShape]} fill="url(#avatar-grad)" />
              </svg>
            </div>

            {/* Top halves — z-30, in front of the avatar (it tucks under). */}
            <div className="absolute inset-0 z-30" aria-hidden="true">
              {ribbons.map((r) => (
                <RibbonHalf key={r.id} id={r.id} shape={r.shape} x={r.x} y={r.y} half="top" aspect={aspect} />
              ))}
            </div>

            {/* Validation burst — ring + sparks at the threaded point. */}
            {pass && (
              <div
                key={pass.key}
                className="pointer-events-none absolute z-40 aspect-square -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${pass.x}%`, top: `${AVATAR_Y}%`, height: `${RIBBON_HEIGHT}%` }}
                aria-hidden="true"
              >
                <div className="h-full w-full animate-thread-ring rounded-full border-2 border-amber-300 [box-shadow:0_0_12px_rgba(251,191,36,0.7)]" />
                {sparks.map((s) => (
                  <span
                    key={s.id}
                    className="absolute top-1/2 left-1/2 -ml-[2px] -mt-[2px] h-1 w-1 animate-thread-spark rounded-full"
                    style={
                      {
                        backgroundColor: s.color,
                        "--dx": `${s.dx}px`,
                        "--dy": `${s.dy}px`,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            )}

            {/* Aim line — z-40 so the player can always see the thread line. */}
            <div
              className="absolute inset-x-0 z-40 border-t border-dashed border-white/15"
              style={{ top: `${AVATAR_Y}%` }}
              aria-hidden="true"
            />

            {/* Score + ramp flash */}
            <div className="absolute top-3 inset-x-0 z-50 flex items-center justify-center gap-2 text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
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
                  className={`text-2xl motion-safe:animate-rps-tick ${RAMP_BADGE[lastRamp.type].color}`}
                  aria-hidden="true"
                >
                  {RAMP_BADGE[lastRamp.type].glyph}
                </span>
              )}
            </div>

            {phase !== "playing" && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className={`absolute inset-0 z-[60] flex items-center justify-center bg-neutral-950/55 backdrop-blur-[1px] ${
                  phase === "idle" ? "pointer-events-none" : ""
                }`}
              >
                <div className="space-y-3 px-6 text-center">
                  {phase === "idle" ? (
                    <p className="text-lg font-medium text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
                      <Trans
                        id="colorswitch.start"
                        message="Tap to switch shape · drag to line it up"
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
                        className="rounded-full bg-gradient-to-r from-amber-300 to-rose-400 px-8 py-3 text-lg font-semibold text-neutral-950 transition hover:opacity-90 active:scale-95"
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
