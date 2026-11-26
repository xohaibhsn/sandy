import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudinaryLoader,
  imageMode,
  isCloudinaryImage,
  isPrivateCloudinary,
} from "../lib/imageLoader.ts";

const CLOUD = "https://res.cloudinary.com/demo/image/upload";

describe("imageLoader", () => {
  it("isCloudinaryImage detects upload URLs", () => {
    assert.equal(isCloudinaryImage(`${CLOUD}/folder/a.jpg`), true);
    assert.equal(isCloudinaryImage("https://cdn.example.com/a.jpg"), false);
    assert.equal(isCloudinaryImage("/local.png"), false);
  });

  it("isPrivateCloudinary rejects authenticated/private", () => {
    assert.equal(
      isPrivateCloudinary(
        "https://res.cloudinary.com/demo/image/authenticated/s--xx--/v1/receipts/a.jpg"
      ),
      true
    );
    assert.equal(
      isPrivateCloudinary("https://res.cloudinary.com/demo/image/private/v1/a.jpg"),
      true
    );
    assert.equal(isPrivateCloudinary(`${CLOUD}/v1/a.jpg`), false);
  });

  it("imageMode classifies sources", () => {
    assert.equal(imageMode(""), "empty");
    assert.equal(imageMode(null), "empty");
    assert.equal(imageMode(`${CLOUD}/v1/a.jpg`), "cloudinary");
    assert.equal(imageMode("/og-default.svg"), "local");
    assert.equal(imageMode("https://images.example.com/x.jpg"), "external");
    assert.equal(
      imageMode("https://res.cloudinary.com/demo/image/private/v1/a.jpg"),
      "empty"
    );
  });

  it("cloudinaryLoader inserts f_auto,q_auto,w_ on plain upload URL", () => {
    const out = cloudinaryLoader({
      src: `${CLOUD}/folder/phone.jpg`,
      width: 640,
    });
    assert.match(out, /\/image\/upload\/f_auto,q_auto,w_640\/folder\/phone\.jpg/);
    assert.equal((out.match(/f_auto/g) || []).length, 1);
    assert.equal((out.match(/w_640/g) || []).length, 1);
  });

  it("cloudinaryLoader keeps version segment v123", () => {
    const out = cloudinaryLoader({
      src: `${CLOUD}/v123/folder/phone.jpg`,
      width: 800,
    });
    assert.match(out, /\/image\/upload\/f_auto,q_auto,w_800\/v123\/folder\/phone\.jpg/);
  });

  it("cloudinaryLoader is idempotent on already-transformed URLs", () => {
    const src = `${CLOUD}/f_auto,q_auto,w_400/v123/folder/phone.jpg`;
    const out = cloudinaryLoader({ src, width: 800 });
    assert.equal(out, src);
    assert.equal((out.match(/f_auto/g) || []).length, 1);
    assert.equal((out.match(/w_/g) || []).length, 1);
  });

  it("cloudinaryLoader merges missing w_ into existing transforms", () => {
    const src = `${CLOUD}/f_auto,q_auto/v1/x.jpg`;
    const out = cloudinaryLoader({ src, width: 320 });
    assert.match(out, /f_auto,q_auto,w_320\/v1\/x\.jpg/);
    assert.equal((out.match(/f_auto/g) || []).length, 1);
  });

  it("cloudinaryLoader preserves query string", () => {
    const out = cloudinaryLoader({
      src: `${CLOUD}/v1/a.jpg?_a=1`,
      width: 100,
    });
    assert.match(out, /\?_a=1$/);
    assert.match(out, /f_auto,q_auto,w_100\/v1\/a\.jpg/);
  });

  it("cloudinaryLoader leaves non-Cloudinary unchanged", () => {
    const src = "https://images.example.com/a.jpg";
    assert.equal(cloudinaryLoader({ src, width: 200 }), src);
  });
});
