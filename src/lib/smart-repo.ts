import {
  ManagedFields,
  Projected,
  Projection,
  RepositoryConfig,
} from './repo-config';
import { OptionalPath, Prettify } from './types';

export type FindOptions = {
  onScopeBreach?: 'empty' | 'error';
};

export type CountOptions = {
  onScopeBreach?: 'zero' | 'error';
};

// Streaming query result - provides array and stream access
export class QueryStream<T> {
  private iterator: AsyncIterator<T>;

  constructor(iterator: AsyncIterator<T>) {
    this.iterator = iterator;
  }

  static fromIterator<T>(iterator: AsyncIterator<T>): QueryStream<T> {
    return new QueryStream(iterator);
  }

  async toArray(): Promise<T[]> {
    const results: T[] = [];
    for await (const item of this) {
      results.push(item);
    }
    return results;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iterator;
  }

  take(limit: number): QueryStream<T> {
    const iterator = this._take(limit);
    return new QueryStream(iterator);
  }

  skip(offset: number): QueryStream<T> {
    const iterator = this._skip(offset);
    return new QueryStream(iterator);
  }

  paged(pageSize: number): QueryStream<T[]> {
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

// database-agnostic interface (limited to simple CRUD operations)
export type SmartRepo<
  T extends { id: string },
  Scope extends Partial<T> = {},
  Config extends RepositoryConfig<T> = {},
  Managed extends ManagedFields<T, Config, Scope> = ManagedFields<
    T,
    Config,
    Scope
  >,
  UpdateInput extends Record<string, unknown> = Omit<T, Managed>,
  CreateInput extends Record<string, unknown> = UpdateInput &
    Partial<Pick<T, Managed>>
> = {
  getById(id: string): Promise<T | undefined>;
  getById<P extends Projection<T>>(
    id: string,
    projection: P
  ): Promise<Projected<T, P> | undefined>;
  getByIds(ids: string[]): Promise<[T[], string[]]>;
  getByIds<P extends Projection<T>>(
    ids: string[],
    projection: P
  ): Promise<[Projected<T, P>[], string[]]>;

  create(
    entity: Prettify<CreateInput>,
    options?: { mergeTrace?: any }
  ): Promise<string>;
  createMany(
    entities: Prettify<CreateInput>[],
    options?: { mergeTrace?: any }
  ): Promise<string[]>;

  update(
    id: string,
    update: UpdateOperation<UpdateInput>,
    options?: { mergeTrace?: any }
  ): Promise<void>;
  updateMany(
    ids: string[],
    update: UpdateOperation<UpdateInput>,
    options?: { mergeTrace?: any }
  ): Promise<void>;

  delete(id: string, options?: { mergeTrace?: any }): Promise<void>;
  deleteMany(ids: string[], options?: { mergeTrace?: any }): Promise<void>;

  find(filter: Partial<T>, options?: FindOptions): QueryStream<T>;
  find<P extends Projection<T>>(
    filter: Partial<T>,
    options: FindOptions & { projection: P }
  ): QueryStream<Projected<T, P>>;
  findBySpec<S extends Specification<T>>(
    spec: S,
    options?: FindOptions
  ): QueryStream<T>;
  findBySpec<S extends Specification<T>, P extends Projection<T>>(
    spec: S,
    options: FindOptions & { projection: P }
  ): QueryStream<Projected<T, P>>;

  count(filter: Partial<T>, options?: CountOptions): Promise<number>;
  countBySpec<S extends Specification<T>>(
    spec: S,
    options?: CountOptions
  ): Promise<number>;
};

export type UpdateOperation<T> =
  | { set: Partial<T>; unset?: never }
  | { set?: never; unset: OptionalPath<T> | OptionalPath<T>[] }
  | { set: Partial<T>; unset: OptionalPath<T> | OptionalPath<T>[] };

// Specification pattern types
export type Specification<T> = {
  toFilter(): Partial<T>;
  describe: string;
};

// Thrown by createMany when some but not all documents were inserted.
// Contains the list of successfully inserted public ids and the ones that failed.
export class CreateManyPartialFailure extends Error {
  insertedIds: string[];
  failedIds: string[];
  constructor(params: { insertedIds: string[]; failedIds: string[] }) {
    const total = params.insertedIds.length + params.failedIds.length;
    super(
      `createMany partially inserted ${params.insertedIds.length}/${total} entities`
    );
    this.name = 'CreateManyPartialFailure';
    this.insertedIds = params.insertedIds;
    this.failedIds = params.failedIds;
  }
}

export function combineSpecs<T>(
  ...specs: Specification<T>[]
): Specification<T> {
  return {
    toFilter: () =>
      specs.reduce(
        (filter, spec) => ({ ...filter, ...spec.toFilter() }),
        {} as Partial<T>
      ),
    describe: specs.map((spec) => spec.describe).join(' AND '),
  };
}
