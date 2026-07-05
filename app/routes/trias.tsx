import { useEffect, useRef, useState } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/trias";
import { BackButton } from "../components/BackButton";
import { GameLayout } from "../components/GameLayout";
import { loadGame, saveGame } from "../storage";
import { sfx } from "../sound";

// Tetris-standard playfield. Cells are nullable Tailwind background classes
// so a non-null entry already encodes the colour of the locked piece.
const COLS = 10;
const ROWS = 20;
const QUEUE_LEN = 5; // pieces shown in the Next rail
const SWIPE = 24; // px before a touch drag counts as a swipe

// Gravity speeds up geometrically: every level multiplies the *drop speed* by
// SPEEDUP_FACTOR, i.e. divides the tick by it, down to a MIN_TICK_MS floor. A
// steep factor makes the ramp brutal fast — by the short Marathon goal (L5)
// gravity is already savage. Ticks per level: 700, 438, 273, 171, 107, 67, 50…
const BASE_TICK_MS = 700; // gravity period at level 1
const SPEEDUP_FACTOR = 1.6; // drop speed ×1.6 each level (tick ÷1.6)
const MIN_TICK_MS = 50; // fastest gravity — the floor
const LINES_PER_LEVEL = 4;
const SOFT_DROP_MS = 45; // gravity period while a downward swipe is held
const LONG_PRESS_MS = 350; // hold this long without swiping to stash a piece
const HARD_DROP_POINTS = 2; // points per cell travelled on a hard drop

// Lock delay: when a piece can't fall any further it doesn't lock instantly —
// it gets a grace window so the player can still slide it into place. The
// window ticks down in real time, and every move spends an extra chunk of it
// so you can't shuffle a piece left/right forever to stall the lock.
const LOCK_DELAY_MS = 1000;
const LOCK_TICK_MS = 50;
const LOCK_MOVE_PENALTY = 150;

// Win targets for the timed/goal modes — shorter matches.
const MARATHON_MAX_LEVEL = 5;
const TIME_ATTACK_TARGET = 3000;

// Line-clear feedback: how long the cleared rows flash + fade before the stack
// collapses, the per-step bonus for chaining clears across consecutive locks (a
// combo), and the jackpot for wiping the board completely (a perfect clear).
const CLEAR_ANIM_MS = 320;
const COMBO_POINTS = 50;
const PERFECT_BONUS = 2000;

const tickForLevel = (level: number): number =>
  Math.max(MIN_TICK_MS, Math.round(BASE_TICK_MS / SPEEDUP_FACTOR ** (level - 1)));

const formatTime = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

// Points by number of lines cleared in one lock. Super-linear so stacking for
// a triple pays off — the vertical bar can clear at most 3 at once.
const LINE_POINTS = [0, 100, 300, 600];

type Cell = string | null;

type PieceKey = "I_V" | "I_H" | "L" | "J" | "GAMMA" | "THETA";

type Mode = "endless" | "marathon" | "timeattack";
const MODES: Mode[] = ["endless", "marathon", "timeattack"];

// A single confetti shard. Position is a board-relative percentage; dx/dy/rot
// are the per-particle vector the CSS keyframe animates along.
type Confetto = {
  id: number;
  left: number;
  top: number;
  dx: number;
  dy: number;
  rot: number;
  color: string;
};

const CONFETTI_COLORS = [
  "#e879f9", // fuchsia-400
  "#fcd34d", // amber-300
  "#2dd4bf", // teal-400
  "#fb7185", // rose-400
  "#a3e635", // lime-400
  "#818cf8", // indigo-400
];

// The on-board celebration shown for a clear: the line count (for Double /
// Triple), the active combo, and whether it wiped the whole board.
type Flash = { lines: number; combo: number; perfect: boolean };

// Each piece is 3 cells expressed as offsets from a chosen pivot block.
// Pivots are picked so the spawn position (top of the board) fits naturally.
// `ghost` is the dimmed landing-preview class — written as a literal so
// Tailwind's scanner generates the opacity/ring variants (it can't see
// runtime-concatenated class names).
type Piece = {
  key: PieceKey;
  shape: [number, number][];
  color: string;
  ghost: string;
};

