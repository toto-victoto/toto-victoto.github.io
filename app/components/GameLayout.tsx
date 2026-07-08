import type { ReactNode } from "react";

// Shared shell for every mini-game: pins the page to the dynamic viewport
// height (so the LanguageSelector can never jiggle from a scrollbar coming
// and going), centers a column that fills the phone screen edge-to-edge,
// and caps width at max-w-md on bigger screens.
//
// Children stack vertically with a small gap. The section that holds the
// playfield should be marked `flex-1 min-h-0` so it absorbs whatever
// vertical space the other rows leave behind; everything else (header,
// scores, status bar, footer controls) is sized by content.
// `tint` is an optional gradient-overlay class (e.g. a boss arena wash) painted
// over the base background but behind the content.
export function GameLayout({ children, tint }: { children: ReactNode; tint?: string }) {
  return (
    <main className="relative flex h-dvh flex-col overflow-hidden bg-neutral-950 px-3 pt-14 pb-2 text-neutral-100">
      {tint && <div className={`pointer-events-none absolute inset-0 ${tint}`} aria-hidden="true" />}
      <div className="relative z-10 mx-auto flex w-full min-h-0 max-w-md flex-1 flex-col gap-2">
        {children}
      </div>
    </main>
  );
}
