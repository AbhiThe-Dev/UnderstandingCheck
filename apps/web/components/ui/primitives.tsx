import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--color-accent)] text-white hover:opacity-90',
        secondary: 'border border-[var(--color-line)] bg-[var(--color-surface)] hover:bg-[var(--color-canvas)]',
        ghost: 'text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]',
        danger: 'border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950',
      },
      size: { sm: 'h-7 px-2.5 text-xs', md: 'h-9 px-3.5' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export function Button({ className, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]', className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-4 py-2.5', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'bg-[var(--color-canvas)] text-[var(--color-muted)] border border-[var(--color-line)]',
      accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
      amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
      green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
      red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
      blue: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const field =
  'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm placeholder:text-[var(--color-muted)] focus:outline-2 focus:outline-[var(--color-accent)]';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'font-mono text-xs leading-relaxed', className)} {...props} />;
}

export function Label({ className, ...props }: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string }) {
  return <label className={cn('mb-1 block text-xs font-medium text-[var(--color-muted)]', className)} {...props} />;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">{children}</p>;
}
