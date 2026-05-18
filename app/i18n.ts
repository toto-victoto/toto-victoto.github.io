import { i18n } from "@lingui/core";
import { messages as enMessages } from "./locales/en/messages.po";
import { messages as frMessages } from "./locales/fr/messages.po";

export const locales = {
  en: "English",
  fr: "Français",
} as const;

export type Locale = keyof typeof locales;

export const defaultLocale: Locale = "en";

i18n.load({
  en: enMessages,
  fr: frMessages,
});
i18n.activate(defaultLocale);

export function activate(locale: Locale) {
  i18n.activate(locale);
}

export { i18n };
