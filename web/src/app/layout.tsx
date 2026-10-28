import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClientEffects } from "@/components/ClientEffects";
import { GameProvider } from "@/components/GameProvider";
import { Shell } from "@/components/Shell";
import { THEME_BOOT_SCRIPT } from "@/lib/prefs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stonker",
  description: "Trade your friends with play money.",
  applicationName: "Stonker",
  appleWebApp: { capable: true, title: "Stonker", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  // Updated to the active theme by THEME_BOOT_SCRIPT / applyTheme.
  themeColor: "#0e1116",
  // Lets the bottom tab bar sit above the iPhone home indicator (env(safe-area-inset-*)).
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The boot script sets data-theme before React hydrates.
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ClientEffects />
        <GameProvider>
          <Shell>{children}</Shell>
        </GameProvider>
      </body>
    </html>
  );
}
