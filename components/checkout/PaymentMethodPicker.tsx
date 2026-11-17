"use client";

export type PaymentMethodOption<T extends string = string> = {
  val: T;
  label: string;
  sub: string;
};

type Props<T extends string> = {
  options: PaymentMethodOption<T>[];
  /** When set, only these methods are rendered. null/undefined = render every option. */
  allowedMethods?: readonly string[] | null;
  value: T;
  onChange: (method: T) => void;
};

/**
 * Payment radio list. Uses the same `.payment-option*` classes as the cart page
 * (styles live in app/cart/page.tsx), so the visual style is unchanged.
 */
export default function PaymentMethodPicker<T extends string>({
  options,
  allowedMethods,
  value,
  onChange,
}: Props<T>) {
  const visible = allowedMethods ? options.filter((o) => allowedMethods.includes(o.val)) : options;
  return (
    <div className="payment-options">
      {visible.map((p) => (
        <div
          key={p.val}
          className={`payment-option ${value === p.val ? "selected" : ""}`}
          onClick={() => onChange(p.val)}
        >
          <input type="radio" readOnly checked={value === p.val} />
          <div>
            <div className="payment-option-label">{p.label}</div>
            <div className="payment-option-sub">{p.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