const PIECES: Record<PieceKey, Piece> = {
  I_V: {
    key: "I_V",
    shape: [
      [0, -1],
      [0, 0],
      [0, 1],
    ],
    color: "bg-fuchsia-400",
    ghost: "bg-fuchsia-400/15 ring-1 ring-inset ring-fuchsia-400/40",
  },
  I_H: {
    key: "I_H",
    shape: [
      [-1, 0],
      [0, 0],
      [1, 0],
    ],
    color: "bg-amber-300",
    ghost: "bg-amber-300/15 ring-1 ring-inset ring-amber-300/40",
  },
  L: {
    key: "L",
    shape: [
      [0, -1],
      [0, 0],
      [1, 0],
    ],
    color: "bg-teal-400",
    ghost: "bg-teal-400/15 ring-1 ring-inset ring-teal-400/40",
  },
  J: {
    key: "J",
    shape: [
      [0, -1],
      [-1, 0],
      [0, 0],
    ],
    color: "bg-rose-400",
    ghost: "bg-rose-400/15 ring-1 ring-inset ring-rose-400/40",
  },
  GAMMA: {
    key: "GAMMA",
    shape: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    color: "bg-lime-400",
    ghost: "bg-lime-400/15 ring-1 ring-inset ring-lime-400/40",
  },
  THETA: {
    key: "THETA",
    shape: [
      [-1, 0],
      [0, 0],
      [0, 1],
    ],
    color: "bg-indigo-400",
    ghost: "bg-indigo-400/15 ring-1 ring-inset ring-indigo-400/40",
  },
};

const PIECE_KEYS = Object.keys(PIECES) as PieceKey[];

const emptyGrid = (): Cell[][] =>
  Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));

// Fisher-Yates shuffle of a fresh copy — never mutates the input.
const shuffle = (keys: PieceKey[]): PieceKey[] => {
  const a = keys.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Draw one key from the bag, refilling with a freshly shuffled full set when
// it runs dry. A bag guarantees every piece appears once per cycle — no long
// droughts or floods of a single piece the way pure random would allow.
const drawFromBag = (bag: PieceKey[]): { key: PieceKey; bag: PieceKey[] } => {
  const filled = bag.length ? bag : shuffle(PIECE_KEYS);
  const [key, ...rest] = filled;
  return { key, bag: rest };
};

// The active falling piece: just its identity (key) plus a pivot position.
// Shape and colour are *derived* from PIECES[key] — never duplicated as state,
// because they're fixed at spawn while (x, y) changes on every tick.
type Active = { key: PieceKey; x: number; y: number };

type Phase = "idle" | "playing" | "gameover" | "won";

// Everything the gravity tick reads and writes atomically lives in one object
// so a single functional setState (setGame(g => ...)) sees a consistent view
// and dodges the setInterval stale-closure trap.
type Game = {
  grid: Cell[][];
  active: Active | null;
  queue: PieceKey[];
  bag: PieceKey[]; // remaining pieces in the current 6-bag
  hold: PieceKey | null; // piece kept in reserve, or null when empty
  canHold: boolean; // false once Hold is used; re-armed when a piece locks
  lock: number | null; // ms left before a grounded piece locks; null = airborne
  combo: number; // consecutive line-clearing locks; -1 when the chain is broken
};

type Bests = { best: number; marathonBest: number; timeAttackBest: number };
const ZERO_BESTS: Bests = { best: 0, marathonBest: 0, timeAttackBest: 0 };

// Drop a fresh piece at the top-centre. y is chosen so the piece's highest
// block lands on row 0 (no negative rows on a clean spawn).
function spawn(key: PieceKey): Active {
  const minDy = Math.min(...PIECES[key].shape.map(([, dy]) => dy));
  return { key, x: Math.floor(COLS / 2), y: -minDy };
}

// Pull the front of the queue as the next active piece and top the queue back
// up from the bag. Deliberately knows nothing about canHold — both locking and
// an empty-reserve Hold deal a piece, but only locking re-arms the hold.
function dealNext(
  queue: PieceKey[],
  bag: PieceKey[],
): { active: Active; queue: PieceKey[]; bag: PieceKey[] } {
  const [nextKey, ...rest] = queue;
  const drawn = drawFromBag(bag);
  return { active: spawn(nextKey), queue: [...rest, drawn.key], bag: drawn.bag };
}

function emptyGame(): Game {
  return {
    grid: emptyGrid(),
    active: null,
    queue: [],
    bag: [],
    hold: null,
    canHold: true,
    lock: null,
    combo: -1,
  };
}

function makeGame(): Game {
  let bag: PieceKey[] = [];
  const first = drawFromBag(bag);
  bag = first.bag;
  const queue: PieceKey[] = [];
  for (let i = 0; i < QUEUE_LEN; i++) {
    const d = drawFromBag(bag);
    queue.push(d.key);
    bag = d.bag;
  }
  return {
    grid: emptyGrid(),
    active: spawn(first.key),
    queue,
    bag,
    hold: null,
    canHold: true,
    lock: null,
    combo: -1,
  };
}

// Pure validity test: is `shape` at pivot (x, y) inside the walls and clear of
// locked cells? cy < 0 is allowed (a piece may poke above the board), but we
// must not index grid[-1], so the occupancy check is guarded on cy >= 0.
function collides(
  grid: Cell[][],
  shape: [number, number][],
  x: number,
  y: number,
): boolean {
  for (const [dx, dy] of shape) {
    const cx = x + dx;
    const cy = y + dy;
    if (cx < 0 || cx >= COLS || cy >= ROWS) return true;
    if (cy >= 0 && grid[cy][cx] !== null) return true;
  }
  return false;
}

// Stamp the active piece into a copy of the grid where it sits. Pure — no
// line clearing yet, so the full rows can be flashed before they collapse.
function placePiece(g: Game): Cell[][] {
  const active = g.active!;
  const { shape, color } = PIECES[active.key];
  const grid = g.grid.map((row) => row.slice());
  for (const [dx, dy] of shape) {
    const cy = active.y + dy;
    const cx = active.x + dx;
    if (cy >= 0) grid[cy][cx] = color;
  }
  return grid;
}

// Row indices that are completely filled.
const fullRows = (grid: Cell[][]): number[] => {
  const rows: number[] = [];
  for (let y = 0; y < ROWS; y++) {
    if (grid[y].every((c) => c !== null)) rows.push(y);
  }
  return rows;
};

// Drop the given rows out of the grid; survivors fall and blank rows refill the
// lost height at the TOP.
const compact = (grid: Cell[][], rows: number[]): Cell[][] => {
  const gone = new Set(rows);
  const kept = grid.filter((_, y) => !gone.has(y));
  const lost = ROWS - kept.length;
  return [
    ...Array.from({ length: lost }, () => Array<Cell>(COLS).fill(null)),
    ...kept,
  ];
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Trias — toto-victoto" },
    {
      name: "description",
      content:
        "Trias: a Tetris-like with triamino pieces (three blocks each), translation-only — no rotation.",
    },
  ];
}

