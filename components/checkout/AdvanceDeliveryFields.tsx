"use client";

import { CUSTOMER_TEXTS } from "@/lib/customerTexts";
import { formatPrice } from "@/lib/site";

type Props = {
  charge: number;
  reference: string;
  onReferenceChange: (value: string) => void;
  receiptFile: File | null;
  onReceiptFileChange: (file: File | null) => void;
};

/** Advance delivery-charge fields shown for COD orders that require a prepaid delivery charge. */
export default function AdvanceDeliveryFields({
  charge,
  reference,
  onReferenceChange,
  receiptFile,
  onReceiptFileChange,
}: Props) {
  return (
    <>
      <div className="bank-details" data-advance-delivery="1">
        <h4>{CUSTOMER_TEXTS.ADVANCE_REFERENCE_LABEL}</h4>
        <p style={{ fontSize: 13, color: "#555", lineHeight: 1.6, marginBottom: 10 }}>
          {CUSTOMER_TEXTS.ADVANCE_DELIVERY_HINT}
        </p>
        <div className="bank-row">
          <span>Delivery charge (advance)</span>
          <span>{formatPrice(charge)}</span>
        </div>
      </div>
      <div className="form-group">
        <label>{CUSTOMER_TEXTS.ADVANCE_REFERENCE_LABEL}</label>
        <input
          type="text"
          maxLength={255}
          placeholder="JazzCash / Easypaisa / bank reference"
          value={reference}
          onChange={(e) => onReferenceChange(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label>{CUSTOMER_TEXTS.ADVANCE_RECEIPT_LABEL}</label>
        <div className={`upload-area ${receiptFile ? "has-file" : ""}`}>
          <span className="upload-icon">{receiptFile ? "✅" : "📎"}</span>
          <div className="upload-text">
            {receiptFile ? <strong>{receiptFile.name}</strong> : <><strong>Click to upload</strong> your receipt</>}
          </div>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.pdf"
            onChange={(e) => onReceiptFileChange(e.target.files?.[0] || null)}
          />
        </div>
      </div>
    </>
  );
}
