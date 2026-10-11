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
