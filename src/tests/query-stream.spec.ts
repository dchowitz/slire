import { QueryStream } from '../lib/query-stream';

describe('QueryStream', () => {
  describe('basic functionality', () => {
    it('should convert to array', async () => {
      const data = [1, 2, 3, 4, 5];
      const stream = createStream(data);

      const result = await stream.toArray();
      expect(result).toEqual(data);
    });

    it('should support async iteration', async () => {
      const data = ['a', 'b', 'c'];
      const stream = createStream(data);

      const result: string[] = [];
      for await (const item of stream) {
        result.push(item);
      }

      expect(result).toEqual(data);
    });

    it('should handle empty streams', async () => {
      const stream1 = QueryStream.empty<number>();
      const result = await stream1.toArray();
      expect(result).toEqual([]);

      const stream2 = QueryStream.empty<number>();
      const items: number[] = [];
      for await (const item of stream2) {
        items.push(item);
      }
      expect(items).toEqual([]);
    });
  });

  describe('take operation', () => {
    it('should take first N items', async () => {
      const data = [1, 2, 3, 4, 5];
      const stream = createStream(data);

      const result = await stream.take(3).toArray();
      expect(result).toEqual([1, 2, 3]);
    });

    it('should take 0', async () => {
      const data = [1, 2, 3, 4, 5];
      const stream = createStream(data);

      const result = await stream.take(0).toArray();
      expect(result).toEqual([]);
    });

    it('should take negative amount', async () => {
      const data = [1, 2, 3, 4, 5];
      const stream = createStream(data);

      const result = await stream.take(-1).toArray();
      expect(result).toEqual([]);
    });

    it('should handle take with more items than available', async () => {
      const data = [1, 2];
      const stream = createStream(data);

      const result = await stream.take(5).toArray();
      expect(result).toEqual([1, 2]);
    });

    it('should support chaining take operations', async () => {
      const data = [1, 2, 3, 4, 5, 6];
      const stream = createStream(data);

      const result = await stream.take(4).take(2).toArray();
      expect(result).toEqual([1, 2]);
    });
  });

  describe('skip operation', () => {
    it('should skip first N items', async () => {
      const data = [1, 2, 3, 4, 5];
      const stream = createStream(data);

      const result = await stream.skip(2).toArray();
      expect(result).toEqual([3, 4, 5]);
    });

    it('should handle skip with more items than available', async () => {
      const data = [1, 2];
      const stream = createStream(data);

      const result = await stream.skip(5).toArray();
      expect(result).toEqual([]);
    });

    it('should skip 0', async () => {
      const data = [1, 2];
      const stream = createStream(data);

      const result = await stream.skip(0).toArray();
      expect(result).toEqual([1, 2]);
    });

    it('should not skip for negative amount', async () => {
      const data = [1, 2];
      const stream = createStream(data);

      const result = await stream.skip(-1).toArray();
      expect(result).toEqual([1, 2]);
    });

    it('should support chaining skip operations', async () => {
      const data = [1, 2, 3, 4, 5, 6];
      const stream = createStream(data);

      const result = await stream.skip(2).skip(1).toArray();
      expect(result).toEqual([4, 5, 6]);
    });
  });

  describe('paged operation', () => {
    it('should create pages of specified size', async () => {
      const data = [1, 2, 3, 4, 5, 6, 7];
      const stream = createStream(data);

      const pages: number[][] = [];
      for await (const page of stream.paged(3)) {
        pages.push(page);
      }

      expect(pages).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });

    it('should return no pages for page size 0', async () => {
      const data = [1, 2, 3, 4, 5, 6, 7];
      const stream = createStream(data);

      const pages: number[][] = [];
      for await (const page of stream.paged(0)) {
        pages.push(page);
      }

      expect(pages).toEqual([]);
    });

    it('should return no pages for negative page size', async () => {
      const data = [1, 2, 3, 4, 5, 6, 7];
      const stream = createStream(data);

      const pages: number[][] = [];
      for await (const page of stream.paged(-1)) {
        pages.push(page);
      }

      expect(pages).toEqual([]);
    });

    it('should handle partial last page', async () => {
      const data = [1, 2, 3, 4, 5];
      const stream = createStream(data);

      const pages: number[][] = [];
      for await (const page of stream.paged(3)) {
        pages.push(page);
      }

      expect(pages).toEqual([
        [1, 2, 3],
        [4, 5],
      ]);
    });

    it('should handle empty streams', async () => {
      const stream = QueryStream.empty<number>();

      const pages: number[][] = [];
      for await (const page of stream.paged(3)) {
        pages.push(page);
      }

      expect(pages).toEqual([]);
    });

    it('should support chaining with paged', async () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const stream = createStream(data);

      const pages: number[][] = [];
      for await (const page of stream.take(7).paged(3)) {
        pages.push(page);
      }

      expect(pages).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });
  });

  describe('chaining operations', () => {
    it('should support complex chaining', async () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const stream = createStream(data);

      // Skip 3, take 4, then page by 2
      const result = await stream.skip(3).take(4).paged(2).toArray();

      expect(result).toEqual([
        [4, 5],
        [6, 7],
      ]);
    });

    it('should maintain order through chaining', async () => {
      const data = ['a', 'b', 'c', 'd', 'e'];
      const stream = createStream(data);

      const result = await stream.skip(1).take(2).toArray();
      expect(result).toEqual(['b', 'c']);
    });
  });

  describe('error handling', () => {
    it('should handle errors in async iteration', async () => {
      const errorStream = new QueryStream(
        (async function* () {
          yield 1;
          yield 2;
          throw new Error('Test error');
          yield 3; // This should not be reached
        })(),
      );

      const result: number[] = [];
      let error: Error | undefined;

      try {
        for await (const item of errorStream) {
          result.push(item);
        }
      } catch (e) {
        error = e as Error;
      }

      expect(result).toEqual([1, 2]);
      expect(error?.message).toBe('Test error');
    });

    it('should handle errors in toArray', async () => {
      const errorStream = new QueryStream(
        (async function* () {
          yield 1;
          yield 2;
          throw new Error('Test error');
        })(),
      );

      await expect(errorStream.toArray()).rejects.toThrow('Test error');
    });
  });

  describe('consumption safeguards', () => {
    it('should prevent reusing a stream after toArray', async () => {
      const stream = createStream([1, 2, 3]);

      await stream.toArray();

      await expect(stream.toArray()).rejects.toThrow(
        'QueryStream has already been consumed and cannot be reused',
      );
    });

    it('should prevent reusing a stream after async iteration', async () => {
      const stream = createStream([1, 2, 3]);

      for await (const _ of stream) {
        // consume the stream
      }

      await expect(stream.toArray()).rejects.toThrow(
        'QueryStream has already been consumed and cannot be reused',
      );
    });

    it('should prevent chaining after consumption starts', async () => {
      const stream = createStream([1, 2, 3, 4, 5]);

      // Start consuming
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();

      // Try to chain - should fail
      expect(() => stream.take(2)).toThrow(
        'Cannot chain operations on an already-consumed QueryStream',
      );
    });

    it('should allow chaining before consumption', async () => {
      const stream = createStream([1, 2, 3, 4, 5]);

      // Chain operations before consumption - should work
      const chained = stream.skip(1).take(2);
      const result = await chained.toArray();

      expect(result).toEqual([2, 3]);
    });

    it('should prevent chaining on derived streams after consumption', async () => {
      const stream = createStream([1, 2, 3, 4, 5]);
      const derived = stream.skip(1);

      // Consume the derived stream
      await derived.toArray();

      // Try to chain on consumed derived stream - should fail
      expect(() => derived.take(2)).toThrow(
        'Cannot chain operations on an already-consumed QueryStream',
      );
    });

    it('should allow consuming different derived streams independently', async () => {
      // Each derived stream is independent once created
      const base1 = createStream([1, 2, 3, 4, 5]);
      const derived1 = base1.take(3);

      const base2 = createStream([1, 2, 3, 4, 5]);
      const derived2 = base2.skip(2);

      // Each derived stream can be consumed independently
      const result1 = await derived1.toArray();
      expect(result1).toEqual([1, 2, 3]);

      const result2 = await derived2.toArray();
      expect(result2).toEqual([3, 4, 5]);
    });

    it('should prevent multiple toArray calls', async () => {
      const stream = createStream([1, 2, 3]);

      const result1 = await stream.toArray();
      expect(result1).toEqual([1, 2, 3]);

      await expect(stream.toArray()).rejects.toThrow(
        'QueryStream has already been consumed and cannot be reused',
      );
    });

    it('should prevent mixing iteration styles', async () => {
      const stream = createStream([1, 2, 3, 4, 5]);

      // Start with for-await
      for await (const item of stream) {
        if (item === 2) break;
      }

      // Try to use toArray - should fail
      await expect(stream.toArray()).rejects.toThrow(
        'QueryStream has already been consumed and cannot be reused',
      );
    });
  });
});

// Helper function to create a QueryStream from an array
function createStream<T>(data: T[]): QueryStream<T> {
  const generator = async function* () {
    for (const item of data) {
      yield item;
    }
  };

  return new QueryStream(generator());
}