// Mode name / goal as translatable fragments — pulled out so the start screen
// and the win screen can render them without duplicating the switch.
function ModeName({ m }: { m: Mode }) {
  if (m === "endless") return <Trans id="trias.mode.endless" message="Endless" />;
  if (m === "marathon")
    return <Trans id="trias.mode.marathon" message="Marathon" />;
  return <Trans id="trias.mode.timeattack" message="Time Attack" />;
}

function ModeGoal({ m }: { m: Mode }) {
  if (m === "endless")
    return (
      <Trans id="trias.goal.endless" message="Climb as high as you can" />
    );
  if (m === "marathon")
    return (
      <Trans
        id="trias.goal.marathon"
        message="Reach level {max}"
        values={{ max: MARATHON_MAX_LEVEL }}
      />
    );
  return (
    <Trans
      id="trias.goal.timeattack"
      message="Reach {target} points"
      values={{ target: TIME_ATTACK_TARGET }}
    />
  );
}

// Render a piece into a 3×3 preview cell, centred on its bounding box.
// Used for the Hold slot and each entry of the Next queue.
function PiecePreview({
  piece,
  highlight,
}: {
  piece: Piece | null;
  highlight?: boolean;
}) {
  const ringClass = highlight
    ? "ring-2 ring-emerald-500"
    : "ring-1 ring-neutral-800";
  if (!piece) {
    return (
      <div
        className={`aspect-square rounded bg-neutral-900/60 ${ringClass}`}
      />
    );
  }
  const xs = piece.shape.map(([dx]) => dx);
  const ys = piece.shape.map(([, dy]) => dy);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const cells = Array.from({ length: 3 }, () =>
    Array<boolean>(3).fill(false),
  );
  for (const [dx, dy] of piece.shape) {
    cells[dy - minY][dx - minX] = true;
  }
  return (
    <div
      className={`grid aspect-square grid-cols-3 grid-rows-3 gap-px rounded bg-neutral-900 p-0.5 ${ringClass}`}
    >
      {cells.flatMap((row, y) =>
        row.map((filled, x) => (
          <div
            key={`${y}-${x}`}
            className={`aspect-square rounded-sm ${filled ? piece.color : ""}`}
          />
        )),
      )}
    </div>
  );
}

