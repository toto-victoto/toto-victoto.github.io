import { Link } from "react-router";
import type { ReactNode } from "react";

type Props = {
  label: ReactNode;
  children: ReactNode;
  tone?: string;
} & ({ to: string; href?: never } | { href: string; to?: never });

const tileBase =
  "size-16 rounded-2xl grid place-items-center text-3xl shadow-md transition-transform group-active:scale-95";

export function AppIcon({ label, children, tone, ...link }: Props) {
  const tile = (
    <span className={`${tileBase} ${tone ?? "bg-neutral-800"}`}>{children}</span>
  );
  const text = (
    <span className="text-xs text-neutral-200 text-center leading-tight max-w-16 break-words">
      {label}
    </span>
  );

  const groupClass = "group flex flex-col items-center gap-1.5";

  if ("href" in link && link.href) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={groupClass}
      >
        {tile}
        {text}
      </a>
    );
  }
  return (
    <Link to={link.to!} className={groupClass}>
      {tile}
      {text}
    </Link>
  );
}
