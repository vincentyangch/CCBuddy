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
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-[color:var(--sd-subtle)]">{domain}</div>
        <h2 className="mt-1 font-serif text-3xl font-bold leading-tight text-[color:var(--sd-text)]">{title}</h2>
        {description && <p className="mt-1 text-sm text-[color:var(--sd-muted)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
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
    warning: 'var(--sd-warning)',
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
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
}) {
  return (
    <button {...props} className={`${variant === 'primary' ? 'sd-button' : 'sd-button-secondary'} ${className}`}>
      {children}
    </button>
  );
}
