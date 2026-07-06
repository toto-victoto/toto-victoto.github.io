// Single source of truth for the games and their order — used by both the home
// grid and the About records table. Ordered roughly by rising complexity, from
// the one-tap reflex games up to the deep-mechanics ones. `slug` doubles as the
// route path and the localStorage key.
export type GameMeta = {
  slug: string;
  titleId: string; // Lingui message id
  title: string; // English default / fallback
  tone: string; // home tile gradient
  icon: string; // home tile emoji
};

export const GAMES: GameMeta[] = [
  {
    slug: "flappy",
    titleId: "flappy.title",
    title: "Flappy",
    tone: "bg-gradient-to-br from-sky-400 to-blue-600",
    icon: "🐤",
  },
  {
    slug: "snake",
    titleId: "snake.title",
    title: "Snake",
    tone: "bg-gradient-to-br from-emerald-400 to-green-700",
    icon: "🐍",
  },
  {
    slug: "threader",
    titleId: "threader.title",
    title: "Threader",
    tone: "bg-gradient-to-br from-amber-400 to-sky-500",
    icon: "🪡",
  },
  {
    slug: "roulette",
    titleId: "roulette.title",
    title: "Roulette",
    tone: "bg-gradient-to-br from-rose-500 to-red-700",
    icon: "🎰",
  },
  {
    slug: "rps",
    titleId: "rps.title",
    title: "RPS Saga",
    tone: "bg-gradient-to-br from-amber-400 to-orange-600",
    icon: "✊",
  },
  {
    slug: "ultimate",
    titleId: "ultimate.title",
    title: "Ultimate Tic-Tac-Toe",
    tone: "bg-gradient-to-br from-violet-500 to-purple-700",
    icon: "🎯",
  },
  {
    slug: "trias",
    titleId: "trias.title",
    title: "Trias",
    tone: "bg-gradient-to-br from-fuchsia-500 to-pink-600",
    icon: "🔻",
  },
];
