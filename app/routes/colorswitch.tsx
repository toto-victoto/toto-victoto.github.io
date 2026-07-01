import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/colorswitch";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { useStoredGame } from "../storage";

// All positions are % of the playfield: X is % of width, Y is % of height.
// The playfield is sized by WIDTH (aspect-[3/4] w-full max-h-full), the same
// trick Snake uses, so it's a real 3:4 box and this constant matches reality.
const ASPECT = 3 / 4;
const AVATAR_Y = 74; // % — avatar rides a fixed aim line
const RIBBON_HEIGHT = 11; // % of height; the hole is a square of this side
const AVATAR_SIZE = 7; // % of height; smaller than the hole so passing has leeway
const COLLISION_Y = AVATAR_Y;

const HOLE_HALF_W = RIBBON_HEIGHT / 2 / ASPECT; // %width
const AVATAR_HALF_W = AVATAR_SIZE / 2 / ASPECT;
const X_MIN = HOLE_HALF_W;
const X_MAX = 100 - HOLE_HALF_W;
const AVATAR_X_MIN = AVATAR_HALF_W;
const AVATAR_X_MAX = 100 - AVATAR_HALF_W;
const PASS_TOLERANCE = HOLE_HALF_W - AVATAR_HALF_W; // legal-thread leeway (%width)
const PERFECT_TOLERANCE = PASS_TOLERANCE * 0.4; // tight centre for a "Perfect"

// One full-width SVG per ribbon (no seams); viewBox 100·ASPECT × RIBBON_HEIGHT
// keeps units square under preserveAspectRatio="none" so cutouts don't distort.
const VB_W = 100 * ASPECT;
const VB_H = RIBBON_HEIGHT;
const HOLE_SCALE = RIBBON_HEIGHT / 10;

// Difficulty ramps every RAMP_EVERY threads: faster fall, tighter spacing, or
// quicker sideways drift, one at random per step.
const SPEED_START = 16;
const SPEED_MAX = 40;
const SPEED_STEP = 2.5;
const SPACING_START = 58;
const SPACING_MIN = 28;
const SPACING_STEP = 3;
const HSPEED_START = 8;
const HSPEED_MAX = 46;
const HSPEED_STEP = 4;
const RAMP_EVERY = 6; // threads per difficulty step
const MAX_DT = 0.05;

const KEY_STEP = 5;
const TAP_SLOP = 6;

const SHIELD_EVERY = 10; // gain a shield each N-combo
const SHIELD_MAX = 2;
const BEAD_BONUS = 8; // extra points for threading a bead
const BEAD_CHANCE = 0.16; // per single hole

// Five-point star, rhombus, hexagon — authored in a 0..10 box, reused for the
// avatar and the ribbon cutouts.
const SHAPES = ["star", "diamond", "hexagon"] as const;
type ShapeName = (typeof SHAPES)[number];

const SHAPE_POINTS: Record<ShapeName, string> = {
  star: "5,0.2 6.18,3.38 9.56,3.52 6.9,5.62 7.82,8.88 5,7 2.18,8.88 3.1,5.62 0.44,3.52 3.82,3.38",
  diamond: "5,0.3 9.7,5 5,9.7 0.3,5",
  hexagon: "5,0.2 9.16,2.6 9.16,7.4 5,9.8 0.84,7.4 0.84,2.6",
};

// Each shape wears its own sleek gradient (+ glow rgb), so colour reinforces
// shape: the avatar shows its current shape's, a ribbon shows its hole's.
const SHAPE_STYLE: Record<ShapeName, { from: string; to: string; glow: string }> = {
  star: { from: "#fcd34d", to: "#f97316", glow: "251,191,36" },
  diamond: { from: "#38bdf8", to: "#4f46e5", glow: "56,189,248" },
  hexagon: { from: "#f0abfc", to: "#c026d3", glow: "217,70,239" },
};

// The combo tier tints the sewn thread and the field glow so escalation reads.
const COMBO_COLORS = ["#38bdf8", "#a3e635", "#fbbf24", "#fb7185", "#e879f9", "#22d3ee"];
const comboColor = (c: number) =>
  COMBO_COLORS[Math.min(COMBO_COLORS.length - 1, Math.floor(Math.max(0, c - 1) / 5))];

