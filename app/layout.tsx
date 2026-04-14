import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FaceSense — Real-time Face Detection",
  description:
    "Phase 2: Browser-based real-time face detection with emotion recognition, stress estimation, blink detection, and MongoDB backend.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * suppressHydrationWarning on both <html> and <body> silences mismatch
     * warnings caused by browser extensions (e.g. Browsec VPN) that inject
     * attributes like bis_skin_checked="1" into arbitrary elements — including
     * Next.js internal <MetadataWrapper> divs — before React hydrates.
     * Safe: only suppresses attribute-level differences on the annotated
     * element itself, not deep content mismatches in children.
     */
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}