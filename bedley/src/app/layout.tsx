import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bedley — auditable AI property management",
  description: "Landlord and tenant platform where every AI agent action is policy-checked and recorded in MongoDB Atlas.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
