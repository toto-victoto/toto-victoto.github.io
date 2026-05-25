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
export function GameLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-neutral-950 px-3 pt-14 pb-2 text-neutral-100">
      <div className="mx-auto flex w-full min-h-0 max-w-md flex-1 flex-col gap-2">
        {children}
      </div>
    </main>
  );
}
