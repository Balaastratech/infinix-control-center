import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NovaCommerce Ops",
  description: "NovaCommerce operations control center",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
