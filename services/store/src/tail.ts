/**
 * The write-behind queue every cache-then-persist store rides: writes are
 * serialized on a moving tail, the FIRST failure since the last flush is
 * recorded (one failed write must not wedge the queue), and `flush()` drains
 * until quiescent — writes enqueued DURING the drain (an event bus keeps
 * firing during shutdown) are drained too — then throws that failure. The
 * promise `enqueue` returns still rejects for callers that await directly.
 */
export class WriteTail {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private failure: unknown;

  enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work);
    this.tail = next.then(
      () => undefined,
      (err) => {
        if (!this.failed) {
          this.failed = true;
          this.failure = err;
        }
      },
    );
    return next;
  }

  async flush(): Promise<void> {
    let snapshot: Promise<void>;
    do {
      snapshot = this.tail;
      await snapshot;
    } while (snapshot !== this.tail);
    if (this.failed) {
      const err = this.failure;
      this.failed = false;
      this.failure = undefined;
      throw err;
    }
  }
}
