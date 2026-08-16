import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PeriodProvider } from "./period";
import "./globals.css";

export const metadata: Metadata = {
  title: "Token Tracker",
  description: "Local Oh My Pi token usage and spending dashboard",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PeriodProvider>{children}</PeriodProvider>
      </body>
    </html>
  );
}
