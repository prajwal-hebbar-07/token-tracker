"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections: Array<{ href: string; label: string }> = [
  { href: "/", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="appNav" aria-label="Sections">
      {sections.map((section) => {
        const active = pathname === section.href;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={active ? "active" : undefined}
            href={section.href}
            key={section.href}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
