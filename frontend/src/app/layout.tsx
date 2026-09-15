import type { Metadata } from "next";
import { Noto_Sans_Thai } from "next/font/google";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-sans-thai",
});

export const metadata: Metadata = {
  title: "ทะเบียน | ภาพรวมงานขนส่ง",
  description: "ระบบจัดการงานทะเบียนขนส่ง",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" className={notoSansThai.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
