export const createSerialQueue = () => {
  let tail = Promise.resolve()

  return (operation) => {
    const result = tail.then(operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
