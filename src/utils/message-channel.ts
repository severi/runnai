/**
 * Push-based AsyncIterable for feeding messages to the Agent SDK's
 * streaming input mode. Bridges imperative push() calls to the
 * pull-based async generator that query() expects.
 */
export interface MessageChannel<T> {
  push(value: T): void;
  close(): void;
  iterable: AsyncIterable<T>;
}

export function createMessageChannel<T>(): MessageChannel<T> {
  const queue: T[] = [];
  let resolve: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;

  let hasConsumer = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      if (hasConsumer) throw new Error("MessageChannel supports only one consumer");
      hasConsumer = true;
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise<IteratorResult<T>>((r) => {
            resolve = r;
          });
        },
        return(): Promise<IteratorResult<T>> {
          closed = true;
          return Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };

  return {
    push(value: T) {
      if (closed) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value, done: false });
      } else {
        queue.push(value);
      }
    },
    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
    },
    iterable,
  };
}
