import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FaceSense — Real-time Face Detection",
  description:
    "Phase 1: Browser-based real-time face detection using face-api.js. No backend, fully client-side.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * suppressHydrationWarning on <body> silences the mismatch warning caused
     * by browser extensions that inject attributes (e.g. bis_register, __processed_*)
     * into the <body> tag before React hydrates. This is safe — it only suppresses
     * one level of attribute differences, not child content mismatches.
     */
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
