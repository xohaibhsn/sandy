"use client";

import { useMemo, useState } from "react";
import {
  CANCEL_PRESETS,
  CANCEL_REASON_MAX,
  type CancelPresetCode,
} from "../../lib/orderCancel";

export type CancelOrderDialogProps = {
  orderId: string;
  open: boolean;
  submitting?: boolean;
  onBack: () => void;
  onConfirm: (payload: {
    cancel_reason_code: CancelPresetCode;
    cancel_reason_note?: string;
  }) => void;
};

/**
 * Modal for choosing a mandatory cancel reason before PATCH status=cancelled.
 * Renders all text as React text nodes (escaped).
 */
export default function CancelOrderDialog({
  orderId,
  open,
  submitting = false,
  onBack,
  onConfirm,
}: CancelOrderDialogProps) {
  const [code, setCode] = useState<CancelPresetCode | "">("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState("");

  const noteLen = useMemo(() => note.length, [note]);
  const isOther = code === "other";

  if (!open) return null;

  const handleConfirm = () => {
    setLocalError("");
    if (!code) {
      setLocalError("Select a cancellation reason.");
      return;
    }
    if (isOther) {
      const trimmed = note.trim();
      if (!trimmed) {
        setLocalError("A note is required for Other.");
        return;
      }
      if (trimmed.length > CANCEL_REASON_MAX) {
        setLocalError(`Note must be at most ${CANCEL_REASON_MAX} characters.`);
        return;
      }
    }
    onConfirm({
      cancel_reason_code: code,
      cancel_reason_note: isOther ? note.trim() : undefined,
    });
  };

  return (
    <div className="modal-overlay" data-cancel-dialog="1">
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">Cancel order — {orderId}</div>
        <p
          style={{
            fontSize: 12,
            color: "#6B7280",
            margin: "0 0 14px",
            lineHeight: 1.45,
          }}
          data-cancel-customer-hint="1"
        >
          This reason is visible to the customer on order tracking.
        </p>
        <div className="modal-field">
          <label htmlFor="cancel-reason-code">Reason</label>
          <select
            id="cancel-reason-code"
            data-cancel-reason-code="1"
            value={code}
            onChange={(e) => {
              setCode(e.target.value as CancelPresetCode | "");
              setLocalError("");
            }}
          >
            <option value="">Select a reason…</option>
            {CANCEL_PRESETS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {isOther ? (
          <div className="modal-field">
            <label htmlFor="cancel-reason-note">
              Note ({noteLen}/{CANCEL_REASON_MAX})
            </label>
            <textarea
              id="cancel-reason-note"
              data-cancel-reason-note="1"
              rows={4}
              maxLength={CANCEL_REASON_MAX}
              value={note}
              onChange={(e) => {
                setNote(e.target.value.slice(0, CANCEL_REASON_MAX));
                setLocalError("");
              }}
              placeholder="Describe the reason"
              style={{ width: "100%", resize: "vertical" }}
            />
          </div>
        ) : null}
        {localError ? (
          <p
            data-cancel-dialog-error="1"
            style={{ color: "#DC2626", fontSize: 12, margin: "0 0 10px" }}
          >
            {localError}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-cancel"
            data-cancel-back="1"
            onClick={onBack}
            disabled={submitting}
          >
            Back
          </button>
          <button
            type="button"
            className="modal-save"
            data-cancel-confirm="1"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? "Cancelling…" : "Confirm cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
