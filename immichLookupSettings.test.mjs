import assert from "node:assert/strict";
import test from "node:test";
import { resolveImmichLookupSettings } from "./managedImmichSettings.js";

const noManagedConfig = { serverUrl: "", adminApiKey: "" };
const saved = { serverUrl: "https://saved.test", userApiKey: "saved-key" };

test("the key from the identity provider wins over the form and the saved key", () => {
  const result = resolveImmichLookupSettings(
    saved,
    { serverUrl: "https://typed.test", userApiKey: "typed-key" },
    noManagedConfig,
    { immichApiKey: "authentik-key" },
  );
  assert.equal(result.userApiKey, "authentik-key");
});

test("the form key is the fallback when the provider supplies no key", () => {
  for (const user of [{}, { immichApiKey: "" }, { immichApiKey: undefined }]) {
    const result = resolveImmichLookupSettings(
      saved,
      { serverUrl: "https://typed.test", userApiKey: "typed-key" },
      noManagedConfig,
      user,
    );
    assert.equal(result.userApiKey, "typed-key");
    assert.equal(result.serverUrl, "https://typed.test");
  }
});

test("blank form values fall back to the saved ones", () => {
  const result = resolveImmichLookupSettings(
    saved,
    { serverUrl: " ", userApiKey: "" },
    noManagedConfig,
    {},
  );
  assert.deepEqual(
    [result.serverUrl, result.userApiKey],
    ["https://saved.test", "saved-key"],
  );
});

test("a managed IMMICH_URL wins over the form, independently of the key", () => {
  const result = resolveImmichLookupSettings(
    saved,
    { serverUrl: "https://typed.test", userApiKey: "typed-key" },
    { serverUrl: "https://managed.test", adminApiKey: "" },
    {},
  );
  assert.equal(result.serverUrl, "https://managed.test");
  assert.equal(result.userApiKey, "typed-key");
});
