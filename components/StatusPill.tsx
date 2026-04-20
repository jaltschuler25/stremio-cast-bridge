/**
 * Small coloured pill used in the control panel to communicate
 * binary states (server up/down, app found/missing, etc.) at a
 * glance. Kept deliberately dumb — styling only, no logic.
 */
import { cn } from "@/lib/cn";

export type PillTone = "ok" | "warn" | "bad" | "info";

interface Props {
  tone: PillTone;
  children: React.ReactNode;
}

const TONE_CLASSES: Record<PillTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  bad: "bg-rose-500/15 text-rose-300 ring-rose-400/30",
  info: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
};

export function StatusPill({ tone, children }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_CLASSES[tone]
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current")} />
      {children}
    </span>
  );
}
