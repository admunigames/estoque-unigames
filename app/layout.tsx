import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ||
    requestHeaders.get("host") ||
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description =
    "Reconciliação de estoque, puxadas e controle de compras integrado ao Notion.";
  const imageUrl = new URL("/og.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    title: "Estoque Unigames",
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Estoque Unigames",
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1733, height: 907 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Estoque Unigames",
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
