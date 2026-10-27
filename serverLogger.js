/**
 * The supported log levels, ordered from most to least verbose.
 * @type {ReadonlyArray<string>}
 */
const logLevels = Object.freeze(["debug", "info", "warn", "error"]);

/**
 * The replacement text written in place of registered secrets.
 */
const redactedText = "[REDACTED]";

/**
 * Converts log details into JSON-safe values, expanding Error objects that
 * would otherwise serialize as empty objects.
 * @param {*} value - The detail value to serialize.
 * @returns {*} A JSON-safe copy of the value.
 */
const serializeDetails = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      nested instanceof Error
        ? {
            name: nested.name,
            message: nested.message,
            code: nested.code,
            stack: nested.stack,
          }
        : nested,
    ) ?? "null",
  );

/**
 * Creates a server logger that writes to the console and, when debug mode is
 * enabled, buffers entries and pushes them to subscribers (for example the
 * browser debug-log stream).
 * @param {{debug?: boolean, bufferSize?: number, output?: {log: Function, error: Function}}} [options]
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, addSecret: Function, redact: Function, subscribe: Function, isDebug: boolean}}
 */
const createServerLogger = ({
  debug = false,
  bufferSize = 200,
  output = console,
} = {}) => {
  const secrets = new Set();
  const subscribers = new Set();
  const buffer = [];

  /**
   * Replaces every registered secret in the text with a redaction marker.
   * @param {string} text - The text to redact.
   * @returns {string} The redacted text.
   */
  const redact = (text) =>
    [...secrets]
      .sort((left, right) => right.length - left.length)
      .reduce(
        (redactedOutput, secret) =>
          redactedOutput.split(secret).join(redactedText),
        String(text),
      );

  /**
   * Registers a value that must never appear in log output.
   * @param {string} value - The secret value.
   */
  const addSecret = (value) => {
    const secret = String(value ?? "").trim();
    if (secret) {
      secrets.add(secret);
    }
  };

  /**
   * Records a log entry at the given level.
   * @param {string} level - One of the supported log levels.
   * @param {string} message - The log message.
   * @param {*} [details] - Optional structured details.
   */
  const write = (level, message, details) => {
    if (level === "debug" && !debug) {
      return;
    }

    const entry = { time: new Date().toISOString(), level, message: "" };
    try {
      entry.message = redact(message);
      if (details !== undefined) {
        entry.details = JSON.parse(
          redact(JSON.stringify(serializeDetails(details))),
        );
      }
    } catch {
      entry.details = "[unserializable details]";
    }

    const line = `${entry.time} ${level.toUpperCase()} ${entry.message}`;
    const consoleArguments =
      entry.details === undefined ? [line] : [line, entry.details];
    if (level === "warn" || level === "error") {
      output.error(...consoleArguments);
    } else {
      output.log(...consoleArguments);
    }

    if (!debug) {
      return;
    }

    buffer.push(entry);
    if (buffer.length > bufferSize) {
      buffer.splice(0, buffer.length - bufferSize);
    }
    for (const subscriber of subscribers) {
      subscriber(entry);
    }
  };

  /**
   * Subscribes to log entries, replaying buffered entries first.
   * Only receives entries when debug mode is enabled.
   * @param {(entry: {time: string, level: string, message: string, details?: *}) => void} subscriber
   * @returns {() => void} A function that removes the subscription.
   */
  const subscribe = (subscriber) => {
    for (const entry of buffer) {
      subscriber(entry);
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  };

  return {
    ...Object.fromEntries(
      logLevels.map((level) => [
        level,
        (message, details) => write(level, message, details),
      ]),
    ),
    addSecret,
    redact,
    subscribe,
    isDebug: debug,
  };
};

export { createServerLogger, logLevels };
