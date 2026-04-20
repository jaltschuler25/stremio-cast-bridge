"use client";

/**
 * Button that tells the Next.js server to spawn the Stremio 5 shell
 * with our `--webui-url` flag already set. Uses React 19's
 * `useActionState` + `useTransition` so there's no manual loading
 * flag, matching the house rule.
 */
import { useActionState, useTransition } from "react";

interface LaunchResult {
  ok: boolean;
  pid?: number;
  binary?: string;
  webuiUrl?: string;
  error?: string;
}

async function launchAction(
  _prev: LaunchResult | null,
  _formData: FormData
): Promise<LaunchResult> {
  const res = await fetch("/api/launch", { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<LaunchResult>;
    return {
      ok: false,
      error: body.error ?? `HTTP ${res.status}`,
    };
  }
  return (await res.json()) as LaunchResult;
}

interface Props {
  disabled?: boolean;
  onLaunched?: () => void;
}

export function LaunchButton({ disabled, onLaunched }: Props) {
  const [result, formAction] = useActionState(launchAction, null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          formAction(formData);
          onLaunched?.();
        });
      }}
      className="space-y-3"
    >
      <button
        type="submit"
        disabled={disabled || isPending}
        className="w-full rounded-xl bg-violet-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none"
      >
        {isPending ? "Launching…" : "Launch Stremio 5 with Casting"}
      </button>
      {result && !result.ok && (
        <p className="text-xs text-rose-300">{result.error}</p>
      )}
      {result?.ok && (
        <p className="text-xs text-emerald-300">
          Launched PID {result.pid}. The cast button should light up as soon
          as Stremio loads.
        </p>
      )}
    </form>
  );
}
