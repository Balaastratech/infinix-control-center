import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted by next/font at build time; exposed as --font-inter for the tokens in globals.css.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "NovaCommerce Ops",
  description: "NovaCommerce operations control center",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
