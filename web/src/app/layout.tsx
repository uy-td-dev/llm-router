import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Router Dashboard",
  description: "Multi-provider LLM router management",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" className="dark">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  );
}
