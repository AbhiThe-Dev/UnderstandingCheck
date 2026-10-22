import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Understanding Check',
  description: 'Code-aware clarification copilot for software discussions',
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/repos', label: 'Repositories' },
  { href: '/sessions/new', label: 'New session' },
  { href: '/admin/cost', label: 'Cost' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-surface)]/90 backdrop-blur">
          <div className="mx-auto flex h-12 max-w-[1500px] items-center gap-6 px-4">
            <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
              <span className="inline-block size-2.5 rounded-full bg-[var(--color-accent)]" aria-hidden />
              Understanding Check
            </Link>
            <nav className="flex gap-1 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded px-2 py-1 text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1500px] px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
