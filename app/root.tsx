import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { I18nProvider } from "@lingui/react";

import type { Route } from "./+types/root";
import { i18n } from "./i18n";
import { LanguageSelector } from "./components/LanguageSelector";
import { HomeButton } from "./components/HomeButton";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={i18n.locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <I18nProvider i18n={i18n}>
          <LanguageSelector />
          {children}
        </I18nProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <>
      <HomeButton />
      <main className="min-h-dvh bg-neutral-950 text-neutral-100 p-6 pt-24 pb-12">
        <div className="max-w-prose mx-auto">
          <h1 className="text-3xl font-semibold tracking-tight">{message}</h1>
          <p className="text-neutral-400 mt-2">{details}</p>
          {stack && (
            <pre className="w-full p-4 mt-6 overflow-x-auto bg-neutral-900 rounded-lg text-xs">
              <code>{stack}</code>
            </pre>
          )}
        </div>
      </main>
    </>
  );
}
