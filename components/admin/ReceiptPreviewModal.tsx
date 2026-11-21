"use client";

import Image from "next/image";
import { useState } from "react";
import { receiptKindFromUrl } from "../../lib/receiptView";

export type ReceiptPreviewModalProps = {
  orderId: string;
  url: string;
  onClose: () => void;
  onVerifyConfirm: () => void;
};

export default function ReceiptPreviewModal({
  orderId,
  url,
  onClose,
  onVerifyConfirm,
}: ReceiptPreviewModalProps) {
  const kind = receiptKindFromUrl(url);
  const [imgError, setImgError] = useState(false);

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">Payment Receipt — {orderId}</div>

        {kind === "pdf" ? (
          <div
            style={{
              width: "100%",
              borderRadius: 12,
              marginBottom: 16,
              border: "1px solid rgba(139,0,255,0.3)",
              padding: 24,
              textAlign: "center",
              background: "rgba(139,0,255,0.06)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 12 }}>PDF receipt</div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#5B21B6", fontSize: 14 }}
            >
              Open PDF in new tab
            </a>
          </div>
        ) : null}

        {kind === "image" ? (
          <div style={{ marginBottom: 16 }}>
            {imgError ? (
              <div
                style={{
                  width: "100%",
                  borderRadius: 12,
                  border: "1px solid rgba(139,0,255,0.3)",
                  padding: 24,
                  textAlign: "center",
                }}
              >
                Receipt could not be displayed
              </div>
            ) : (
              <Image
                src={url}
                alt="Receipt"
                width={800}
                height={600}
                unoptimized
                onError={() => setImgError(true)}
                style={{
                  width: "100%",
                  height: "auto",
                  borderRadius: 12,
                  border: "1px solid rgba(139,0,255,0.3)",
                }}
              />
            )}
            <div style={{ marginTop: 8 }}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#5B21B6", fontSize: 13 }}
              >
                Open PDF in new tab
              </a>
            </div>
          </div>
        ) : null}

        {kind === "unknown" ? (
          <div style={{ marginBottom: 16 }}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#5B21B6", fontSize: 14 }}
            >
              Open PDF in new tab
            </a>
          </div>
        ) : null}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>
            Close
          </button>
          <button className="modal-save" onClick={onVerifyConfirm}>
            ✅ Verify & Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
