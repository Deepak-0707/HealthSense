import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FaceSense — AI Wellness Monitor",
  description:
    "Phase 4: Production-ready stress, fatigue & emotion detection. Real-time notifications, analytics dashboard, MongoDB Atlas.",
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
      <head>
        {/* Register service worker for optional background push notifications */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js')
                    .then(function(reg) {
                      console.log('[FaceSense] SW registered, scope:', reg.scope);
                    })
                    .catch(function(err) {
                      console.log('[FaceSense] SW registration failed:', err);
                    });
                });
              }
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
