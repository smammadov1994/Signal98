import "./globals.css";

export const metadata = { title: "signal98 — semantic alerting" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
