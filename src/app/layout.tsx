import type { Metadata, Viewport } from "next";
import { EB_Garamond, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { parsePublicEnv } from "@/lib/env";
import "./globals.css";

const env = parsePublicEnv(process.env);

// Self-hosted by next/font at build time; browsers never contact Google.
const serif = EB_Garamond({ subsets: ["latin"], variable: "--font-eb-garamond", display: "swap" });
const sans = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });

export const metadata: Metadata = {
  metadataBase: env.appUrl,
  title: { default: "Wedding Workspace", template: "%s · Wedding Workspace" },
  description: "Discover, compare and bring every detail of your wedding together.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fbf9f6",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only rounded-control bg-action-emphasis px-4 py-3 font-semibold text-on-action-emphasis focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
