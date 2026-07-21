/** A failure-safe FIFO for async read-modify-write operations. */
export class AsyncSerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
