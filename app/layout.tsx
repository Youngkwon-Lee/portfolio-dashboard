import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "포트폴리오 대시보드",
  description: "개인 자산 포트폴리오 & 자동매매 대시보드",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();

  return (
    <html lang="ko" className="h-full">
      <body className="h-full overflow-hidden" style={{ background: "var(--background)", color: "var(--foreground)" }}>
        {children}
      </body>
    </html>
  );
}
