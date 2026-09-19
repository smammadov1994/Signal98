import "./globals.css";
import "./shell.css";
import "./modern.css";
import { THEME_BOOT } from "../lib/theme-config";

export const metadata = { title: "Signal 98 — App health dashboard" };

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* sets <html data-theme> before first paint, so the chosen shell never flashes the other one */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
