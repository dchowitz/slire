import { QueryStream } from './query-stream';
import {
  ManagedFields,
  Projected,
  Projection,
  RepositoryConfig,
} from './repo-config';
import { OptionalPropPath, Prettify, PrimitivePropPath } from './types';

export type FindOptions<T> = {
  onScopeBreach?: 'empty' | 'error';
  orderBy?: OrderBy<T>;
};

export type OrderBy<T> = Partial<Record<PrimitivePropPath<T>, SortDirection>>;
export type SortDirection =
  | 1
  | -1
  | 'asc'
  | 'desc'
  | 'ascending'
  | 'descending';

export type CountOptions = {
  onScopeBreach?: 'zero' | 'error';
};

export type FindPageOptions<T> = {
  startAfter?: string;
  limit: number;
  orderBy?: OrderBy<T>;
  onScopeBreach?: 'empty' | 'error';
};

export type PageResult<T> = {
  items: T[];
  nextStartAfter: string | undefined;
};

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

  find(filter: Partial<T>, options?: FindOptions<T>): QueryStream<T>;
  find<P extends Projection<T>>(
    filter: Partial<T>,
    options: FindOptions<T> & { projection: P }
  ): QueryStream<Projected<T, P>>;
  findBySpec<S extends Specification<T>>(
    spec: S,
    options?: FindOptions<T>
  ): QueryStream<T>;
  findBySpec<S extends Specification<T>, P extends Projection<T>>(
    spec: S,
    options: FindOptions<T> & { projection: P }
  ): QueryStream<Projected<T, P>>;

  findPage(
    filter: Partial<T>,
    options: FindPageOptions<T>
  ): Promise<PageResult<T>>;
  findPage<P extends Projection<T>>(
    filter: Partial<T>,
    options: FindPageOptions<T> & { projection: P }
  ): Promise<PageResult<Projected<T, P>>>;

  count(filter: Partial<T>, options?: CountOptions): Promise<number>;
  countBySpec<S extends Specification<T>>(
    spec: S,
    options?: CountOptions
  ): Promise<number>;
};

export type UpdateOperation<T> =
  | { set: Partial<T>; unset?: never }
  | { set?: never; unset: OptionalPropPath<T> | OptionalPropPath<T>[] }
  | { set: Partial<T>; unset: OptionalPropPath<T> | OptionalPropPath<T>[] };

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

export function isAscending(direction: SortDirection): boolean {
  return direction === 'asc' || direction === 'ascending' || direction === 1;
}
