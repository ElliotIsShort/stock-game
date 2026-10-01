import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GameProvider } from "@/components/GameProvider";
import { Shell } from "@/components/Shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Friend Stock Market",
  description: "Trade your friends with play money.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <GameProvider>
          <Shell>{children}</Shell>
        </GameProvider>
      </body>
    </html>
  );
}
