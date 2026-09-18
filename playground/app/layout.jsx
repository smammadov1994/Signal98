import "./globals.css";

export const metadata = {
  title: "signal98 — error playground",
  description: "Set off errors, watch them get judged in the raw feed.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
