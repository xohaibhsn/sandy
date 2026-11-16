"use client";

type AdminBannerProps = {
  message: string;
  tone?: "error" | "success" | "info";
  onRetry?: () => void;
  retryLabel?: string;
};

/**
 * Non-blocking inline admin banner. Renders message as plain text only.
 */
export default function AdminBanner({
  message,
  tone = "error",
  onRetry,
  retryLabel = "Retry",
}: AdminBannerProps) {
  if (!message) return null;

  const styles =
    tone === "success"
      ? {
          background: "rgba(22,163,74,0.1)",
          border: "1px solid rgba(22,163,74,0.3)",
          color: "#16A34A",
        }
      : tone === "info"
        ? {
            background: "rgba(37,99,235,0.08)",
            border: "1px solid rgba(37,99,235,0.25)",
            color: "#2563EB",
          }
        : {
            background: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.25)",
            color: "#DC2626",
          };

  return (
    <div
      role="status"
      data-admin-banner={tone}
      style={{
        marginBottom: 16,
        padding: "10px 16px",
        borderRadius: 10,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        ...styles,
      }}
    >
      <span>{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          data-admin-retry="1"
          style={{
            background: "#FFFFFF",
            border: "1px solid #E5E5E5",
            color: "#111111",
            borderRadius: 8,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
