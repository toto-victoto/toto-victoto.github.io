import { Trans } from "@lingui/react";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "toto-victoto" },
    { name: "description", content: "Personal home-screen showcase." },
  ];
}

export default function Home() {
  return (
    <main className="min-h-dvh bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">
        <Trans id="home.title" message="toto-victoto" />
      </h1>
      <p className="text-neutral-400">
        <Trans id="home.subtitle" message="Tap an app to play." />
      </p>
    </main>
  );
}
