import React, { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import type { SecretReveal } from "../../lib/inboundSecret";

/**
 * Shows a channel's inbound webhook secret once. It renders nothing when there
 * is no reveal, so closing the dialog removes the only copy the browser holds.
 */
export default function InboundSecretDialog({
  reveal,
  onClose,
}: {
  reveal: SecretReveal | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!reveal) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(reveal!.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbound-secret-title"
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-slate-100 p-4">
          <KeyRound size={16} className="text-blue-600" />
          <div>
            <p id="inbound-secret-title" className="text-sm font-bold text-slate-900">
              {reveal.reason === "rotated" ? "New webhook secret" : "Webhook secret"}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">{reveal.channelName}</p>
          </div>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-sm text-slate-600">
            Use this secret to sign requests sent to this channel&apos;s webhook.
            {reveal.reason === "rotated" ? " The previous secret no longer works." : ""}
          </p>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={reveal.secret}
              aria-label="Webhook secret"
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
            <button
              onClick={() => {
                void copy();
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            You won&apos;t see this again. Copy it now; if you lose it, rotate the secret to get a
            new one.
          </p>
        </div>
        <div className="flex justify-end border-t border-slate-100 p-4">
          <button
            onClick={onClose}
            className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700"
          >
            I&apos;ve saved it
          </button>
        </div>
      </div>
    </div>
  );
}
