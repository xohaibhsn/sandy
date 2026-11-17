export type OtpPurpose = "cod_checkout" | "login";

export type OtpProviderName = "mock" | "twilio_verify";

export interface OtpProvider {
  readonly name: OtpProviderName;
  start(phoneE164: string, purpose: OtpPurpose): Promise<{ providerRef: string }>;
  check(providerRefOrPhone: string, code: string): Promise<boolean>;
}
