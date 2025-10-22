import { range } from 'lodash-es';
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
      const stream = QueryStream.empty<number>();

      const result = await stream.toArray();
      expect(result).toEqual([]);

      const items: number[] = [];
      for await (const item of stream) {
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
        })()
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
        })()
      );

      await expect(errorStream.toArray()).rejects.toThrow('Test error');
    });
  });

  describe('multiple iterators', () => {
    it('yield items from the same underlying stream (no duplicates)', async () => {
      const base = createStream(range(0, 20));
      const i1 = base[Symbol.asyncIterator]();
      const i2 = base.skip(1)[Symbol.asyncIterator]();
      const i3 = base.take(3)[Symbol.asyncIterator]();

      expect((await i1.next()).value).toBe(0);
      expect((await i1.next()).value).toBe(1);
      expect((await i2.next()).value).toBe(3); // skip 1
      expect((await i2.next()).value).toBe(4);
      expect((await i1.next()).value).toBe(5);
      expect((await i3.next()).value).toBe(6);
      expect((await i2.next()).value).toBe(7);
      expect((await i3.next()).value).toBe(8);
      expect((await i2.next()).value).toBe(9);
      expect((await i1.next()).value).toBe(10);
      expect((await i3.next()).value).toBe(11);
      expect((await i3.next()).value).toBeUndefined(); // this closes the rest
      expect((await i2.next()).value).toBeUndefined();
      expect((await i1.next()).value).toBeUndefined();
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
