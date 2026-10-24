import { cn } from '@/lib/utils';

const PALETTE = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
];

/**
 * Color per speaker. Pass the speaker's position among the session's participants so everyone in a
 * meeting gets a different color; without it the name picks one.
 */
export function speakerColor(name: string, index?: number) {
  if (index !== undefined && index >= 0) return PALETTE[index % PALETTE.length]!;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0]![0]! : parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
}

export function Avatar({ name, index, unknown, className }: { name: string; index?: number; unknown?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
        unknown ? 'border border-dashed border-[var(--color-line)] text-[var(--color-muted)]' : speakerColor(name, index),
        className,
      )}
    >
      {unknown ? '?' : initials(name)}
    </span>
  );
}
