import { useEffect } from "react";
import { Trans } from "@lingui/react";
import type { Route } from "./+types/home";
import { AppIcon } from "../components/AppIcon";
import { pruneStorage } from "../storage";
import { GAMES } from "../games";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "toto-victoto" },
    { name: "description", content: "Personal home-screen showcase." },
  ];
}

export default function Home() {
  // Sweep away saved data for games that no longer exist (removed or renamed).
  useEffect(() => {
    pruneStorage();
  }, []);

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
          {GAMES.map((g) => (
            <AppIcon
              key={g.slug}
              to={`/${g.slug}`}
              label={<Trans id={g.titleId} message={g.title} />}
              tone={g.tone}
            >
              <span aria-hidden="true">{g.icon}</span>
            </AppIcon>
          ))}

          <AppIcon
            to="/about"
            label={<Trans id="home.app.about" message="About" />}
            tone="bg-gradient-to-br from-slate-500 to-slate-700"
          >
            <span className="text-white font-light italic leading-none">i</span>
          </AppIcon>
        </div>
      </div>
    </main>
  );
}
