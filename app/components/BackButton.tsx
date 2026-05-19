import { Link } from "react-router";
import { Trans } from "@lingui/react";
import type { ReactNode } from "react";

type Props = {
  to?: string;
  label?: ReactNode;
};

export function BackButton({ to = "/", label }: Props) {
  return (
    <Link
      to={to}
      className="fixed top-4 left-4 z-50 flex items-center gap-1 text-sm text-neutral-300 hover:text-neutral-100 transition-colors"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>{label ?? <Trans id="nav.home" message="Home" />}</span>
    </Link>
  );
}
