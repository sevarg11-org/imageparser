import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  buildUserContext,
  createSealedCodec,
  createUserKey,
  deriveKey,
  getCookieNames,
  parseCookies,
  serializeCookie,
} from "./auth.js";

const masterKey = randomBytes(32);
const options = {
  foldersClaim: "imageparser_folders",
  adminGroup: "imageparser-admin",
};

test("seals and opens a payload", () => {
  const codec = createSealedCodec(deriveKey(masterKey, "session"));
  const payload = { user: { username: "alice" }, expiresAt: Date.now() + 1000 };
  const sealed = codec.seal(payload);
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(codec.open(sealed), payload);
});

test("rejects tampered, foreign-key, expired, and malformed values", () => {
  const codec = createSealedCodec(deriveKey(masterKey, "session"));
  const sealed = codec.seal({ expiresAt: Date.now() + 1000 });
  const tampered = Buffer.from(sealed, "base64url");
  tampered[tampered.length - 1] ^= 1;
  assert.equal(codec.open(tampered.toString("base64url")), null);

  const loginCodec = createSealedCodec(deriveKey(masterKey, "login"));
  assert.equal(loginCodec.open(sealed), null);

  const expired = codec.seal({ expiresAt: Date.now() - 1 });
  assert.equal(codec.open(expired), null);

  for (const value of [undefined, "", "not-a-cookie", "AAAA"]) {
    assert.equal(codec.open(value), null);
  }
});

test("requires an expiry on sealed payloads", () => {
  const codec = createSealedCodec(deriveKey(masterKey, "session"));
  assert.throws(() => codec.seal({ user: {} }), /expiresAt/);
});

test("derives distinct keys per purpose", () => {
  assert.notDeepEqual(
    deriveKey(masterKey, "session"),
    deriveKey(masterKey, "login"),
  );
  assert.equal(deriveKey(masterKey, "session").length, 32);
});

test("parses cookies, keeping the first occurrence of a name", () => {
  const cookies = parseCookies("a=1; b=two=2; a=3; broken; =x");
  assert.equal(cookies.get("a"), "1");
  assert.equal(cookies.get("b"), "two=2");
  assert.equal(cookies.has("broken"), false);
  assert.equal(parseCookies(undefined).size, 0);
});

test("serializes HttpOnly Lax cookies, adding Secure only for HTTPS", () => {
  assert.equal(
    serializeCookie("s", "v", { maxAgeSeconds: 60, secure: false }),
    "s=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
  );
  assert.match(
    serializeCookie("s", "v", { maxAgeSeconds: 60, secure: true }),
    /; Secure; /,
  );
});

test("uses the __Host- prefix only for secure cookies", () => {
  assert.equal(getCookieNames(true).session, "__Host-imageparser_session");
  assert.equal(getCookieNames(false).session, "imageparser_session");
});

test("derives a path-safe user key from the subject", () => {
  for (const subject of ["../../etc", "a/b\\c", "dennis"]) {
    assert.match(createUserKey(subject), /^[0-9a-f]{64}$/);
  }
  assert.equal(createUserKey("x"), createUserKey("x"));
  assert.notEqual(createUserKey("x"), createUserKey("y"));
});

test("builds a user context from claims", () => {
  const user = buildUserContext(
    {
      sub: "subject-1",
      preferred_username: "dennis",
      groups: ["family", "imageparser-admin"],
      imageparser_folders: ["family", "../etc", "scans/2023"],
    },
    options,
  );
  assert.deepEqual(user, {
    userKey: createUserKey("subject-1"),
    username: "dennis",
    isAdmin: true,
    folders: ["family", "scans/2023"],
  });
});

test("is not an administrator without the admin group", () => {
  const user = buildUserContext(
    { sub: "s", email: "a@example.test", groups: "imageparser-admin" },
    options,
  );
  assert.equal(user.isAdmin, false);
  assert.equal(user.username, "a@example.test");
  assert.deepEqual(user.folders, []);
  assert.equal(
    buildUserContext(
      { sub: "s", groups: ["imageparser-admin"] },
      {
        ...options,
        adminGroup: "",
      },
    ).isAdmin,
    false,
  );
});

test("requires a subject claim", () => {
  assert.throws(
    () => buildUserContext({ preferred_username: "x" }, options),
    /subject/,
  );
});
