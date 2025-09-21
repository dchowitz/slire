import { duplicatesBy } from '@chd/utils';
import { chunk } from 'lodash-es';
import { ClientSession, Collection, MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

// https://www.mongodb.com/resources/basics/databases/acid-transactions#:~:text=Limit%20each,1%2C000%20document%20modifications.
const MONGODB_MAX_MODIFICATIONS_PER_TRANSACTION = 1000;

// no hard limit, however, it's recommended to limit the number as one might otherwise see performance issues
// https://www.mongodb.com/docs/manual/reference/operator/query/in/#syntax
const MONGODB_IN_OPERATOR_MAX_CLAUSES = 100;

// projection type: { field1: true, field2: true }
export type Projection<T> = Partial<Record<keyof T, true>>;

// utility type to expand complex types for better IDE tooltips
type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

// mapped type for projected result
type Projected<T, P extends Projection<T> | undefined> = Prettify<
  P extends Projection<T>
    ? { [K in keyof P]: K extends keyof T ? T[K] : never }
    : T
>;

// timestamp configuration type
type TimestampConfig<T> = {
  createdAt?: keyof T;
  updatedAt?: keyof T;
  deletedAt?: keyof T;
};

// utility type to extract keys of properties that can be undefined
export type OptionalKeys<T> = {
  [K in keyof T]: undefined extends T[K] ? K : never;
}[keyof T];

// utility type to extract keys of properties that are numbers
type NumberKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

export type UpdateOperation<T> =
  | { set: Partial<T>; unset?: never }
  | { set?: never; unset: OptionalKeys<T>[] }
  | { set: Partial<T>; unset: OptionalKeys<T>[] };

export type RepositoryConfig<T> = {
  generateId?: () => string;
  softDelete?: boolean;
  traceTimestamps?: true | 'server' | (() => Date);
  timestampKeys?: TimestampConfig<T>;
  version?: true | NumberKeys<T>;
  identity?: 'synced' | 'detached';
};

// Repo-managed fields part of T (based on repo config and scope).
export type ManagedFields<
  T,
  Config extends RepositoryConfig<T>,
  Scope extends Partial<T>
> =
  | 'id'
  | Extract<keyof Scope, keyof T>
  | (Config['softDelete'] extends true
      ? Extract<typeof SOFT_DELETE_KEY, keyof T>
      : never)
  | (Config['traceTimestamps'] extends undefined
      ? never
      : Extract<
          | typeof DEFAULT_CREATED_AT_KEY
          | typeof DEFAULT_UPDATED_AT_KEY
          | typeof DEFAULT_DELETED_AT_KEY,
          keyof T
        >)
  | (Config['timestampKeys'] extends undefined
      ? never
      : Extract<
          Config['timestampKeys'][keyof Config['timestampKeys']],
          keyof T
        >)
  | (Config['version'] extends true
      ? Extract<typeof DEFAULT_VERSION_KEY, keyof T>
      : never)
  | (Config['version'] extends keyof T
      ? Extract<Config['version'], keyof T>
      : never);

const SOFT_DELETE_KEY = '_deleted';
const DEFAULT_VERSION_KEY = '_version';
const DEFAULT_CREATED_AT_KEY = '_createdAt';
const DEFAULT_UPDATED_AT_KEY = '_updatedAt';
const DEFAULT_DELETED_AT_KEY = '_deletedAt';

// MongoDB repository type with additional MongoDB-specific helpers and transaction methods
// Prettified to show expanded type in IDE tooltips instead of complex intersection
type MongoRepo<
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
> = Prettify<
  SmartRepo<T, Scope, Config, Managed, UpdateInput, CreateInput> & {
    collection: Collection<T & { _id: string }>;
    applyConstraints: (
      input: any,
      options?: { includeSoftDeleted?: boolean }
    ) => any;
    buildUpdateOperation: (update: UpdateOperation<UpdateInput>) => any;
    withSession(
      session: ClientSession
    ): MongoRepo<T, Scope, Config, Managed, UpdateInput, CreateInput>;
    runTransaction<R>(
      operation: (
        txRepo: SmartRepo<T, Scope, Config, Managed, UpdateInput, CreateInput>
      ) => Promise<R>
    ): Promise<R>;
  }
>;

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

  create(entity: Prettify<CreateInput>): Promise<string>;
  createMany(entities: Prettify<CreateInput>[]): Promise<string[]>;

  update(
    id: string,
    update: UpdateOperation<Prettify<UpdateInput>>,
    options?: { includeSoftDeleted?: boolean }
  ): Promise<void>;
  updateMany(
    ids: string[],
    update: UpdateOperation<Prettify<UpdateInput>>,
    options?: { includeSoftDeleted?: boolean }
  ): Promise<void>;

  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;

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

/**
 * Creates a MongoDB repository with type-safe CRUD operations.
 *
 * @template T The entity type (must have id: string)
 * @template Config Repository configuration options (inferred from options parameter)
 *
 * Advanced generics (Managed, UpdateInput, CreateInput) are computed automatically - you typically don't need to specify them.
 *
 * @example
 * ```typescript
 * type User = { id: string; name: string; email: string };
 * const repo = createSmartMongoRepo<User>({ collection, mongoClient });
 * // Config, Managed, and InputEntity are inferred automatically
 *
 * // With configuration:
 * const repoWithConfig = createSmartMongoRepo<User>({
 *   collection,
 *   mongoClient,
 *   options: { softDelete: true, traceTimestamps: true }
 * });
 * // InputEntity becomes: { name: string; email: string; id?: string }
 * ```
 *
 */
export function createSmartMongoRepo<
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
>({
  collection,
  mongoClient,
  scope = {} as Scope,
  options,
  session,
}: {
  collection: Collection<T>;
  mongoClient: MongoClient;
  scope?: Scope;
  options?: Config;
  session?: ClientSession;
}): MongoRepo<T, Scope, Config, Managed, UpdateInput, CreateInput> {
  const configuredKeys: string[] = [];
  const generateIdFn = options?.generateId ?? uuidv4;
  const softDeleteEnabled = options?.softDelete === true;
  const timestampKeys = options?.timestampKeys;
  const identityMode = options?.identity ?? 'synced';
  const isDetachedIdentity = identityMode === 'detached';

  // centralized id handling helpers
  const DATASTORE_ID_KEY = isDetachedIdentity ? 'id' : '_id';
  const idFilter = (id: string): any => ({ [DATASTORE_ID_KEY]: id } as any);
  const idsFilter = (ids: string[]): any =>
    ({ [DATASTORE_ID_KEY]: { $in: ids } } as any);
  const getPublicIdFromDoc = (doc: any): string =>
    isDetachedIdentity
      ? ((doc as any).id as string)
      : (doc._id as unknown as string); // in synced mode, _id is the public id and always a string
  const convertFilter = (filter: Partial<T>): any => {
    if (isDetachedIdentity) {
      return filter as any;
    }
    const { id, ...rest } = filter as any;
    return id ? ({ _id: id, ...rest } as any) : rest;
  };
  const filterForDoc = (doc: any): any =>
    isDetachedIdentity
      ? idFilter((doc as any).id)
      : ({ _id: (doc as any)._id } as any);

  // if timestampKeys are configured, enable tracing by default
  const effectiveTraceTimestamps =
    options?.traceTimestamps ?? (timestampKeys ? true : undefined);

  // version configuration
  const versionConfig = options?.version;
  const versionEnabled = versionConfig !== undefined;
  const VERSION_KEY =
    versionConfig === true
      ? DEFAULT_VERSION_KEY
      : String(versionConfig ?? DEFAULT_VERSION_KEY);

  const SCOPE_KEYS = new Set<string>([...Object.keys(scope)]);
  const READONLY_KEYS = new Set<string>(['id', '_id']);
  const HIDDEN_META_KEYS = new Set<string>([SOFT_DELETE_KEY]);

  const SOFT_DELETE_MARK = { [SOFT_DELETE_KEY]: true };

  // use configured or default timestamp keys
  const CREATED_KEY = String(
    timestampKeys?.createdAt ?? DEFAULT_CREATED_AT_KEY
  );
  const UPDATED_KEY = String(
    timestampKeys?.updatedAt ?? DEFAULT_UPDATED_AT_KEY
  );
  const DELETED_KEY = String(
    timestampKeys?.deletedAt ?? DEFAULT_DELETED_AT_KEY
  );

  if (softDeleteEnabled) {
    READONLY_KEYS.add(SOFT_DELETE_KEY);
    configuredKeys.push(SOFT_DELETE_KEY);
  }

  if (effectiveTraceTimestamps) {
    READONLY_KEYS.add(CREATED_KEY);
    READONLY_KEYS.add(UPDATED_KEY);
    READONLY_KEYS.add(DELETED_KEY);
    configuredKeys.push(CREATED_KEY, UPDATED_KEY, DELETED_KEY);
  }

  if (versionEnabled) {
    READONLY_KEYS.add(VERSION_KEY);
    configuredKeys.push(VERSION_KEY);
  }

  // validate that all configured keys are unique to prevent undefined behavior
  const duplicateKeys = duplicatesBy(configuredKeys, (key) => key);
  if (duplicateKeys.length > 0) {
    throw new Error(
      `Duplicate keys found in repository configuration: ${duplicateKeys.join(
        ', '
      )}. ` +
        'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.'
    );
  }

  // validate scope is not using any of the read-only fields (makes no sense)
  const readOnlyFieldsInScope = Object.keys(scope).filter((f) =>
    READONLY_KEYS.has(f)
  );
  if (readOnlyFieldsInScope.length > 0) {
    throw new Error(
      `Readonly fields found in scope: ${readOnlyFieldsInScope.join(', ')}`
    );
  }

  if (!timestampKeys?.createdAt) {
    HIDDEN_META_KEYS.add(CREATED_KEY);
  }
  if (!timestampKeys?.updatedAt) {
    HIDDEN_META_KEYS.add(UPDATED_KEY);
  }
  if (!timestampKeys?.deletedAt) {
    HIDDEN_META_KEYS.add(DELETED_KEY);
  }

  // add version field to hidden meta-keys if using internal field
  if (versionConfig === true) {
    HIDDEN_META_KEYS.add(VERSION_KEY);
  }

  // helper to centralize timestamp handling
  type WriteOp = 'create' | 'update' | 'delete';
  function applyTimestamps(op: WriteOp, mongoUpdate: any): any {
    const useMongoTimestamps = effectiveTraceTimestamps === 'server';
    const now =
      effectiveTraceTimestamps === true
        ? new Date()
        : typeof effectiveTraceTimestamps === 'function'
        ? effectiveTraceTimestamps()
        : undefined;

    if (!useMongoTimestamps && !now) {
      return mongoUpdate;
    }

    const parts: {
      $set?: Record<string, Date>;
      $setOnInsert?: Record<string, Date>;
      $currentDate?: Record<string, true>;
    } = {};

    switch (op) {
      case 'create':
        parts.$setOnInsert = now
          ? { [CREATED_KEY]: now, [UPDATED_KEY]: now }
          : {};
        parts.$currentDate = useMongoTimestamps
          ? { [CREATED_KEY]: true, [UPDATED_KEY]: true }
          : {};
        break;
      case 'update':
        parts.$set = now ? { [UPDATED_KEY]: now } : {};
        parts.$currentDate = useMongoTimestamps ? { [UPDATED_KEY]: true } : {};
        break;
      case 'delete':
        parts.$set = now ? { [UPDATED_KEY]: now, [DELETED_KEY]: now } : {};
        parts.$currentDate = useMongoTimestamps
          ? { [UPDATED_KEY]: true, [DELETED_KEY]: true }
          : {};
        break;
      default:
        const ex: never = op;
        throw new Error(`Unexpected op: ${ex}`);
    }

    return {
      ...mongoUpdate,
      $setOnInsert: {
        ...(mongoUpdate.$setOnInsert ?? {}),
        ...parts.$setOnInsert,
      },
      $set: { ...(mongoUpdate.$set ?? {}), ...parts.$set },
      $currentDate: {
        ...(mongoUpdate.$currentDate ?? {}),
        ...parts.$currentDate,
      },
    };
  }

  // helper to centralize version handling
  function applyVersion(op: WriteOp, mongoUpdate: any): any {
    if (!versionEnabled) {
      return mongoUpdate;
    }

    switch (op) {
      case 'create':
        return {
          ...mongoUpdate,
          $setOnInsert: {
            ...(mongoUpdate.$setOnInsert ?? {}),
            [VERSION_KEY]: 1,
          },
        };
      case 'update':
      case 'delete':
        return {
          ...mongoUpdate,
          $inc: {
            ...(mongoUpdate.$inc ?? {}),
            [VERSION_KEY]: 1,
          },
        };
      default:
        const ex: never = op;
        throw new Error(`Unexpected op: ${ex}`);
    }
  }

  function applyConstraints(
    input: any,
    options?: { includeSoftDeleted?: boolean }
  ): any {
    const includeSoftDeleted = options?.includeSoftDeleted ?? false;
    return softDeleteEnabled && !includeSoftDeleted
      ? { ...input, ...scope, [SOFT_DELETE_KEY]: { $exists: false } }
      : { ...input, ...scope };
  }

  function validateNoReadonly(
    keys: string[],
    operation: WriteOp | 'unset'
  ): void {
    const readonlyKeys = keys.filter((key) => READONLY_KEYS.has(key));

    // For update and unset operations, also check scope keys are not being modified
    const scopeKeys =
      operation === 'update' || operation === 'unset'
        ? keys.filter((key) => SCOPE_KEYS.has(key))
        : [];

    const conflictingKeys = [...readonlyKeys, ...scopeKeys];

    if (conflictingKeys.length > 0) {
      throw new Error(
        `Cannot ${operation} readonly properties: ${conflictingKeys.join(', ')}`
      );
    }
  }

  function validateScopeProperties(
    entity: any,
    operation: WriteOp | 'unset'
  ): void {
    for (const [key, expectedValue] of Object.entries(scope)) {
      if (key in entity && entity[key] !== expectedValue) {
        throw new Error(
          `Cannot ${operation} entity: scope property '${key}' must be '${expectedValue}', got '${entity[key]}'`
        );
      }
    }
  }

  // helper to map Mongo doc to entity
  function fromMongoDoc<P extends Projection<T>>(
    doc: any,
    projection?: P
  ): Projected<T, P> {
    const { _id: mongoId, ...rest } = doc;

    // if the projection is specified, only include id if it's in the projection
    if (projection) {
      const projectedFields = Object.keys(projection);
      const result: any = {};

      // always include id if it's in the projection
      if (projectedFields.includes('id')) {
        result.id = isDetachedIdentity ? (rest as any).id : mongoId;
      }

      // include other projected fields
      for (const field of projectedFields) {
        if (field !== 'id' && field in rest) {
          result[field] = rest[field];
        }
      }

      return result as Projected<T, P>;
    }

    // no projection, return all fields except hidden meta-keys
    const filteredRest = Object.fromEntries(
      Object.entries(rest).filter(([k]) => !HIDDEN_META_KEYS.has(k))
    );
    if (isDetachedIdentity) {
      // in detached mode, the entity already contains its business id field
      return { ...(filteredRest as any) } as Projected<T, P>;
    }
    return { id: mongoId, ...filteredRest } as Projected<T, P>;
  }

  // helper to map entity to Mongo doc, omitting all undefined properties and system fields (system fields auto-managed)
  function toMongoDoc(entity: CreateInput, op: 'create'): any {
    const { id, ...entityData } = entity;
    // Remove _id if it exists (shouldn't but might be present in some edge cases)
    const { _id, ...cleanEntityData } = entityData as any;
    validateScopeProperties(cleanEntityData, op);

    // Strip all system-managed fields to prevent external manipulation
    const strippedEntityData = Object.fromEntries(
      Object.entries(cleanEntityData).filter(([key]) => !READONLY_KEYS.has(key))
    );

    const filtered = deepFilterUndefined(strippedEntityData);

    // identity handling
    if (isDetachedIdentity) {
      // business id and internal id are different
      const businessId = generateIdFn();
      const internalId = generateIdFn();
      return { ...filtered, ...scope, id: businessId, _id: internalId };
    } else {
      // synced: use single id for both
      const syncId = generateIdFn();
      return { ...filtered, ...scope, _id: syncId };
    }
  }

  // helper to build MongoDB update operation from set/unset
  function buildUpdateOperation(update: UpdateOperation<UpdateInput>): any {
    const { set, unset } = update;
    const mongoUpdate: any = {}; // cast to any due to MongoDB's complex UpdateFilter type system

    if (set && unset) {
      // check for overlapping keys
      const setKeys = Object.keys(set);
      const overlappingKeys = setKeys.filter((key) =>
        unset.includes(key as any)
      );
      if (overlappingKeys.length > 0) {
        throw new Error(
          `Cannot set and unset the same fields: ${overlappingKeys.join(', ')}`
        );
      }
    }

    if (set) {
      validateNoReadonly(Object.keys(set), 'update');
      mongoUpdate.$set = deepFilterUndefined(set);
    }

    if (unset) {
      validateNoReadonly(unset.map(String), 'unset');
      mongoUpdate.$unset = unset.reduce((acc, key) => {
        acc[String(key)] = '';
        return acc;
      }, {} as Record<string, string>);
    }

    return applyVersion('update', applyTimestamps('update', mongoUpdate));
  }

  // helper to add session to MongoDB operations when provided
  function withSessionOptions(mongoOptions: any = {}): any {
    return session ? { ...mongoOptions, session } : mongoOptions;
  }

  const repo: MongoRepo<T, Scope, Config, Managed, UpdateInput, CreateInput> = {
    getById: async <P extends Projection<T>>(
      id: string,
      projection?: P
    ): Promise<Projected<T, P> | null> => {
      const mongoProjection = projection
        ? Object.fromEntries(Object.keys(projection).map((k) => [k, 1]))
        : undefined;
      const doc = await collection.findOne(
        applyConstraints(idFilter(id)),
        withSessionOptions(
          mongoProjection ? { projection: mongoProjection } : undefined
        )
      );
      return doc ? fromMongoDoc(doc, projection) : null;
    },

    getByIds: async <P extends Projection<T>>(
      ids: string[],
      projection?: P
    ): Promise<[Projected<T, P>[], string[]]> => {
      const mongoProjection = projection
        ? Object.fromEntries(Object.keys(projection).map((k) => [k, 1]))
        : undefined;
      const docs = await collection
        .find(
          applyConstraints(idsFilter(ids)),
          withSessionOptions(
            mongoProjection ? { projection: mongoProjection } : undefined
          )
        )
        .toArray();
      const foundIds = new Set(docs.map((doc) => getPublicIdFromDoc(doc)));
      const foundDocs = docs.map((doc) => fromMongoDoc(doc, projection));
      const notFoundIds = ids.filter((id) => !foundIds.has(id));
      return [foundDocs, notFoundIds];
    },

    create: async (entity: CreateInput): Promise<string> => {
      const ids = await repo.createMany([entity]);
      return ids[0];
    },

    createMany: async (entities: CreateInput[]): Promise<string[]> => {
      if (entities.length < 1) {
        return [];
      }

      // prepare all docs upfront so we have stable ids for reporting
      const preparedDocs = entities.map((e) => toMongoDoc(e, 'create'));
      const preparedPublicIds = preparedDocs.map((doc) =>
        getPublicIdFromDoc(doc as any)
      );

      const insertedSoFar: string[] = [];

      // process in batches to respect MongoDB limitations
      for (
        let offset = 0;
        offset < preparedDocs.length;
        offset += MONGODB_MAX_MODIFICATIONS_PER_TRANSACTION
      ) {
        const batch = preparedDocs.slice(
          offset,
          offset + MONGODB_MAX_MODIFICATIONS_PER_TRANSACTION
        );
        const ops = batch.map((doc) => {
          const filter = applyConstraints(filterForDoc(doc));
          const update: any = applyVersion(
            'create',
            applyTimestamps('create', { $setOnInsert: doc })
          );
          return { updateOne: { filter, update, upsert: true } } as any;
        });
        const result = await collection.bulkWrite(ops, withSessionOptions());

        if (result.upsertedCount !== ops.length) {
          const upserted = ((result as any).upsertedIds || {}) as Record<
            string,
            unknown
          >;

          // split current batch into inserted/failed
          const failedInCurrent: string[] = [];
          for (let i = 0; i < batch.length; i++) {
            const id = preparedPublicIds[offset + i];
            if (Object.prototype.hasOwnProperty.call(upserted, String(i))) {
              insertedSoFar.push(id);
            } else {
              failedInCurrent.push(id);
            }
          }

          // all subsequent batches are skipped
          const skipped = preparedPublicIds.slice(offset + batch.length);

          throw new CreateManyPartialFailure({
            insertedIds: insertedSoFar,
            failedIds: [...failedInCurrent, ...skipped],
          });
        }

        // record successful inserts for this batch
        insertedSoFar.push(
          ...preparedPublicIds.slice(offset, offset + batch.length)
        );
      }

      // success: return ids in input order
      return preparedPublicIds;
    },

    update: async (
      id: string,
      update: UpdateOperation<UpdateInput>,
      options?: { includeSoftDeleted?: boolean }
    ): Promise<void> => {
      await repo.updateMany([id], update as any, options);
    },

    updateMany: async (
      ids: string[],
      update: UpdateOperation<UpdateInput>,
      options?: { includeSoftDeleted?: boolean }
    ): Promise<void> => {
      if (ids.length < 1) {
        return;
      }

      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(ids, MONGODB_IN_OPERATOR_MAX_CLAUSES);

      for (const idChunk of chunks) {
        const updateOperation = buildUpdateOperation(update);
        await collection.updateMany(
          applyConstraints(idsFilter(idChunk), options),
          updateOperation,
          withSessionOptions()
        );
      }
    },

    delete: async (id: string): Promise<void> => {
      await repo.deleteMany([id]);
    },

    deleteMany: async (ids: string[]): Promise<void> => {
      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(ids, MONGODB_IN_OPERATOR_MAX_CLAUSES);

      for (const idChunk of chunks) {
        const filter = applyConstraints(idsFilter(idChunk));
        if (softDeleteEnabled) {
          const updateOperation = applyVersion(
            'delete',
            applyTimestamps('delete', { $set: SOFT_DELETE_MARK })
          );
          await collection.updateMany(
            filter,
            updateOperation,
            withSessionOptions()
          );
        } else {
          await collection.deleteMany(filter, withSessionOptions());
        }
      }
    },

    find: async <P extends Projection<T>>(
      filter: Partial<T>,
      projection?: P
    ): Promise<Projected<T, P>[]> => {
      if (
        Object.entries(scope).some(
          ([k, v]) =>
            (filter as any)[k] !== undefined && v !== (filter as any)[k]
        )
      ) {
        // result is empty for attempted scope breach
        return [];
      }

      const mongoFilter = convertFilter(filter);

      const mongoProjection = projection
        ? Object.fromEntries(Object.keys(projection).map((k) => [k, 1]))
        : undefined;
      const docs = await collection
        .find(
          applyConstraints(mongoFilter),
          withSessionOptions(
            mongoProjection ? { projection: mongoProjection } : undefined
          )
        )
        .toArray();

      return docs.map((doc) => fromMongoDoc(doc, projection));
    },

    findBySpec: async <P extends Projection<T>>(
      spec: Specification<T>,
      projection?: P
    ): Promise<Projected<T, P>[]> => {
      return repo.find(spec.toFilter(), projection as P);
    },

    count: async (filter: Partial<T>): Promise<number> => {
      const mongoFilter = convertFilter(filter);
      return await collection.countDocuments(
        applyConstraints(mongoFilter),
        withSessionOptions()
      );
    },

    countBySpec: async (spec: Specification<T>): Promise<number> => {
      return repo.count(spec.toFilter());
    },

    // To be used when simple CRUD methods are not enough and direct data access
    // via Mongo SDK is required.
    // Aims to apply persistence settings configured for the repo without code duplication
    // in such situations.

    // Repo collection reference
    collection: collection as unknown as Collection<T & { _id: string }>,

    // Adds scope filter and soft-delete filter (if configured), with option to include soft-deleted
    applyConstraints: applyConstraints,

    // Applies enrichments (such as timestamps) and enforces constraints (writing readonly props not allowed)
    buildUpdateOperation: buildUpdateOperation,

    // Factory method for session-aware repository
    withSession: (clientSession: ClientSession) => {
      return createSmartMongoRepo({
        collection,
        mongoClient,
        scope,
        options: { ...options },
        session: clientSession,
      });
    },

    // Convenience method for running multiple repo functions in a transaction
    runTransaction: async <R>(
      operation: (
        txRepo: SmartRepo<T, Scope, Config, Managed, UpdateInput, CreateInput>
      ) => Promise<R>
    ): Promise<R> => {
      return mongoClient.withSession(async (clientSession) => {
        return clientSession.withTransaction(async () => {
          const txRepo = repo.withSession(clientSession);
          return operation(txRepo);
        });
      });
    },
  };

  return repo;
}

// helper to recursively remove undefined properties from objects
function deepFilterUndefined(obj: any): any {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }

  // Handle arrays - preserve undefined elements (they become null in MongoDB)
  if (Array.isArray(obj)) {
    return obj.map(deepFilterUndefined);
  }

  // Handle Date and other special objects - don't filter their properties
  if (
    obj instanceof Date ||
    obj instanceof RegExp ||
    obj.constructor !== Object
  ) {
    return obj;
  }

  // Handle plain objects - recursively filter undefined properties
  const filtered: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      filtered[key] = deepFilterUndefined(value);
    }
  }
  return filtered;
}
