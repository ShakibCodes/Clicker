import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "L.A.R.V.I.S.",
  description: "Live Adaptive Reasoning and Voice Intelligence System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
