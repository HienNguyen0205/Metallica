import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

/**
 * Mono only. The sans face that shipped alongside it was preloaded on every
 * page load and never rendered: no component carries `font-sans`, and `body`
 * named Arial outright. This interface is monospace by design, so the default
 * is the mono face rather than a second family nothing asks for.
 */
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Metallica // FRIDAY",
  description: "FRIDAY holographic AI interface",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
