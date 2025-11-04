export class QueryStream<T> {
  private iterator: AsyncIterator<T>;
  private consumed = false;

  constructor(iterator: AsyncIterator<T>) {
    this.iterator = iterator;
  }

  static empty<T>(): QueryStream<T> {
    return new QueryStream(
      (async function* () {
        // Empty generator
      })(),
    );
  }

  async toArray(): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this) {
      results.push(item);
    }
    return results;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error(
        'QueryStream has already been consumed and cannot be reused',
      );
    }
    this.consumed = true;
    return this.iterator;
  }

  take(limit: number): QueryStream<T> {
    if (this.consumed) {
      throw new Error(
        'Cannot chain operations on an already-consumed QueryStream',
      );
    }
    const iterator = this._take(limit);
    return new QueryStream(iterator);
  }

  skip(offset: number): QueryStream<T> {
    if (this.consumed) {
      throw new Error(
        'Cannot chain operations on an already-consumed QueryStream',
      );
    }
    const iterator = this._skip(offset);
    return new QueryStream(iterator);
  }

  paged(pageSize: number): QueryStream<T[]> {
    if (this.consumed) {
      throw new Error(
        'Cannot chain operations on an already-consumed QueryStream',
      );
    }
    if (pageSize < 1) {
      return QueryStream.empty();
    }

    const iterator = this._paged(pageSize);
    return new QueryStream(iterator);
  }

  private async *_take(limit: number): AsyncGenerator<T> {
    let count = 0;
    for await (const item of this) {
      if (count >= limit) break;
      yield item;
      count++;
    }
  }

  private async *_skip(offset: number): AsyncGenerator<T> {
    let count = 0;
    for await (const item of this) {
      if (count >= offset) {
        yield item;
      }
      count++;
    }
  }

  private async *_paged(pageSize: number): AsyncGenerator<T[]> {
    let currentPage: T[] = [];
    for await (const item of this) {
      currentPage.push(item);
      if (currentPage.length >= pageSize) {
        yield currentPage;
        currentPage = [];
      }
    }
    // Yield final partial page if any
    if (currentPage.length > 0) {
      yield currentPage;
    }
  }
}
