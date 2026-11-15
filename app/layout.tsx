import type { Metadata } from 'next';
import { Archivo, Source_Serif_4 } from 'next/font/google';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import './globals.css';

const archivo = Archivo({ subsets: ['latin'], display: 'swap', variable: '--font-archivo' });
const sourceSerif = Source_Serif_4({ subsets: ['latin'], display: 'swap', variable: '--font-source-serif' });

export const metadata: Metadata = {
  title: { default: 'Shelf Index', template: '%s | Shelf Index' },
  description:
    'What do people say about your brand, what does AI say about it, and where is the gap? A free, evidence-backed brand audit.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${sourceSerif.variable}`}>
      <body className="min-h-screen antialiased">
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
