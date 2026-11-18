/**
 * Pakistan location convenience list for the admin Shipping zone form (SANDY-BATCH-14).
 *
 * Province strings match checkout (`PAKISTAN_PROVINCES` in lib/site.ts): KPK / Islamabad / AJK
 * (not the long official names). Cities are a UI helper only — never used to reject stored values.
 */
import { PAKISTAN_PROVINCES } from "./site";

export type PkProvince = (typeof PAKISTAN_PROVINCES)[number];

export type PkCity = {
  name: string;
  province: PkProvince;
};

/** Exact checkout / address-form province strings. */
export const PK_PROVINCES: readonly PkProvince[] = PAKISTAN_PROVINCES;

/**
 * Major Pakistani cities/towns (provincial capitals, divisional HQs, ~largest cities).
 * Alphabetical by city name. Province is for grouping in the admin UI only.
 */
export const PK_CITIES: readonly PkCity[] = [
  { name: "Abbottabad", province: "KPK" },
  { name: "Attock", province: "Punjab" },
  { name: "Badin", province: "Sindh" },
  { name: "Bahawalnagar", province: "Punjab" },
  { name: "Bahawalpur", province: "Punjab" },
  { name: "Bannu", province: "KPK" },
  { name: "Batkhela", province: "KPK" },
  { name: "Bhakkar", province: "Punjab" },
  { name: "Bhimber", province: "AJK" },
  { name: "Burewala", province: "Punjab" },
  { name: "Chakwal", province: "Punjab" },
  { name: "Charsadda", province: "KPK" },
  { name: "Chiniot", province: "Punjab" },
  { name: "Chitral", province: "KPK" },
  { name: "Dadu", province: "Sindh" },
  { name: "Dera Ghazi Khan", province: "Punjab" },
  { name: "Dera Ismail Khan", province: "KPK" },
  { name: "Faisalabad", province: "Punjab" },
  { name: "Ghotki", province: "Sindh" },
  { name: "Gilgit", province: "Gilgit-Baltistan" },
  { name: "Gojra", province: "Punjab" },
  { name: "Gujar Khan", province: "Punjab" },
  { name: "Gujranwala", province: "Punjab" },
  { name: "Gujrat", province: "Punjab" },
  { name: "Gwadar", province: "Balochistan" },
  { name: "Hafizabad", province: "Punjab" },
  { name: "Haripur", province: "KPK" },
  { name: "Hyderabad", province: "Sindh" },
  { name: "Islamabad", province: "Islamabad" },
  { name: "Jacobabad", province: "Sindh" },
  { name: "Jafarabad", province: "Balochistan" },
  { name: "Jalalpur Jattan", province: "Punjab" },
  { name: "Jaranwala", province: "Punjab" },
  { name: "Jhang", province: "Punjab" },
  { name: "Jhelum", province: "Punjab" },
  { name: "Kamalia", province: "Punjab" },
  { name: "Kamoke", province: "Punjab" },
  { name: "Karachi", province: "Sindh" },
  { name: "Kasur", province: "Punjab" },
  { name: "Khairpur", province: "Sindh" },
  { name: "Khanewal", province: "Punjab" },
  { name: "Khanpur", province: "Punjab" },
  { name: "Khushab", province: "Punjab" },
  { name: "Khuzdar", province: "Balochistan" },
  { name: "Kohat", province: "KPK" },
  { name: "Kot Addu", province: "Punjab" },
  { name: "Kotri", province: "Sindh" },
  { name: "Lahore", province: "Punjab" },
  { name: "Larkana", province: "Sindh" },
  { name: "Layyah", province: "Punjab" },
  { name: "Lodhran", province: "Punjab" },
  { name: "Mandi Bahauddin", province: "Punjab" },
  { name: "Mansehra", province: "KPK" },
  { name: "Mardan", province: "KPK" },
  { name: "Mianwali", province: "Punjab" },
  { name: "Mirpur", province: "AJK" },
  { name: "Mirpur Khas", province: "Sindh" },
  { name: "Multan", province: "Punjab" },
  { name: "Muridke", province: "Punjab" },
  { name: "Murree", province: "Punjab" },
  { name: "Muzaffarabad", province: "AJK" },
  { name: "Muzaffargarh", province: "Punjab" },
  { name: "Nankana Sahib", province: "Punjab" },
  { name: "Narowal", province: "Punjab" },
  { name: "Nawabshah", province: "Sindh" },
  { name: "Nowshera", province: "KPK" },
  { name: "Okara", province: "Punjab" },
  { name: "Pakpattan", province: "Punjab" },
  { name: "Peshawar", province: "KPK" },
  { name: "Quetta", province: "Balochistan" },
  { name: "Rahim Yar Khan", province: "Punjab" },
  { name: "Rawalpindi", province: "Punjab" },
  { name: "Sadiqabad", province: "Punjab" },
  { name: "Sahiwal", province: "Punjab" },
  { name: "Sanghar", province: "Sindh" },
  { name: "Sargodha", province: "Punjab" },
  { name: "Shahdadpur", province: "Sindh" },
  { name: "Sheikhupura", province: "Punjab" },
  { name: "Shikarpur", province: "Sindh" },
  { name: "Sialkot", province: "Punjab" },
  { name: "Skardu", province: "Gilgit-Baltistan" },
  { name: "Sukkur", province: "Sindh" },
  { name: "Swabi", province: "KPK" },
  { name: "Swat", province: "KPK" },
  { name: "Tando Adam", province: "Sindh" },
  { name: "Tando Allahyar", province: "Sindh" },
  { name: "Taxila", province: "Punjab" },
  { name: "Toba Tek Singh", province: "Punjab" },
  { name: "Turbat", province: "Balochistan" },
  { name: "Vehari", province: "Punjab" },
  { name: "Wah Cantonment", province: "Punjab" },
  { name: "Wazirabad", province: "Punjab" },
];

const PROVINCE_SET = new Set<string>(PK_PROVINCES);

export function isKnownPkProvince(name: string): boolean {
  return PROVINCE_SET.has(name);
}

export function pkCityNames(): string[] {
  return PK_CITIES.map((c) => c.name);
}
