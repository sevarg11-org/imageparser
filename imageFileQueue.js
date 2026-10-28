/**
 * Creates a serial execution queue that processes operations sequentially.
 *
 * This prevents concurrent access to file resources by ensuring only one
 * operation executes at a time. The tail-based Promise pattern provides
 * lightweight sequentialization without external dependencies.
 *
 * @returns {Function} A function that accepts and returns an async operation
 * @example
 * const queue = createSerialQueue();
 * await queue(async () => {
 *   await processFile('file1.jpg');
 * });
 * await queue(async () => {
 *   await processFile('file2.jpg'); // waits for file1 to complete
 * });
 */
export const createSerialQueue = () => {
  let tail = Promise.resolve();

  return (operation) => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

/**
 * Creates a lock that serializes operations per key (for example, per file path).
 *
 * Operations that share a key run in submission order without overlapping, while
 * operations on unrelated keys run concurrently. An operation can hold several keys
 * at once; it starts only after every earlier operation on any of those keys settles.
 * Keys are claimed synchronously on submission, so multi-key operations cannot deadlock.
 *
 * @returns {{run: (keys: string|string[], operation: Function) => Promise<*>, whenIdle: () => Promise<void>, size: () => number}}
 * @example
 * const lock = createKeyedQueue();
 * lock.run(["a.jpg", "b.jpg"], () => saveBoth()); // waits for earlier a.jpg and b.jpg work
 * lock.run("c.jpg", () => renderPreview()); // runs immediately
 */
export const createKeyedQueue = () => {
  const tails = new Map();

  const run = (keys, operation) => {
    const uniqueKeys = Array.from(
      new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean)),
    );
    const previous = uniqueKeys.map((key) => tails.get(key)).filter(Boolean);
    const result = Promise.all(previous).then(() => operation());
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    for (const key of uniqueKeys) {
      tails.set(key, tail);
    }
    void tail.then(() => {
      for (const key of uniqueKeys) {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    });

    return result;
  };

  /**
   * Resolves once every operation submitted so far (and any submitted while waiting) has settled.
   */
  const whenIdle = async () => {
    while (tails.size) {
      await Promise.all(tails.values());
    }
  };

  return { run, whenIdle, size: () => tails.size };
};
