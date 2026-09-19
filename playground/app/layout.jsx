import "./globals.css";
import Shell from "./signal";

export const metadata = { title: "ghost mart — signal98 demo shop" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body><Shell>{children}</Shell></body>
    </html>
  );
}