type Hole = { shape: ShapeName; x: number; dir: 1 | -1; drift: boolean; bead: boolean };
type Ribbon = { id: number; y: number; holes: Hole[] };
type Stitch = { id: number; x: number; y: number };
type Spark = { id: number; dx: number; dy: number; color: string };
type Phase = "idle" | "playing" | "gameover";
type RampType = "speed" | "spacing" | "hspeed";
type PatternType = "random" | "run" | "zigzag" | "double";

const RAMP_BADGE: Record<RampType, { glyph: string; color: string }> = {
  speed: { glyph: "⚡", color: "text-amber-300" },
  spacing: { glyph: "⇲", color: "text-sky-300" },
  hspeed: { glyph: "↔", color: "text-fuchsia-300" },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const randInt = (n: number) => Math.floor(Math.random() * n);
function randomFrom<T>(arr: readonly T[]): T {
  return arr[randInt(arr.length)];
}

// One horizontal half of a ribbon: a single full-width SVG with every hole
// masked out. The two halves sit in different z-layers (top in front of the
// avatar, bottom behind), so a threading shape weaves through the band.
function RibbonHalf({
  id,
  holes,
  y,
  half,
}: {
  id: number;
  holes: Hole[];
  y: number;
  half: "top" | "bottom";
}) {
  const style = SHAPE_STYLE[holes[0].shape];
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
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-x-0 w-full"
        style={{ top: half === "top" ? "0" : "-100%", height: "200%" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={style.from} />
            <stop offset="1" stopColor={style.to} />
          </linearGradient>
          <mask id={maskId}>
            <rect width={VB_W} height={VB_H} fill="white" />
            {holes.map((h, i) => (
              <g
                key={i}
                transform={`translate(${h.x * ASPECT - VB_H / 2} 0) scale(${HOLE_SCALE})`}
              >
                <polygon points={SHAPE_POINTS[h.shape]} fill="black" />
              </g>
            ))}
          </mask>
        </defs>
        <rect
          width={VB_W}
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
        "Thread the sliding gates: tap to switch shape, drag to line up, chain combos and sew the thread.",
    },
  ];
}

export default function ColorSwitch() {
  const [avatarShape, setAvatarShape] = useState<ShapeName>(SHAPES[0]);
  const [avatarX, setAvatarX] = useState(50);
  const [ribbons, setRibbons] = useState<Ribbon[]>([]);
  const [stitches, setStitches] = useState<Stitch[]>([]);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [shields, setShields] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [{ best }, setStored] = useStoredGame("colorswitch", { best: 0 });

  // Difficulty: live, mirrored to refs for the animation loop.
  const [speed, setSpeed] = useState(SPEED_START);
  const [spacing, setSpacing] = useState(SPACING_START);
  const [hspeed, setHspeed] = useState(HSPEED_START);
  const speedRef = useRef(speed);
  const spacingRef = useRef(spacing);
  const hspeedRef = useRef(hspeed);
  speedRef.current = speed;
  spacingRef.current = spacing;
  hspeedRef.current = hspeed;

  const [lastRamp, setLastRamp] = useState<{ type: RampType; key: number } | null>(
    null,
  );
  const [pass, setPass] = useState<{ key: number; x: number; color: string; perfect: boolean } | null>(
    null,
  );
  const [sparks, setSparks] = useState<Spark[]>([]);

  const lastTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const idRef = useRef(0);
  const handledRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Combo, shields, threads-cleared, and difficulty tier live in refs as the
  // authority (the collision effect mutates them synchronously); state mirrors
  // them for display.
  const comboRef = useRef(0);
  const shieldsRef = useRef(0);
  const threadsRef = useRef(0);
  const tierRef = useRef(0);
  const patternRef = useRef<{ type: PatternType; remaining: number; runShape: ShapeName; zig: 1 | -1 }>(
    { type: "random", remaining: 0, runShape: SHAPES[0], zig: 1 },
  );
  const dragRef = useRef<{ startX: number; lastX: number; moved: boolean; id: number } | null>(null);
  const shakeElRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  // ---- Audio: a lazy WebAudio context + tiny synthesised blips ----
  const ensureAudio = () => {
    if (typeof window === "undefined") return null;
    if (!audioRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctx) audioRef.current = new Ctx();
    }
    if (audioRef.current?.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  };
  const blip = (freq: number, dur: number, type: OscillatorType, gain = 0.14) => {
    if (mutedRef.current) return;
    const ctx = audioRef.current;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + dur);
  };
  const soundPass = (c: number) =>
    blip(294 * Math.pow(2, Math.min(c - 1, 14) / 12), 0.16, "triangle");
  const soundPerfect = (c: number) => {
    blip(392 * Math.pow(2, Math.min(c - 1, 14) / 12), 0.14, "triangle", 0.13);
    blip(587 * Math.pow(2, Math.min(c - 1, 14) / 12), 0.2, "sine", 0.1);
  };
  const soundMiss = () => blip(140, 0.32, "sawtooth", 0.16);
  const soundShield = () => blip(220, 0.18, "square", 0.12);

  const vibrate = (ms: number | number[]) => {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(ms);
  };
  const shake = () => {
    shakeElRef.current?.animate(
      [
        { transform: "translate(0,0)" },
        { transform: "translate(-6px,3px)" },
        { transform: "translate(5px,-4px)" },
        { transform: "translate(-4px,2px)" },
        { transform: "translate(0,0)" },
      ],
      { duration: 260, easing: "ease-out" },
    );
  };

  // ---- Spawning: pattern-driven ribbons ----
  const rollPattern = () => {
    const r = Math.random();
    const type: PatternType =
      r < 0.5 ? "random" : r < 0.68 ? "run" : r < 0.84 ? "zigzag" : "double";
    patternRef.current = {
      type,
      remaining: type === "double" ? 2 + randInt(2) : type === "random" ? 2 + randInt(3) : 3 + randInt(3),
      runShape: randomFrom(SHAPES),
      zig: Math.random() < 0.5 ? 1 : -1,
    };
  };

  const at = (frac: number) => X_MIN + frac * (X_MAX - X_MIN);

  function nextRibbon(y: number): Ribbon {
    const p = patternRef.current;
    if (p.remaining <= 0) rollPattern();
    const pat = patternRef.current;
    pat.remaining--;
    const id = idRef.current++;

    if (pat.type === "double") {
      const beadLeft = Math.random() < 0.5;
      return {
        id,
        y,
        holes: [
          { shape: pat.runShape, x: at(0.22), dir: 1, drift: false, bead: beadLeft },
          { shape: pat.runShape, x: at(0.78), dir: -1, drift: false, bead: !beadLeft },
        ],
      };
    }
    const shape = pat.type === "run" ? pat.runShape : randomFrom(SHAPES);
    let x: number;
    if (pat.type === "zigzag") {
      x = pat.zig > 0 ? at(0.24) : at(0.76);
      pat.zig = pat.zig > 0 ? -1 : 1;
    } else {
      x = X_MIN + Math.random() * (X_MAX - X_MIN);
    }
    return {
      id,
      y,
      holes: [{ shape, x, dir: Math.random() < 0.5 ? -1 : 1, drift: true, bead: Math.random() < BEAD_CHANCE }],
    };
  }

  function seedRibbons(): Ribbon[] {
    idRef.current = 0;
    handledRef.current = new Set();
    patternRef.current = { type: "random", remaining: 0, runShape: SHAPES[0], zig: 1 };
    return Array.from({ length: 5 }, (_, i) => nextRibbon(-SPACING_START * (i + 1)));
  }

  const cycleShape = () =>
    setAvatarShape((s) => SHAPES[(SHAPES.indexOf(s) + 1) % SHAPES.length]);
  const moveAvatar = (dx: number) =>
    setAvatarX((x) => clamp(x + dx, AVATAR_X_MIN, AVATAR_X_MAX));

  const startGame = () => {
    comboRef.current = 0;
    shieldsRef.current = 0;
    threadsRef.current = 0;
    tierRef.current = 0;
    setCombo(0);
    setShields(0);
    setStitches([]);
    setRibbons(seedRibbons());
    setPhase("playing");
  };

  const reset = () => {
    setAvatarShape(SHAPES[0]);
    setAvatarX(50);
    setScore(0);
    setSpeed(SPEED_START);
    setSpacing(SPACING_START);
    setHspeed(HSPEED_START);
    setPass(null);
    setSparks([]);
    lastTimeRef.current = null;
    startGame();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phaseRef.current === "gameover") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    ensureAudio();
    if (phaseRef.current === "idle") {
      setScore(0);
      startGame();
    }
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
    if (!d.moved) cycleShape();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === "gameover") {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          reset();
        }
        return;
      }
      const start = () => {
        ensureAudio();
        if (phaseRef.current === "idle") {
          setScore(0);
          startGame();
        }
      };
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

  // Movement loop: scroll ribbons + stitches down, drift holes, spawn ribbons.
  useEffect(() => {
    const step = (t: number) => {
      if (lastTimeRef.current !== null && phaseRef.current === "playing") {
        const dt = Math.min((t - lastTimeRef.current) / 1000, MAX_DT);
        const v = speedRef.current;
        const gap = spacingRef.current;
        const hv = hspeedRef.current;
        setRibbons((prev) => {
          const moved = prev
            .map((r) => ({
              ...r,
              y: r.y + v * dt,
              holes: r.holes.map((h) => {
                if (!h.drift) return h;
                let x = h.x + h.dir * hv * dt;
                let dir = h.dir;
                if (x < X_MIN) {
                  x = X_MIN;
                  dir = 1;
                } else if (x > X_MAX) {
                  x = X_MAX;
                  dir = -1;
                }
                return { ...h, x, dir };
              }),
            }))
            .filter((r) => r.y < 118);
          const top = moved[moved.length - 1];
          if (!top || top.y > -gap) moved.push(nextRibbon(top ? top.y - gap : -gap));
          return moved;
        });
        setStitches((prev) =>
          prev.map((s) => ({ ...s, y: s.y + v * dt })).filter((s) => s.y < 122),
        );
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

  const burstSparks = (colors: string[], n: number) => {
    setSparks(
      Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        const d = 34 + Math.random() * 30;
        return {
          id: idRef.current * 100 + i,
          dx: Math.cos(a) * d,
          dy: Math.sin(a) * d,
          color: colors[i % colors.length],
        };
      }),
    );
  };

  // Collision + scoring, resolved once per ribbon as it crosses the aim line.
  useEffect(() => {
    if (phase !== "playing") return;
    const crossed = ribbons.filter(
      (r) => !handledRef.current.has(r.id) && r.y >= COLLISION_Y,
    );
    if (crossed.length === 0) return;

    let comboNow = comboRef.current;
    let sh = shieldsRef.current;
    let scoreAdd = 0;
    let passCount = 0;
    let anyPerfect = false;
    let anyBead = false;
    let missed = false;
    let lastHitX = avatarX;
    const fresh: Stitch[] = [];

    for (const r of crossed) {
      handledRef.current.add(r.id);
      const hit = r.holes.find(
        (h) => h.shape === avatarShape && Math.abs(avatarX - h.x) <= PASS_TOLERANCE,
      );
      if (hit) {
        comboNow++;
        passCount++;
        const perfect = Math.abs(avatarX - hit.x) <= PERFECT_TOLERANCE;
        let pts = comboNow * (perfect ? 2 : 1);
        if (hit.bead) {
          pts += BEAD_BONUS;
          anyBead = true;
        }
        if (perfect) anyPerfect = true;
        scoreAdd += pts;
        lastHitX = hit.x;
        fresh.push({ id: idRef.current * 1000 + r.id, x: hit.x, y: AVATAR_Y });
        if (comboNow % SHIELD_EVERY === 0) sh = Math.min(SHIELD_MAX, sh + 1);
      } else {
        missed = true;
      }
    }

    if (passCount > 0) {
      threadsRef.current += passCount;
      setScore((s) => s + scoreAdd);
      setStitches((st) => [...fresh, ...st].slice(0, 36));
      const col = comboColor(comboNow);
      setPass({ key: Date.now(), x: lastHitX, color: col, perfect: anyPerfect });
      burstSparks(
        anyBead ? ["#ffffff", "#fde047", col] : [col, "#ffffff"],
        anyPerfect ? 14 : anyBead ? 12 : 9,
      );
      if (anyPerfect) soundPerfect(comboNow);
      else soundPass(comboNow);
      vibrate(anyPerfect ? 18 : 8);
    }

    if (missed) {
      if (sh > 0) {
        sh -= 1;
        comboNow = 0;
        soundShield();
        vibrate([12, 30, 12]);
        shake();
      } else {
        comboNow = 0;
        setPhase("gameover");
        soundMiss();
        vibrate([30, 40, 60]);
        shake();
      }
    }

    // Difficulty: ramp per RAMP_EVERY threads.
    const tier = Math.floor(threadsRef.current / RAMP_EVERY);
    if (tier > tierRef.current) {
      tierRef.current = tier;
      const opts: RampType[] = [];
      if (speedRef.current < SPEED_MAX) opts.push("speed");
      if (spacingRef.current > SPACING_MIN) opts.push("spacing");
      if (hspeedRef.current < HSPEED_MAX) opts.push("hspeed");
      if (opts.length) {
        const rt = randomFrom(opts);
        if (rt === "speed") setSpeed((s) => Math.min(s + SPEED_STEP, SPEED_MAX));
        else if (rt === "spacing") setSpacing((s) => Math.max(s - SPACING_STEP, SPACING_MIN));
        else setHspeed((s) => Math.min(s + HSPEED_STEP, HSPEED_MAX));
        setLastRamp({ type: rt, key: Date.now() });
      }
    }

    comboRef.current = comboNow;
    shieldsRef.current = sh;
    setCombo(comboNow);
    setShields(sh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ribbons, avatarShape, avatarX, phase]);

  // Clear transient flashes.
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
    const t = setTimeout(() => setSparks([]), 620);
    return () => clearTimeout(t);
  }, [sparks]);

  useEffect(() => {
    if (phase === "gameover") setStored((s) => ({ best: Math.max(s.best, score) }));
  }, [phase, score, setStored]);

  const st = SHAPE_STYLE[avatarShape];
  const avatarStyle: CSSProperties = {
    left: `${avatarX}%`,
    top: `${AVATAR_Y}%`,
    height: `${AVATAR_SIZE}%`,
    filter: `drop-shadow(0 0 6px rgba(${st.glow}, 0.6))`,
  };
  const threadColor = comboColor(combo);
  // Thread polyline: from the needle down through every stitched hole.
  const threadPoints = [
    `${avatarX},${AVATAR_Y}`,
    ...[...stitches]
      .sort((a, b) => a.y - b.y)
      .map((s) => `${s.x},${s.y}`),
  ].join(" ");
  const glowAlpha = Math.min(0.42, combo * 0.03);

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="text-center">
          <h1 className="bg-gradient-to-r from-amber-300 via-sky-400 to-fuchsia-400 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            <Trans id="colorswitch.title" message="Threader 🪡" />
          </h1>
        </header>

        <div className="flex min-h-0 flex-1 items-start justify-center">
          {/* Sized by WIDTH (like Snake) so aspect-[3/4] holds in portrait. */}
          <div
            onPointerDown={phase === "gameover" ? undefined : onPointerDown}
            onPointerMove={phase === "gameover" ? undefined : onPointerMove}
            onPointerUp={phase === "gameover" ? undefined : onPointerUp}
            className={`relative aspect-[3/4] w-full max-h-full overflow-hidden rounded-2xl bg-gradient-to-b from-slate-950 to-neutral-950 ring-1 ring-white/5 select-none touch-none ${
              phase === "gameover" ? "" : "cursor-pointer"
            }`}
          >
            {/* Combo glow rising from the aim line. */}
            <div
              className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
              style={{
                opacity: glowAlpha > 0 ? 1 : 0,
                background: `radial-gradient(60% 40% at 50% ${AVATAR_Y}%, ${threadColor}${Math.round(
                  glowAlpha * 255,
                )
                  .toString(16)
                  .padStart(2, "0")} 0%, transparent 70%)`,
              }}
              aria-hidden="true"
            />

            {/* Everything that should shake on a hit lives in here. */}
            <div ref={shakeElRef} className="absolute inset-0">
              {/* Sewn thread — z-[5], behind the ribbons, so it shows through
                  holes and ducks behind the bands: genuinely threaded. */}
              {stitches.length > 0 && (
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="absolute inset-0 z-[5] h-full w-full"
                  aria-hidden="true"
                >
                  <polyline
                    points={threadPoints}
                    fill="none"
                    stroke={threadColor}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    style={{ filter: `drop-shadow(0 0 3px ${threadColor})` }}
                  />
                </svg>
              )}

              {/* Bottom halves — z-10, behind the avatar. */}
              <div className="absolute inset-0 z-10" aria-hidden="true">
                {ribbons.map((r) => (
                  <RibbonHalf key={r.id} id={r.id} holes={r.holes} y={r.y} half="bottom" />
                ))}
              </div>

              {/* Avatar — z-20, woven between the ribbon halves. */}
              <div
                className="absolute z-20 aspect-square -translate-x-1/2 -translate-y-1/2"
                style={avatarStyle}
              >
                <svg viewBox="0 0 10 10" className="h-full w-full overflow-visible" aria-hidden="true">
                  <defs>
                    <linearGradient id="avatar-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor={st.from} />
                      <stop offset="1" stopColor={st.to} />
                    </linearGradient>
                  </defs>
                  <polygon points={SHAPE_POINTS[avatarShape]} fill="url(#avatar-grad)" />
                </svg>
              </div>

              {/* Top halves — z-30, in front of the avatar. */}
              <div className="absolute inset-0 z-30" aria-hidden="true">
                {ribbons.map((r) => (
                  <RibbonHalf key={r.id} id={r.id} holes={r.holes} y={r.y} half="top" />
                ))}
              </div>

              {/* Beads — z-[35], collectibles sitting in their holes. */}
              <div className="absolute inset-0 z-[35]" aria-hidden="true">
                {ribbons.flatMap((r) =>
                  r.holes
                    .filter((h) => h.bead)
                    .map((h, i) => (
                      <div
                        key={`${r.id}-${i}`}
                        className="absolute aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
                        style={{
                          left: `${h.x}%`,
                          top: `${r.y}%`,
                          height: `${AVATAR_SIZE * 0.42}%`,
                          boxShadow: "0 0 8px 2px rgba(253,224,71,0.9)",
                        }}
                      />
                    )),
                )}
              </div>

              {/* Validation burst — ring + sparks in the threaded colour. */}
              {pass && (
                <div
                  key={pass.key}
                  className="pointer-events-none absolute z-40 aspect-square -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${pass.x}%`,
                    top: `${AVATAR_Y}%`,
                    height: `${pass.perfect ? RIBBON_HEIGHT * 1.35 : RIBBON_HEIGHT}%`,
                  }}
                  aria-hidden="true"
                >
                  <div
                    className="h-full w-full animate-thread-ring rounded-full border-2"
                    style={{ borderColor: pass.color, boxShadow: `0 0 12px ${pass.color}` }}
                  />
                  {pass.perfect && (
                    <span
                      className="animate-fade-in absolute -top-5 left-1/2 -translate-x-1/2 text-xs font-black uppercase tracking-wider [text-shadow:_0_1px_3px_rgb(0_0_0_/_70%)]"
                      style={{ color: pass.color }}
                    >
                      <Trans id="colorswitch.perfect" message="Perfect" />
                    </span>
                  )}
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
            </div>

            {/* Aim line — z-40, always visible. */}
            <div
              className="absolute inset-x-0 z-40 border-t border-dashed border-white/15"
              style={{ top: `${AVATAR_Y}%` }}
              aria-hidden="true"
            />

            {/* HUD: shields (left), mute (right). */}
            <div className="absolute top-3 left-3 z-50 flex gap-1" aria-hidden="true">
              {Array.from({ length: shields }, (_, i) => (
                <span
                  key={i}
                  className="text-lg [text-shadow:_0_1px_3px_rgb(0_0_0_/_70%)]"
                >
                  🛡️
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="absolute top-3 right-3 z-50 text-xl opacity-70 transition hover:opacity-100"
              aria-label="Toggle sound"
            >
              {muted ? "🔇" : "🔊"}
            </button>

            {/* Score + combo + ramp flash. */}
            <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex flex-col items-center text-white [text-shadow:_0_2px_4px_rgb(0_0_0_/_60%)]">
              <div className="flex items-center gap-2">
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
                  >
                    {RAMP_BADGE[lastRamp.type].glyph}
                  </span>
                )}
              </div>
              {combo > 1 && (
                <span
                  key={combo}
                  className="motion-safe:animate-rps-tick text-lg font-black tabular-nums"
                  style={{ color: threadColor }}
                >
                  ×{combo}
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
                        className="rounded-full bg-gradient-to-r from-amber-300 via-sky-400 to-fuchsia-500 px-8 py-3 text-lg font-semibold text-neutral-950 transition hover:opacity-90 active:scale-95"
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
