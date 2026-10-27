import assert from "node:assert/strict";
import test from "node:test";
import { createServerLogger } from "./serverLogger.js";

const createCapturingOutput = () => {
  const lines = [];
  return {
    lines,
    log: (...values) => lines.push(["log", ...values]),
    error: (...values) => lines.push(["error", ...values]),
  };
};

test("redacts registered secrets from messages and details", () => {
  const output = createCapturingOutput();
  const logger = createServerLogger({ debug: true, output });
  const entries = [];
  logger.subscribe((entry) => entries.push(entry));
  logger.addSecret("super-secret-key");

  logger.info("Using key super-secret-key", {
    command: "immich-go --api-key super-secret-key",
  });

  assert.equal(entries[0].message, "Using key [REDACTED]");
  assert.deepEqual(entries[0].details, {
    command: "immich-go --api-key [REDACTED]",
  });
  assert.doesNotMatch(JSON.stringify(output.lines), /super-secret-key/);
});

test("ignores empty secrets", () => {
  const logger = createServerLogger({
    debug: true,
    output: createCapturingOutput(),
  });
  logger.addSecret("");
  logger.addSecret(undefined);
  assert.equal(logger.redact("unchanged text"), "unchanged text");
});

test("drops debug entries and skips streaming when debug is off", () => {
  const output = createCapturingOutput();
  const logger = createServerLogger({ debug: false, output });
  const entries = [];
  logger.subscribe((entry) => entries.push(entry));

  logger.debug("verbose detail");
  logger.info("started");
  logger.error("failed");

  assert.equal(entries.length, 0);
  assert.equal(output.lines.length, 2);
  assert.equal(output.lines[0][0], "log");
  assert.equal(output.lines[1][0], "error");
});

test("caps the buffer and replays it to new subscribers", () => {
  const logger = createServerLogger({
    debug: true,
    bufferSize: 2,
    output: createCapturingOutput(),
  });
  logger.info("one");
  logger.info("two");
  logger.info("three");

  const replayed = [];
  const unsubscribe = logger.subscribe((entry) => replayed.push(entry));
  assert.deepEqual(
    replayed.map((entry) => entry.message),
    ["two", "three"],
  );

  unsubscribe();
  logger.info("four");
  assert.equal(replayed.length, 2);
});

test("serializes errors in details", () => {
  const logger = createServerLogger({
    debug: true,
    output: createCapturingOutput(),
  });
  const entries = [];
  logger.subscribe((entry) => entries.push(entry));
  const error = Object.assign(new Error("spawn immich-go ENOENT"), {
    code: "ENOENT",
  });

  logger.error("immich-go could not be started.", error);

  assert.equal(entries[0].details.message, "spawn immich-go ENOENT");
  assert.equal(entries[0].details.code, "ENOENT");
});
