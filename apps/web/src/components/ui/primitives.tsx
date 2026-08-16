'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './Icon';
import { haptics } from '@/lib/telegram';

/**
 * Base UI primitives.
 *
 * Hand-rolled instead of a component library. The reasons are specific to this app: the
 * whole palette comes from Telegram's CSS variables (so a library's own theming would have
 * to be overridden anyway), the bundle ships to a mobile WebView on a cold start, and RTL
 * needs to be a first-class layout concern rather than a plugin.
 *
 * Touch targets are at least 44px, which is the accessibility floor on iOS.
 */

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ button -- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-text active:brightness-95',
  secondary: 'bg-surface-raised text-text border border-border active:bg-surface',
  ghost: 'bg-transparent text-link active:bg-surface',
  danger: 'bg-negative/12 text-negative border border-negative/25 active:bg-negative/20',
};

const SIZES = {
  sm: 'h-9 px-3 text-[13px] rounded-xl gap-1.5',
  md: 'h-11 px-4 text-[15px] rounded-2xl gap-2',
  lg: 'h-13 px-5 text-[16px] rounded-2xl gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    icon,
    loading,
    fullWidth,
    className,
    children,
    onClick,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      onClick={(event) => {
        // Light haptic on every deliberate action; Telegram ignores it outside its clients.
        haptics.impact('light');
        onClick?.(event);
      }}
      className={cx(
        'inline-flex items-center justify-center font-medium transition-[opacity,transform,background-color]',
        'active:scale-[0.98] disabled:opacity-45 disabled:active:scale-100',
        'min-h-[44px]',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={16} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 16 : 18} />
      ) : null}
      {children}
    </button>
  );
});

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx('animate-spin', className)}
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.22"
        fill="none"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------- card -- */

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('card overflow-hidden', className)} {...rest}>
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between px-1 pb-2">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {action ? (
        <button type="button" onClick={onAction} className="text-[13px] font-medium text-link">
          {action}
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- skeleton -- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="card flex items-center gap-3 p-3.5">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- empty state -- */

export function EmptyState({
  icon = 'info',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised text-muted">
        <Icon name={icon} size={24} />
      </div>
      <p className="text-[15px] font-medium text-text">{title}</p>
      {hint ? (
        <p className="mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-muted">{hint}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs -- */

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}

export function Field({ label, hint, error, required, children, htmlFor }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block px-1 text-[13px] font-medium text-muted">
        {label}
        {required ? <span className="text-negative"> *</span> : null}
      </label>
      {children}
      {error ? (
        <p className="px-1 text-[12px] text-negative" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="px-1 text-[12px] leading-relaxed text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'w-full rounded-2xl border border-border bg-surface px-4 py-3 text-[15px] text-text',
          'placeholder:text-subtle focus:border-accent focus:outline-none',
          // 16px minimum prevents iOS from zooming the viewport on focus.
          'text-[16px] md:text-[15px]',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={3}
      className={cx(
        'w-full resize-none rounded-2xl border border-border bg-surface px-4 py-3 text-[16px] text-text',
        'placeholder:text-subtle focus:border-accent focus:outline-none md:text-[15px]',
        className,
      )}
      {...rest}
    />
  );
});

/** Numeric input for money. `inputMode="decimal"` gets the right keypad without type=number. */
export const AmountInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function AmountInput({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        // Deliberately not type="number": it silently accepts exponent notation and its
        // value can lose precision. Text plus a decimal keypad keeps the exact string.
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className={cx(
          'numeric w-full rounded-2xl border border-border bg-surface px-4 py-3.5 text-[24px] font-semibold text-text',
          'placeholder:text-subtle focus:border-accent focus:outline-none',
          className,
        )}
        {...rest}
      />
    );
  },
);

/* --------------------------------------------------------------- segmented -- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex gap-1 rounded-2xl bg-surface-sunken p-1"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => {
              haptics.selection();
              onChange(option.value);
            }}
            className={cx(
              'min-h-[38px] flex-1 rounded-xl px-3 text-[13px] font-medium transition-colors',
              selected ? 'bg-surface-raised text-text shadow-sm' : 'text-muted',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Horizontally scrollable filter chips. */
export function ChipRow({ children }: { children: ReactNode }) {
  return <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">{children}</div>;
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptics.selection();
        onClick?.();
      }}
      aria-pressed={active}
      className={cx(
        'shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium whitespace-nowrap transition-colors',
        active ? 'bg-accent text-accent-text' : 'bg-surface text-muted border border-border',
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- misc -- */

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'positive' | 'negative' | 'warning' | 'accent';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-surface-raised text-muted',
    positive: 'bg-positive/15 text-positive',
    negative: 'bg-negative/15 text-negative',
    warning: 'bg-warning/15 text-warning',
    accent: 'bg-accent/15 text-accent',
  };
  return (
    <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Divider() {
  return <div className="h-px bg-border" role="presentation" />;
}

export { cx };
