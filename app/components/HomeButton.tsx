import { Link } from "react-router";
import { Trans } from "@lingui/react";
import type { ReactNode } from "react";

type Props = {
  label?: ReactNode;
};

export function HomeButton({ label }: Props) {
  return (
    <Link
      to="/"
      className="fixed top-4 left-4 z-50 flex items-center gap-1.5 text-sm text-neutral-300 hover:text-neutral-100 transition-colors"
    >
      <span aria-hidden="true" className="text-base leading-none">
        🏡
      </span>
      <span>{label ?? <Trans id="nav.home" message="Home" />}</span>
    </Link>
  );
}
