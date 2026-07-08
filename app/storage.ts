import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

// Single localStorage key holding per-game state in one JSON dict. Bumping
// the schema version invalidates any older saved blob so we never feed an
// out-of-shape value into the wrong slot.
const KEY = "tv:state";
const SCHEMA_VERSION = 1;

type Player = "X" | "O";

export type Persisted = {
  snake: { best: number };
  flappy: { best: number };
  threader: { best: number };
  rps: {
    bestLevel: number;
    // Best "infinite" run, measured as levels reached past the roster.
    infiniteBest?: number;
    // In-progress run, snapshotted whenever the player is at the move-choice
    // screen, so a refresh mid-fight resumes instead of restarting. The foe is
    // stored whole (its stats/flavor are randomized, so it can't be regenerated).
    save?: {
      mode: "story" | "infinite";
      player: { maxHp: number; str: number; def: number; agi: number; dex: number };
      hp: number;
      level: number;
      foeIndex: number;
      foe: {
        key: string;
        emoji: string;
        name: string;
        cryId: string;
        cry: string;
        wordsId: string;
        lastWords: string;
        tier?: "semiboss" | "boss" | "hidden";
        maxHp: number;
        str: number;
        def: number;
        agi: number;
        dex: number;
      };
      foeHp: number;
      mults: { rock: number; paper: number; scissors: number };
      anchor: "rock" | "paper" | "scissors" | null;
    };
  };
  roulette: { best: number; balance: number; history: number[] };
  ultimate: {
    mode: "2p" | "ai";
    scores: { X: number; O: number; draws: number };
    board: (Player | null)[];
    subWinners: (Player | "draw" | null)[];
    turn: Player;
    startedBy: Player;
    nextSub: number | null;
    winner: Player | null;
    winLine: number[] | null;
  };
  trias: { best: number; marathonBest: number; timeAttackBest: number };
};

type Stored = Partial<Persisted> & { schema?: number };
type GameKey = keyof Persisted;

// Runtime list of the games that still exist. Keep in sync with Persisted; any
// stored key not in here is dead data (a removed/renamed game) and gets pruned.
const GAME_KEYS = [
  "snake",
  "flappy",
  "threader",
  "rps",
  "roulette",
  "ultimate",
  "trias",
] as const satisfies readonly GameKey[];

function readAll(): Stored {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Stored;
    if (parsed.schema !== SCHEMA_VERSION) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeAll(state: Stored): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...state, schema: SCHEMA_VERSION }),
    );
  } catch {
    // Storage full or disabled (Safari private mode) — silently skip.
  }
}

// Drop saved data for games that no longer exist (removed or renamed). Called
// on home load so stale keys — e.g. an old game's slot or a pre-rename name —
// don't linger forever. No-op when there's nothing to clean.
export function pruneStorage(): void {
  if (typeof window === "undefined") return;
  const all = readAll();
  const known = new Set<string>(GAME_KEYS);
  let changed = false;
  for (const key of Object.keys(all)) {
    if (key === "schema" || known.has(key)) continue;
    delete (all as Record<string, unknown>)[key];
    changed = true;
  }
  if (changed) writeAll(all);
}

// Read a game's saved slot as-is (no defaults merge) — for read-only surfaces
// like the records table that only want whatever fields happen to be there.
export function peekGame<K extends GameKey>(game: K): Persisted[K] | undefined {
  return readAll()[game] as Persisted[K] | undefined;
}

// Wipe one game's saved slot (its scores, balance, in-progress state). Used by
// the per-game "reset" controls.
export function clearGame(game: string): void {
  const all = readAll();
  if (game in all) {
    delete (all as Record<string, unknown>)[game];
    writeAll(all);
  }
}

export function loadGame<K extends GameKey>(
  game: K,
  defaults: Persisted[K],
): Persisted[K] {
  const all = readAll();
  const stored = all[game] as Persisted[K] | undefined;
  if (!stored) return defaults;
  // Shallow merge so fields added later fall back to defaults.
  return { ...defaults, ...stored };
}

export function saveGame<K extends GameKey>(
  game: K,
  state: Persisted[K],
): void {
  const all = readAll();
  all[game] = state;
  writeAll(all);
}

// Convenience hook for games whose component state matches the persisted
// shape one-for-one. Initial render returns `defaults` so the prerendered
// HTML stays stable; the first effect hydrates from localStorage and every
// subsequent state change writes back.
export function useStoredGame<K extends GameKey>(
  game: K,
  defaults: Persisted[K],
): [Persisted[K], Dispatch<SetStateAction<Persisted[K]>>] {
  const [state, setState] = useState<Persisted[K]>(defaults);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(loadGame(game, defaults));
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveGame(game, state);
  }, [hydrated, game, state]);

  return [state, setState];
}
