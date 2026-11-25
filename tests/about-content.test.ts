import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTsResolveHook } from "./orders-test-support.mjs";

installTsResolveHook();
const { resolveAboutMissionText } = await import("../lib/aboutContent.ts");

describe("resolveAboutMissionText", () => {
  it("extracts text from JSON object", () => {
    const raw = '{"title":"Our Mission","text":"We bring quality products to customers across Pakistan."}';
    assert.equal(
      resolveAboutMissionText(raw),
      "We bring quality products to customers across Pakistan."
    );
  });
  it("keeps plain text", () => {
    assert.equal(resolveAboutMissionText("Hello mission"), "Hello mission");
  });
  it("keeps invalid JSON as-is", () => {
    assert.equal(resolveAboutMissionText("{not-json"), "{not-json");
  });
});
