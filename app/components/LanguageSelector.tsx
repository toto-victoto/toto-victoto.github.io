import { Fragment, useEffect } from "react";
import { useLingui } from "@lingui/react";
import { activate, locales, defaultLocale, type Locale } from "../i18n";

const LANG_KEY = "lang";
const SUPPORTED = Object.keys(locales) as Locale[];

const LABELS: Record<Locale, string> = {
  en: "EN",
  fr: "FR",
  "zh-CN": "中文",
};

function isSupported(value: string | null): value is Locale {
  return value !== null && (SUPPORTED as string[]).includes(value);
}

function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const fromQuery = new URL(window.location.href).searchParams.get(LANG_KEY);
  if (isSupported(fromQuery)) return fromQuery;
  const fromStorage = window.localStorage.getItem(LANG_KEY);
  if (isSupported(fromStorage)) return fromStorage;
  return defaultLocale;
}

export function LanguageSelector() {
  const { i18n } = useLingui();

  useEffect(() => {
    const initial = resolveInitialLocale();
    if (initial !== i18n.locale) activate(initial);

    const fromQuery = new URL(window.location.href).searchParams.get(LANG_KEY);
    if (isSupported(fromQuery)) {
      window.localStorage.setItem(LANG_KEY, fromQuery);
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = i18n.locale;
  }, [i18n.locale]);

  const select = (locale: Locale) => (e: React.MouseEvent) => {
    e.preventDefault();
    const url = new URL(window.location.href);
    url.searchParams.set(LANG_KEY, locale);
    window.history.replaceState({}, "", url.toString());
    window.localStorage.setItem(LANG_KEY, locale);
    activate(locale);
  };

  return (
    <nav
      aria-label="Language"
      className="fixed top-4 left-4 z-50 flex items-center gap-2 text-sm text-neutral-400"
    >
      {SUPPORTED.map((loc, i) => {
        const active = i18n.locale === loc;
        return (
          <Fragment key={loc}>
            {i > 0 && (
              <span aria-hidden="true" className="text-neutral-600">
                |
              </span>
            )}
            <a
              href={`?${LANG_KEY}=${loc}`}
              onClick={select(loc)}
              aria-current={active ? "true" : undefined}
              className={
                active
                  ? "font-bold text-neutral-100"
                  : "hover:text-neutral-200 transition-colors"
              }
            >
              {LABELS[loc]}
            </a>
          </Fragment>
        );
      })}
    </nav>
  );
}
