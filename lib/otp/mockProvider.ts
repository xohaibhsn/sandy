import type { OtpProvider, OtpPurpose } from "./types";

/**
 * Dev/test OTP provider. Accepts code "000000" always.
 * Refuses to construct when NODE_ENV === 'production'.
 */
export function createMockOtpProvider(): OtpProvider {
  if (process.env.NODE_ENV === "production") {
    throw new Error("OTP_MOCK_REFUSED_IN_PRODUCTION");
  }

  return {
    name: "mock",
    async start(phoneE164: string, purpose: OtpPurpose) {
      void purpose;
      return { providerRef: `mock:${phoneE164}` };
    },
    async check(_providerRefOrPhone: string, code: string) {
      return code === "000000";
    },
  };
}
