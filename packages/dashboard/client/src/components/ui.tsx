import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTheme } from './ThemeProvider';

export function PageHeader({
  domain,
  title,
  description,
  actions,
}: {
  domain: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">{domain}</div>
        <h2 className="mt-1 break-words font-serif text-3xl font-bold leading-tight text-[color:var(--sd-text)]">
          {title}
        </h2>
        {description && <p className="mt-1 break-words text-sm text-[color:var(--sd-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto sm:justify-end">{actions}</div>}
    </div>
  );
}

export function Panel({
  children,
  className = '',
  accent = false,
}: {
  children: ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return <div className={`sd-panel ${accent ? 'sd-panel-accent' : ''} ${className}`}>{children}</div>;
}

export function StatusPill({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
  children: ReactNode;
}) {
  const color = {
    success: 'var(--sd-success)',
    warning: 'var(--sd-warning-ink)',
    danger: 'var(--sd-danger)',
    neutral: 'var(--sd-subtle)',
    info: 'var(--sd-info)',
  }[tone];

  return (
    <span
      className="inline-flex items-center rounded-[var(--sd-radius)] border px-2 py-0.5 text-xs font-medium"
      style={{ borderColor: color, color }}
    >
      {children}
    </span>
  );
}

export function ThemeToggle() {
  const { label, cycleTheme, resolvedTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={cycleTheme}
      className="sd-button-secondary px-3 py-2 text-xs uppercase tracking-wide hover:text-[color:var(--sd-text)]"
      aria-label={`Cycle theme. Current preference ${label}. Active theme ${resolvedTheme}.`}
      title={`Theme: ${label}`}
    >
      {resolvedTheme === 'dark' ? 'Dark' : 'Light'} · {label}
    </button>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
}) {
  return (
    <button
      type={type}
      {...props}
      className={`${variant === 'primary' ? 'sd-button' : 'sd-button-secondary'} ${className}`}
    >
      {children}
    </button>
  );
}
