import { AnimatePresence, motion } from 'motion/react';
import { Loader2, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PillTone } from './format';

/** Sync/status pill. Maps `syncPill().tone` (and a few ad-hoc tones) to the one-accent palette. */
export function Pill({ label, tone = 'muted' }: { label: string; tone?: PillTone }) {
  const styles: Record<PillTone, string> = {
    ok: 'bg-(--accent-soft) text-(--accent)',
    muted: 'bg-(--bg-sunken) text-(--ink-mute)',
    warn: 'bg-(--warn-soft) text-(--warn)',
    error: 'bg-(--error-soft) text-(--error)',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-none whitespace-nowrap ${styles[tone]}`}>
      {label}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin" />;
}

/**
 * The app logo (the cat in the backpack), served from /logo.png in the mockup and the extension
 * alike. The PNG is 559×417 with the drawing in a 280×263 box at (137, 74) on a white ground, so
 * it is cropped to that box here and multiplied onto the background so the white ground disappears.
 */
const LOGO = { w: 559, h: 417, x: 137, y: 74, bw: 280, bh: 263 };

export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  const f = (size * 0.94) / LOGO.bw; // rendered px per source px, with a little air around the drawing
  return (
    <span
      className={`relative inline-block shrink-0 select-none overflow-hidden align-middle ${className}`}
      style={{ width: size, height: size }}
      aria-label="CanvasBuddy"
      role="img"
    >
      <img
        src="/logo.png"
        alt=""
        draggable={false}
        className="absolute max-w-none mix-blend-multiply"
        style={{
          width: LOGO.w * f,
          height: LOGO.h * f,
          left: size / 2 - (LOGO.x + LOGO.bw / 2) * f,
          top: size / 2 - (LOGO.y + LOGO.bh / 2) * f,
        }}
      />
    </span>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
        active ? 'bg-(--accent-soft) text-(--accent)' : 'text-(--ink-soft) hover:bg-(--bg-sunken)'
      }`}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}

/** A full-height sheet that slides up over the chat. Header: back/title/actions/close. */
export function Sheet({
  title,
  onBack,
  onClose,
  actions,
  children,
}: {
  title: ReactNode;
  onBack?: () => void;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.div
      className="absolute inset-0 z-40 flex flex-col bg-(--bg)"
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-(--line) px-3">
        {onBack && (
          <button type="button" onClick={onBack} className="-ml-1 rounded-full p-1.5 text-(--ink-soft) hover:bg-(--bg-sunken)">
            <ChevronLeft />
          </button>
        )}
        <div className="serif min-w-0 flex-1 truncate text-[15px] font-medium">{title}</div>
        {actions}
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-(--ink-soft) hover:bg-(--bg-sunken)">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </motion.div>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }: { icon: LucideIcon; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon size={22} strokeWidth={1.5} className="text-(--ink-mute)" />
      <div className="serif text-[15px] text-(--ink-soft)">{title}</div>
      {hint && <div className="max-w-[26ch] text-[12.5px] text-(--ink-mute)">{hint}</div>}
      {action}
    </div>
  );
}

/** The transient result line of a sync/index action, animated in at the bottom of a sheet. */
export function StatusLine({ message }: { message: string | null }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-3 pb-3">
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-auto max-w-full rounded-full border border-(--line) bg-(--bg-raised) px-3 py-1.5 text-[12px] text-(--ink-soft) shadow-none"
          >
            {message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function SavedPill({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="rounded-full bg-(--accent-soft) px-2 py-0.5 text-[11px] text-(--accent)"
        >
          Saved
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="serif mb-2 text-[14px] font-medium text-(--ink)">{children}</h3>;
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="text-[12.5px] font-medium text-(--ink-soft)">{children}</span>
      {hint && <span className="truncate text-[11px] text-(--ink-mute)">{hint}</span>}
    </div>
  );
}

/** A plain hairline-underlined text input, per the Settings direction (no boxed inputs). */
export function UnderlineInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full border-0 border-b border-(--line) bg-transparent py-1.5 text-[13px] outline-none transition-colors focus:border-(--accent) ${className}`}
    />
  );
}
