import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  buildImmichUploadArguments,
  getImmichFailureHints,
  shutdownCore,
} from "./core.js";

after(() => shutdownCore());

const settings = {
  serverUrl: "https://immich.example.test",
  userApiKey: "user-key",
  adminApiKey: "admin-key",
  albumName: "Scans",
  tags: "family, 1990s",
  pauseImmichJobs: true,
  concurrentTasks: 2,
};

test("passes API keys and values as separate arguments", () => {
  const uploadArguments = buildImmichUploadArguments(settings, "/data/scans");

  assert.equal(
    uploadArguments[uploadArguments.indexOf("--api-key") + 1],
    "user-key",
  );
  assert.equal(
    uploadArguments[uploadArguments.indexOf("--admin-api-key") + 1],
    "admin-key",
  );
  assert.deepEqual(
    uploadArguments.filter((_value, index, all) => all[index - 1] === "--tag"),
    ["family", "1990s"],
  );
  assert.equal(uploadArguments.at(-1), "/data/scans");
  assert.equal(uploadArguments.includes("--log-level"), false);
});

test("requests debug logging from immich-go when debug is enabled", () => {
  const uploadArguments = buildImmichUploadArguments(settings, "/data/scans", {
    debug: true,
  });

  assert.equal(
    uploadArguments[uploadArguments.indexOf("--log-level") + 1],
    "DEBUG",
  );
  assert.equal(uploadArguments.at(-1), "/data/scans");
});

test("explains common container-only immich-go failures", () => {
  assert.match(
    getImmichFailureHints(
      "Post https://immich: tls: failed to verify certificate: x509: certificate signed by unknown authority",
    )[0],
    /TLS certificate/,
  );
  assert.match(
    getImmichFailureHints(
      "dial tcp 127.0.0.1:2283: connect: connection refused",
    )[0],
    /localhost/,
  );
  assert.deepEqual(getImmichFailureHints("upload completed"), []);
});
