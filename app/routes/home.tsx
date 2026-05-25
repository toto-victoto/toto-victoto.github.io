import { Trans } from "@lingui/react";
import type { Route } from "./+types/home";
import { AppIcon } from "../components/AppIcon";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "toto-victoto" },
    { name: "description", content: "Personal home-screen showcase." },
  ];
}

export default function Home() {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
      <div className="max-w-2xl mx-auto">
        <header className="text-center mb-12">
          <h1 className="text-3xl font-semibold tracking-tight">
            <Trans id="home.title" message="toto-victoto" />
          </h1>
          <p className="text-neutral-400 mt-2">
            <Trans id="home.subtitle" message="Tap an app to play." />
          </p>
        </header>

        <div className="grid grid-cols-4 gap-x-4 gap-y-6">
          <AppIcon
            to="/rps"
            label={<Trans id="rps.title" message="Rock Paper Scissors" />}
            tone="bg-gradient-to-br from-amber-400 to-orange-600"
          >
            <span aria-hidden="true">✊</span>
          </AppIcon>

          <AppIcon
            to="/snake"
            label={<Trans id="snake.title" message="Snake" />}
            tone="bg-gradient-to-br from-emerald-400 to-green-700"
          >
            <span aria-hidden="true">🐍</span>
          </AppIcon>

          <AppIcon
            to="/flappy"
            label={<Trans id="flappy.title" message="Flappy" />}
            tone="bg-gradient-to-br from-sky-400 to-blue-600"
          >
            <span aria-hidden="true">🐤</span>
          </AppIcon>

          <AppIcon
            to="/roulette"
            label={<Trans id="roulette.title" message="Roulette" />}
            tone="bg-gradient-to-br from-red-500 to-green-800"
          >
            <span aria-hidden="true">🎰</span>
          </AppIcon>

          <AppIcon
            to="/morpion"
            label={<Trans id="morpion.title" message="Tic-Tac-Toe XTreme 🔥" />}
            tone="bg-gradient-to-br from-amber-400 via-orange-500 to-red-600"
          >
            <span aria-hidden="true" className="font-bold text-white">
              #
            </span>
          </AppIcon>

          <AppIcon
            to="/colorswitch"
            label={<Trans id="colorswitch.title" message="Color Switch" />}
            tone="bg-gradient-to-br from-rose-500 via-amber-400 to-emerald-500"
          >
            <span aria-hidden="true">🎨</span>
          </AppIcon>

          <AppIcon
            to="/about"
            label={<Trans id="home.app.about" message="About" />}
            tone="bg-gradient-to-br from-sky-400 to-sky-600"
          >
            <span className="text-white font-light italic leading-none">i</span>
          </AppIcon>
        </div>
      </div>
    </main>
  );
}
