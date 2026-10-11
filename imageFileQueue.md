# Image File Queue Implementation

## Overview

`imageFileQueue.js` provides a serialized execution mechanism for image file operations, ensuring that metadata writes and preview reads never occur in parallel. This prevents race conditions when multiple processes access the same image files simultaneously.

## Implementation

The queue uses a tail-based Promise pattern to serialize all operations sequentially:

```typescript
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
```

## How It Works

1. **Initial State**: `tail` starts as a resolved Promise
2. **Queue Operation**: Each operation appends itself to the tail using `.then()`
3. **Error Handling**: Both success and failure cases resolve to `undefined`, preventing errors from blocking the queue
4. **Sequential Execution**: Operations execute one after another in the order they were queued

## Usage Pattern

```typescript
const queue = createSerialQueue();

// Queue multiple operations
await queue(async () => {
  // First operation
  await processFile("file1.jpg");
});

await queue(async () => {
  // Second operation - waits for first to complete
  await processFile("file2.jpg");
});

await queue(async () => {
  // Third operation - waits for previous operations
  await processFile("file3.jpg");
});
```

## Benefits

- **Prevents Race Conditions**: Ensures only one operation accesses files at a time
- **Simple Implementation**: No external dependencies or complex state management
- **Error Resilience**: Queue continues even if individual operations fail
- **Lightweight**: Minimal overhead compared to queue implementations like `p-queue`

## When to Use

- EXIF/XMP metadata writes on the same file
- Preview generation that reads image data
- Any operation that could interfere with concurrent file access

## Limitations

- Operations execute sequentially, not in parallel (slower for independent tasks)
- No built-in timeout or cancellation mechanism
- Queue grows unbounded until tail resolves
