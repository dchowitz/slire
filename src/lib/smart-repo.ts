import {
  ManagedFields,
  Projected,
  Projection,
  RepositoryConfig,
  UpdateOperation,
} from './repo-config';

// utility type to expand complex types for better IDE tooltips
type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

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
  getById(id: string): Promise<T | null>;
  getById<P extends Projection<T>>(
    id: string,
    projection: P
  ): Promise<Projected<T, P> | null>;
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
    update: UpdateOperation<Prettify<UpdateInput>>,
    options?: { includeSoftDeleted?: boolean; mergeTrace?: any }
  ): Promise<void>;
  updateMany(
    ids: string[],
    update: UpdateOperation<Prettify<UpdateInput>>,
    options?: { includeSoftDeleted?: boolean; mergeTrace?: any }
  ): Promise<void>;

  delete(id: string, options?: { mergeTrace?: any }): Promise<void>;
  deleteMany(ids: string[], options?: { mergeTrace?: any }): Promise<void>;

  find(filter: Partial<T>): Promise<T[]>;
  find<P extends Projection<T>>(
    filter: Partial<T>,
    projection: P
  ): Promise<Projected<T, P>[]>;
  findBySpec<S extends Specification<T>>(spec: S): Promise<T[]>;
  findBySpec<S extends Specification<T>, P extends Projection<T>>(
    spec: S,
    projection: P
  ): Promise<Projected<T, P>[]>;

  count(filter: Partial<T>): Promise<number>;
  countBySpec<S extends Specification<T>>(spec: S): Promise<number>;
};

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
