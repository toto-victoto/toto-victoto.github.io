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
  colorswitch: { best: number };
  rps: { player: number; cpu: number };
  roulette: { best: number; balance: number; history: number[] };
  morpion: {
    mode: "2p" | "ai";
    scores: { X: number; O: number; draws: number };
    placements: { player: Player; index: number }[];
    turn: Player;
    startedBy: Player;
    turnCount: number;
    winner: Player | null;
    winLine: number[] | null;
  };
};

type Stored = Partial<Persisted> & { schema?: number };
type GameKey = keyof Persisted;

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