export default function Trias() {
  // Seeded empty on first render so the prerendered HTML is deterministic; the
  // random pieces are generated client-side once a mode is chosen.
  const [game, setGame] = useState<Game>(emptyGame);
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<Mode>("endless");
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [elapsed, setElapsed] = useState(0); // ms since the run started
  const [bests, setBests] = useState<Bests>(ZERO_BESTS);
  const [hydrated, setHydrated] = useState(false);
  // True while a downward swipe is held — speeds up gravity until release.
  const [softDrop, setSoftDrop] = useState(false);
  // Rows mid-clear: rendered flashing/fading while the stack waits to collapse.
  const [clearingRows, setClearingRows] = useState<number[]>([]);
  // Live confetti shards raining from a recent clear.
  const [confetti, setConfetti] = useState<Confetto[]>([]);
  // The current on-board celebration text (Double/Triple, combo, perfect clear).
  const [flash, setFlash] = useState<Flash | null>(null);
  const touchRef = useRef<{
    x: number;
    y: number;
    swiped: boolean;
    consumed: boolean;
  } | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef(0); // timestamp the current run began
  const confettiId = useRef(0); // monotonic key source for confetti shards

  // Level climbs with cleared lines and drives the gravity speed.
  const level = Math.floor(lines / LINES_PER_LEVEL) + 1;
  const bestForMode =
    mode === "endless"
      ? bests.best
      : mode === "marathon"
        ? bests.marathonBest
        : bests.timeAttackBest;

  // Client-only kickoff: load saved bests. We do NOT auto-start — the mode
  // picker (idle phase) waits for the player to choose.
  useEffect(() => {
    setBests(loadGame("trias", ZERO_BESTS));
    setHydrated(true);
  }, []);

  // Persist bests once hydrated, so a fresh page never clobbers storage with
  // the zero defaults before the load effect has run.
  useEffect(() => {
    if (!hydrated) return;
    saveGame("trias", bests);
  }, [hydrated, bests]);

  // Track the best score for the score-based modes as it climbs.
  useEffect(() => {
    if (mode === "timeattack") return;
    const field: keyof Bests = mode === "endless" ? "best" : "marathonBest";
    setBests((b) => (score > b[field] ? { ...b, [field]: score } : b));
  }, [score, mode]);

  // Detect a win the moment its condition is met: marathon clears at level 15,
  // time attack the instant the score target is reached (banking the time).
  useEffect(() => {
    if (phase !== "playing") return;
    if (mode === "marathon" && level >= MARATHON_MAX_LEVEL) {
      setElapsed(Date.now() - startRef.current);
      setPhase("won");
      sfx.win();
    } else if (mode === "timeattack" && score >= TIME_ATTACK_TARGET) {
      const finalMs = Date.now() - startRef.current;
      setElapsed(finalMs);
      setBests((b) =>
        b.timeAttackBest === 0 || finalMs < b.timeAttackBest
          ? { ...b, timeAttackBest: finalMs }
          : b,
      );
      setPhase("won");
      sfx.win();
    }
  }, [phase, mode, level, score]);

  // One downward step: fall a row if there's room, otherwise arm the lock
  // delay. Shared by the gravity tick and the soft drop so the descent rules
  // live in one place. Always a functional update → never a stale board.
  const stepDown = () => {
    setGame((g) => {
      if (!g.active) return g;
      const { shape } = PIECES[g.active.key];
      const ny = g.active.y + 1;
      if (!collides(g.grid, shape, g.active.x, ny)) {
        // Room to fall: descend and cancel any pending lock.
        return { ...g, active: { ...g.active, y: ny }, lock: null };
      }
      // Resting on the stack: arm the lock delay if it isn't already counting.
      // The countdown itself runs in its own effect.
      return g.lock === null ? { ...g, lock: LOCK_DELAY_MS } : g;
    });
  };

  // Slam the piece to its resting row, banking points for the distance fallen,
  // then lock immediately — a hard drop skips the lock delay.
  const hardDrop = () => {
    setGame((g) => {
      if (!g.active) return g;
      const { shape } = PIECES[g.active.key];
      let y = g.active.y;
      while (!collides(g.grid, shape, g.active.x, y + 1)) y++;
      const dist = y - g.active.y;
      if (dist > 0) setScore((s) => s + dist * HARD_DROP_POINTS);
      const dropped: Game = { ...g, active: { ...g.active, y } };
      return lockActive(dropped);
    });
  };

  // Shift left/right by dx, but only if the new position is valid. collides()
  // already bundles wall bounds *and* locked-cell overlap, so one test covers
  // both "off the edge" and "blocked by the stack". While the lock delay is
  // counting, a move spends part of the window (and re-floats the piece if the
  // shift opened a gap beneath it) so the player can't stall forever.
  const move = (dx: number) => {
    setGame((g) => {
      if (!g.active) return g;
      const { shape } = PIECES[g.active.key];
      const nx = g.active.x + dx;
      if (collides(g.grid, shape, nx, g.active.y)) return g;
      const moved: Game = { ...g, active: { ...g.active, x: nx } };
      if (g.lock !== null) {
        const canFall = !collides(g.grid, shape, nx, g.active.y + 1);
        if (canFall) {
          moved.lock = null; // a gap opened — let gravity take over again
        } else {
          moved.lock = Math.max(0, g.lock - LOCK_MOVE_PENALTY);
          if (moved.lock <= 0) return lockActive(moved); // budget spent
        }
      }
      return moved;
    });
  };

  // Swap the active piece with the reserve — at most once per piece (canHold).
  // The incoming piece always re-spawns at the top: its shape may not fit where
  // the outgoing one sat. An empty reserve deals from the queue instead, and a
  // blocked spawn tops the board out just like a lock would.
  const hold = () => {
    setGame((g) => {
      if (!g.active || !g.canHold) return g;
      const stash = g.active.key;
      if (g.hold === null) {
        const dealt = dealNext(g.queue, g.bag);
        return blockedSpawn(g, dealt.active, {
          hold: stash,
          queue: dealt.queue,
          bag: dealt.bag,
        });
      }
      return blockedSpawn(g, spawn(g.hold), { hold: stash });
    });
  };

  // Place `next` as the falling piece, carrying over the given patch, and flip
  // to game over if it spawns inside the stack. Hold stays spent (canHold:false)
  // — only a lock re-arms it. The new piece starts airborne (lock cleared).
  const blockedSpawn = (
    g: Game,
    next: Active,
    patch: Partial<Game>,
  ): Game => {
    const over = collides(g.grid, PIECES[next.key].shape, next.x, next.y);
    if (over) {
      setPhase("gameover");
      sfx.lose();
    }
    return {
      ...g,
      ...patch,
      active: over ? null : next,
      canHold: false,
      lock: null,
    };
  };

  // Spray `count` confetti shards out of the given row band. Each burst removes
  // its own shards once their animation finishes, so overlapping bursts (combo
  // chains, a clear immediately followed by a perfect) don't leak.
  const burstConfetti = (rows: number[], count: number) => {
    const mid = rows.reduce((a, b) => a + b, 0) / rows.length;
    const topPct = ((mid + 0.5) / ROWS) * 100;
    const n = Math.min(120, count);
    const shards: Confetto[] = Array.from({ length: n }, () => ({
      id: confettiId.current++,
      left: 8 + Math.random() * 84,
      top: topPct,
      dx: (Math.random() * 2 - 1) * 90,
      dy: 40 + Math.random() * 170,
      rot: (Math.random() * 2 - 1) * 600,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    }));
    const ids = new Set(shards.map((s) => s.id));
    setConfetti((prev) => [...prev, ...shards]);
    setTimeout(() => {
      setConfetti((prev) => prev.filter((p) => !ids.has(p.id)));
    }, 1000);
  };

  // Lock the active piece, then either hand straight off to the next piece (no
  // lines) or bank the score and start the clear animation (the stack collapse
  // is deferred to the resolve effect so the fade can play). Called inside a
  // setGame updater, so its score/phase side-effects batch with the board.
  const lockActive = (g: Game): Game => {
    const grid = placePiece(g);
    const rows = fullRows(grid);

    if (rows.length === 0) {
      // Nothing cleared: the combo chain breaks and the next piece comes now.
      const { active: nextA, queue, bag } = dealNext(g.queue, g.bag);
      const over = collides(grid, PIECES[nextA.key].shape, nextA.x, nextA.y);
      if (over) {
        setPhase("gameover");
        sfx.lose();
      } else {
        sfx.ui(); // soft lock tick
      }
      return {
        ...g,
        grid,
        active: over ? null : nextA,
        queue,
        bag,
        canHold: true,
        lock: null,
        combo: -1,
      };
    }

    // Lines fell: extend the combo, bank line + combo points, flash the rows.
    const combo = g.combo + 1;
    const linePts = LINE_POINTS[rows.length] ?? rows.length * 200;
    const comboPts = combo >= 1 ? combo * COMBO_POINTS : 0;
    setScore((s) => s + linePts + comboPts);
    setLines((n) => n + rows.length);
    setClearingRows(rows);
    setFlash({ lines: rows.length, combo, perfect: false });
    sfx.rise(Math.max(0, combo)); // pitch rises with the combo
    if (rows.length >= 2 || combo >= 1) {
      burstConfetti(rows, 18 + rows.length * 10 + Math.max(0, combo) * 8);
    }
    // Park the piece while the rows fade; the resolve effect finishes the job
    // (and detects a perfect clear once the stack has collapsed).
    return { ...g, grid, active: null, lock: null, combo };
  };

  // Gravity loop. The functional updater always receives the latest game, so
  // this interval never closes over a stale board. It restarts whenever the
  // tempo changes — a new level, a held soft drop, or game over.
  useEffect(() => {
    if (phase !== "playing") return;
    const period = softDrop ? SOFT_DROP_MS : tickForLevel(level);
    const id = setInterval(stepDown, period);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, level, softDrop]);

  // Lock-delay countdown. Runs whenever a piece is playing; it only acts once a
  // piece is grounded (lock !== null), ticking the window down and locking the
  // piece when it runs out.
  useEffect(() => {
    if (phase !== "playing") return;
    const id = setInterval(() => {
      setGame((g) => {
        if (g.lock === null || !g.active) return g;
        const remaining = g.lock - LOCK_TICK_MS;
        if (remaining > 0) return { ...g, lock: remaining };
        return lockActive(g);
      });
    }, LOCK_TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // After the flash plays, collapse the cleared rows and bring in the next
  // piece. Deferring the compaction is what lets the fade animation be seen,
  // and is also where a perfect clear (now-empty board) is detected & rewarded.
  useEffect(() => {
    if (clearingRows.length === 0) return;
    const id = setTimeout(() => {
      setGame((g) => {
        const grid = compact(g.grid, clearingRows);
        const perfect = grid.every((row) => row.every((c) => c === null));
        if (perfect) {
          setScore((s) => s + PERFECT_BONUS);
          setFlash((f) =>
            f
              ? { ...f, perfect: true }
              : { lines: clearingRows.length, combo: g.combo, perfect: true },
          );
          burstConfetti([Math.floor(ROWS / 2)], 110); // jackpot shower
          sfx.win();
        }
        const { active: nextA, queue, bag } = dealNext(g.queue, g.bag);
        const over = collides(grid, PIECES[nextA.key].shape, nextA.x, nextA.y);
        // Don't clobber a win that landed during the animation window.
        if (over) setPhase((p) => (p === "playing" ? "gameover" : p));
        return {
          ...g,
          grid,
          active: over ? null : nextA,
          queue,
          bag,
          canHold: true,
          lock: null,
        };
      });
      setClearingRows([]);
    }, CLEAR_ANIM_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearingRows]);

  // Auto-dismiss the celebration text; a perfect clear lingers a touch longer.
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), flash.perfect ? 1300 : 700);
    return () => clearTimeout(id);
  }, [flash]);

  // Elapsed-time ticker for the timed modes' clock. Cheap enough to run for any
  // playing mode; only the time-attack header actually shows it.
  useEffect(() => {
    if (phase !== "playing") return;
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(id);
  }, [phase]);

  // Keyboard: arrows + WASD/ZQSD to move/soft-drop, space/up to hard-drop. The
  // handlers only call functional setters, so an empty dep list is safe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
        case "a":
        case "A":
        case "q":
        case "Q":
          move(-1);
          break;
        case "ArrowRight":
        case "d":
        case "D":
          move(1);
          break;
        case "ArrowDown":
        case "s":
        case "S":
          stepDown();
          break;
        case "ArrowUp":
        case "w":
        case "W":
        case "z":
        case "Z":
        case " ":
          hardDrop();
          break;
        case "c":
        case "C":
        case "Shift":
          hold();
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

  const clearLongPress = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  // Touch model: horizontal drag = move; sustained downward swipe = soft drop
  // (fast until release); upward swipe = hard drop; long-press without moving =
  // stash to Hold; a plain tap does nothing.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, swiped: false, consumed: false };
    clearLongPress();
    longPressRef.current = setTimeout(() => {
      const a = touchRef.current;
      if (a && !a.swiped && !a.consumed) {
        hold();
        a.consumed = true;
      }
      longPressRef.current = null;
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const a = touchRef.current;
    if (!a || a.consumed) return;
    const t = e.touches[0];
    const dx = t.clientX - a.x;
    const dy = t.clientY - a.y;
    if (Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE) return;
    // Movement past the threshold means it's a drag, not a long-press.
    clearLongPress();
    a.swiped = true;
    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal: nudge one cell and re-anchor so a long drag walks the
      // piece across several columns (works while soft-dropping too).
      move(dx > 0 ? 1 : -1);
      a.x = t.clientX;
      a.y = t.clientY;
    } else if (dy < 0) {
      // Upward swipe: hard drop, and end the gesture so it fires once.
      hardDrop();
      a.consumed = true;
      setSoftDrop(false);
    } else {
      // Downward swipe: engage sustained soft drop, held until the finger
      // lifts. Re-anchor so small jitter doesn't keep retriggering.
      setSoftDrop(true);
      a.x = t.clientX;
      a.y = t.clientY;
    }
  };

  const onTouchEnd = () => {
    clearLongPress();
    setSoftDrop(false);
    touchRef.current = null;
  };

  // Begin a run in the given mode: fresh board, zeroed stats, clock started.
  const start = (m: Mode) => {
    setMode(m);
    setGame(makeGame());
    setScore(0);
    setLines(0);
    setSoftDrop(false);
    startRef.current = Date.now();
    setElapsed(0);
    setPhase("playing");
  };

  // Back to the mode picker — wipe the board so nothing shows behind the menu.
  const toModeSelect = () => {
    setGame(emptyGame());
    setSoftDrop(false);
    setPhase("idle");
  };

  // Compute the ghost landing footprint from the locked grid: drop the active
  // shape until it would collide, and remember those empty cells so the render
  // can tint them. Keyed "row-col" for O(1) lookup per cell.
  const ghost = new Map<string, string>();
  if (game.active) {
    const { shape, ghost: ghostClass } = PIECES[game.active.key];
    let gy = game.active.y;
    while (!collides(game.grid, shape, game.active.x, gy + 1)) gy++;
    for (const [dx, dy] of shape) {
      const cx = game.active.x + dx;
      const cy = gy + dy;
      if (cy >= 0 && cy < ROWS && cx >= 0 && cx < COLS)
        ghost.set(`${cy}-${cx}`, ghostClass);
    }
  }

  // Composite the falling piece onto a copy of the locked grid for display.
  const display = game.grid.map((row) => row.slice());
  if (game.active) {
    const { shape, color } = PIECES[game.active.key];
    for (const [dx, dy] of shape) {
      const cx = game.active.x + dx;
      const cy = game.active.y + dy;
      if (cy >= 0 && cy < ROWS && cx >= 0 && cx < COLS) display[cy][cx] = color;
    }
  }

  const next = game.queue.map((key) => PIECES[key]);
  const clearing = new Set(clearingRows);

  return (
    <>
      <BackButton />
      <GameLayout>
        <header className="space-y-1 text-center">
          <h1 className="bg-gradient-to-r from-fuchsia-400 via-rose-400 to-amber-300 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
            <Trans id="trias.title" message="Trias" />
          </h1>
          <div className="flex items-baseline justify-center gap-6 text-xs uppercase tracking-wider text-neutral-500">
            <div>
              <span className="text-neutral-400">
                <Trans id="trias.score" message="Score" />
              </span>{" "}
              <span className="text-base font-bold tabular-nums text-neutral-100">
                {mode === "timeattack"
                  ? `${score} / ${TIME_ATTACK_TARGET}`
                  : score}
              </span>
            </div>
            <div>
              {mode === "timeattack" ? (
                <>
                  <span className="text-neutral-400">
                    <Trans id="trias.time" message="Time" />
                  </span>{" "}
                  <span className="text-base font-bold tabular-nums text-neutral-100">
                    {formatTime(elapsed)}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-neutral-400">
                    <Trans id="trias.level" message="Level" />
                  </span>{" "}
                  <span className="text-base font-bold tabular-nums text-neutral-100">
                    {mode === "marathon"
                      ? `${level} / ${MARATHON_MAX_LEVEL}`
                      : level}
                  </span>
                </>
              )}
            </div>
            <div>
              <span className="text-neutral-400">
                <Trans id="common.best" message="Best" />
              </span>{" "}
              <span className="text-base font-bold tabular-nums text-neutral-100">
                {mode === "timeattack"
                  ? bestForMode
                    ? formatTime(bestForMode)
                    : "—"
                  : bestForMode}
              </span>
            </div>
          </div>
        </header>

        {/* The horizontal flex row holds the two rails and the board. The
            board uses aspect-[1/2] so its width derives from the available
            height — the rails are fixed-width sidekicks. Hold sits bottom-left
            (within thumb reach), Next runs down the right. */}
        <section className="flex min-h-0 flex-1 items-stretch justify-center gap-2">
          {/* Hold: bottom-aligned and tappable as an alternative to the
              long-press gesture; dimmed while spent. */}
          <aside className="flex w-12 flex-col justify-end gap-1">
            <div className="text-center text-[10px] uppercase tracking-wider text-neutral-500">
              <Trans id="trias.hold" message="Hold" />
            </div>
            <button
              type="button"
              onClick={hold}
              disabled={!game.canHold}
              className={`rounded transition active:scale-95 ${game.canHold ? "" : "opacity-40"}`}
            >
              <PiecePreview piece={game.hold ? PIECES[game.hold] : null} />
            </button>
          </aside>

          <div
            className="relative h-full aspect-[1/2] touch-none select-none"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
          >
            <div
              className="grid h-full w-full grid-cols-10 grid-rows-20 gap-px rounded bg-neutral-900 p-px ring-1 ring-neutral-800"
              style={{ touchAction: "none" }}
            >
              {display.flatMap((row, y) =>
                row.map((cell, x) => (
                  <div
                    key={`${y}-${x}`}
                    className={`aspect-square rounded-sm ${cell ?? ghost.get(`${y}-${x}`) ?? "bg-neutral-950"} ${clearing.has(y) ? "animate-trias-clear" : ""}`}
                  />
                )),
              )}
            </div>

            {/* Confetti shards rain from a cleared band — pointer-transparent so
                they never block touches. */}
            {confetti.map((p) => (
              <span
                key={p.id}
                className="pointer-events-none absolute z-10 h-1.5 w-1.5 rounded-[1px] animate-trias-confetti"
                style={
                  {
                    left: `${p.left}%`,
                    top: `${p.top}%`,
                    backgroundColor: p.color,
                    "--dx": `${p.dx}px`,
                    "--dy": `${p.dy}px`,
                    "--rot": `${p.rot}deg`,
                  } as React.CSSProperties
                }
              />
            ))}

            {flash && (
              <div className="pointer-events-none absolute inset-x-0 top-[28%] z-10 flex flex-col items-center gap-1 text-center">
                {flash.perfect && (
                  <span className="animate-fade-in text-2xl font-black text-fuchsia-300 drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)]">
                    <Trans id="trias.clear.perfect" message="Perfect clear!" />
                  </span>
                )}
                {flash.lines >= 2 && (
                  <span className="animate-fade-in text-xl font-black text-amber-300 drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
                    {flash.lines >= 3 ? (
                      <Trans id="trias.clear.triple" message="Triple" />
                    ) : (
                      <Trans id="trias.clear.double" message="Double" />
                    )}
                  </span>
                )}
                {flash.combo >= 1 && (
                  <span className="animate-fade-in text-lg font-black tabular-nums text-sky-300 drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
                    <Trans id="trias.combo" message="Combo" /> ×{flash.combo}
                  </span>
                )}
              </div>
            )}

            {phase === "idle" && (
              <div className="absolute inset-0 flex items-center justify-center rounded bg-neutral-950/85 backdrop-blur-[2px]">
                <div className="w-full max-w-[15rem] space-y-2 px-3">
                  <p className="text-center text-sm font-semibold text-neutral-200">
                    <Trans id="trias.mode.choose" message="Choose a mode" />
                  </p>
                  {MODES.map((m) => (
                    <button
                      key={m}
                      onClick={() => start(m)}
                      className="block w-full rounded-lg bg-neutral-800/80 px-3 py-2 text-left ring-1 ring-neutral-700 transition hover:bg-neutral-700/80 active:scale-[0.98]"
                    >
                      <span className="block text-sm font-semibold text-neutral-100">
                        <ModeName m={m} />
                      </span>
                      <span className="block text-[11px] text-neutral-400">
                        <ModeGoal m={m} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(phase === "gameover" || phase === "won") && (
              <div className="absolute inset-0 flex items-center justify-center rounded bg-neutral-950/75 backdrop-blur-[2px]">
                <div className="space-y-3 px-4 text-center">
                  {phase === "won" ? (
                    <p className="text-xl font-semibold text-emerald-300">
                      {mode === "marathon" ? (
                        <Trans
                          id="trias.won.marathon"
                          message="Marathon complete!"
                        />
                      ) : (
                        <Trans
                          id="trias.won.timeattack"
                          message="Target smashed!"
                        />
                      )}
                    </p>
                  ) : (
                    <p className="text-xl font-semibold text-rose-300">
                      <Trans id="trias.gameover" message="Stack overflow" />
                    </p>
                  )}
                  <p className="text-xs text-neutral-300">
                    <Trans id="trias.score" message="Score" />{" "}
                    <span className="font-semibold tabular-nums text-neutral-100">
                      {score}
                    </span>
                    {" · "}
                    <Trans id="trias.time" message="Time" />{" "}
                    <span className="font-semibold tabular-nums text-neutral-100">
                      {formatTime(elapsed)}
                    </span>
                  </p>
                  <div className="flex flex-col items-center gap-1.5">
                    <button
                      onClick={() => start(mode)}
                      className="text-sm text-sky-400 hover:underline"
                    >
                      <Trans id="common.play_again" message="Play again" />
                    </button>
                    <button
                      onClick={toModeSelect}
                      className="text-xs text-neutral-400 hover:underline"
                    >
                      <Trans id="trias.modes" message="Modes" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <aside className="flex w-12 flex-col gap-1">
            <div className="text-center text-[10px] uppercase tracking-wider text-neutral-500">
              <Trans id="trias.next" message="Next" />
            </div>
            {next.map((p, i) => (
              <PiecePreview key={i} piece={p} highlight={i === 0} />
            ))}
          </aside>
        </section>

        <p className="text-center text-xs text-neutral-500">
          <Trans
            id="trias.hint"
            message="Swipe ← → to move · hold ↓ to soft-drop · ↑ to drop · long-press to hold"
          />
        </p>
      </GameLayout>
    </>
  );
}
