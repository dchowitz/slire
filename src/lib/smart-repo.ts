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

// mapped type for projected result
type Projected<T, P extends Projection<T> | undefined> = P extends Projection<T>
  ? { [K in keyof P]: K extends keyof T ? T[K] : never }
  : T;

// timestamp configuration type
type TimestampConfig<T> = {
  createdAt?: keyof T;
  updatedAt?: keyof T;
  deletedAt?: keyof T;
};

// utility type to extract keys of properties that can be undefined
type OptionalKeys<T> = {
  [K in keyof T]: undefined extends T[K] ? K : never;
}[keyof T];

// utility type to extract keys of properties that are numbers
type NumberKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

type UpdateOperation<T> =
  | { set: Partial<T>; unset?: never }
  | { set?: never; unset: OptionalKeys<T>[] }
  | { set: Partial<T>; unset: OptionalKeys<T>[] };

type ScopeKeys<T, Scope extends Partial<T>> = Extract<keyof Scope, keyof T>;

// utility type to extract configured timestamp keys from the config
type TimestampKeys<
  T,
  Config extends TimestampConfig<T> | undefined
> = Config extends TimestampConfig<T>
  ? Extract<Config[keyof Config], keyof T>
  : never;

// utility type to extract version key from version config
type VersionKey<
  T,
  Config extends true | NumberKeys<T> | undefined
> = Config extends NumberKeys<T> ? Config : never;

const SOFT_DELETE_KEY = '_deleted';
const DEFAULT_VERSION_KEY = '_version';
const DEFAULT_CREATED_AT_KEY = '_createdAt';
const DEFAULT_UPDATED_AT_KEY = '_updatedAt';
const DEFAULT_DELETED_AT_KEY = '_deletedAt';

/**
 * Reserved fields that cannot be used in entity models.
 *
 * If you get cryptic TypeScript errors related to MongoDB operations (insertOne, findOne, etc.),
 * it's likely because your entity type contains one of these reserved fields:
 *
 * - `_id`: MongoDB's internal document ID (use `id` instead)
 * - `_deleted`: Soft delete marker (managed automatically when softDelete is enabled)
 * - `_createdAt`: Default created timestamp (managed automatically when timestamps are enabled)
 * - `_updatedAt`: Default updated timestamp (managed automatically when timestamps are enabled)
 * - `_deletedAt`: Default deleted timestamp (managed automatically when timestamps are enabled)
 * - `_version`: Default version counter (managed automatically when versioning is enabled)
 *
 * @example
 * ```typescript
 * // ❌ BAD - will cause TypeScript errors
 * type BadUser = {
 *   id: string;
 *   name: string;
 *   _updatedAt: Date; // Reserved field!
 * };
 *
 * // ✅ GOOD - use custom field names instead
 * type GoodUser = {
 *   id: string;
 *   name: string;
 *   lastModified: Date; // Custom field name
 * };
 * ```
 */
type ReservedFields =
  | '_id' // MongoDB's internal document ID
  | typeof SOFT_DELETE_KEY
  | typeof DEFAULT_CREATED_AT_KEY
  | typeof DEFAULT_UPDATED_AT_KEY
  | typeof DEFAULT_DELETED_AT_KEY
  | typeof DEFAULT_VERSION_KEY;

// MongoDB repository type with additional MongoDB-specific helpers and transaction methods
type MongoRepo<
  T extends { id: string } & { [K in ReservedFields]?: never },
  Scope extends Partial<T>,
  Entity extends Record<string, unknown>
> = SmartRepo<T, Scope, Entity> & {
  collection: Collection<any>;
  applyRepoConstraints: (
    input: any,
    options?: { includeSoftDeleted?: boolean }
  ) => any;
  buildUpdateOperation: (update: UpdateOperation<any>) => any;
  withSession(session: ClientSession): MongoRepo<T, Scope, Entity>;
  runTransaction<R>(
    operation: (txRepo: SmartRepo<T, Scope, Entity>) => Promise<R>
  ): Promise<R>;
};

// database-agnostic interface (limited to simple CRUD operations)
export type SmartRepo<
  T extends { id: string } & { [K in ReservedFields]?: never },
  Scope extends Partial<T> = {},
  Entity extends Record<string, unknown> = Omit<T, 'id' | ScopeKeys<T, Scope>>
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

  create(entity: Entity): Promise<string>;
  createMany(entities: Entity[]): Promise<string[]>;

  update(
    id: string,
    update: UpdateOperation<Entity>,
    options?: { includeSoftDeleted?: boolean }
  ): Promise<void>;
  updateMany(
    ids: string[],
    update: UpdateOperation<Entity>,
    options?: { includeSoftDeleted?: boolean }
  ): Promise<void>;

  upsert(
    entity: Entity & { id: string },
    options?: { includeSoftDeleted?: boolean }
  ): Promise<void>;
  upsertMany(
    entities: (Entity & { id: string })[],
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
 * Creates a smart MongoDB repository with type-safe CRUD operations.
 *
 * **IMPORTANT**: If you get cryptic TypeScript errors mentioning MongoDB operations
 * like `insertOne` or `findOne`, check that your entity type `T` doesn't contain
 * reserved fields like `_id`, `_deleted`, `_createdAt`, `_updatedAt`, `_deletedAt`, or `_version`.
 *
 * @template T - The entity type. Must have an `id: string` field and cannot contain reserved fields.
 * @template Scope - Partial entity type used for scoping (e.g., { organizationId: string })
 * @template TsConfig - Timestamp configuration for custom timestamp field names
 * @template VersionConfig - Version configuration (true for default `_version` or custom field name)
 * @template Entity - Derived entity type excluding id, scope, timestamp, and version fields
 *
 * @example
 * ```typescript
 * // ✅ Valid entity type
 * type User = {
 *   id: string;
 *   name: string;
 *   email: string;
 *   lastSeen?: Date; // Custom timestamp field
 * };
 *
 * const userRepo = createSmartMongoRepo<User>({ collection, mongoClient: client });
 * ```
 *
 * @example
 * ```typescript
 * // ❌ Invalid - will cause TypeScript errors
 * type BadUser = {
 *   id: string;
 *   _updatedAt: Date; // Reserved field!
 * };
 *
 * // This will fail with cryptic MongoDB-related TypeScript errors:
 * const badRepo = createSmartMongoRepo<BadUser>(collection, client);
 * ```
 */
export function createSmartMongoRepo<
  T extends { id: string } & { [K in ReservedFields]?: never },
  Scope extends Partial<T> = {},
  TsConfig extends TimestampConfig<T> | undefined = undefined,
  VersionConfig extends true | NumberKeys<T> | undefined = undefined,
  Entity extends Record<string, unknown> = Omit<
    T,
    | 'id'
    | ScopeKeys<T, Scope>
    | TimestampKeys<T, TsConfig>
    | VersionKey<T, VersionConfig>
  >
>({
  collection,
  mongoClient,
  scope = {} as Scope,
  options,
}: {
  collection: Collection<T>;
  mongoClient: MongoClient;
  scope?: Scope;
  options?: {
    generateId?: () => string;
    softDelete?: boolean;
    traceTimestamps?: true | 'mongo' | (() => Date);
    timestampKeys?: TsConfig;
    version?: VersionConfig;
    session?: ClientSession;
  };
}): MongoRepo<T, Scope, Entity> {
  const configuredKeys: string[] = [];
  const generateIdFn = options?.generateId ?? uuidv4;
  const session = options?.session;
  const softDeleteEnabled = options?.softDelete === true;
  const timestampKeys = options?.timestampKeys;

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

  const READONLY_KEYS = new Set<string>([...Object.keys(scope), 'id', '_id']);
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

  if (!timestampKeys?.createdAt) {
    HIDDEN_META_KEYS.add(CREATED_KEY);
  }
  if (!timestampKeys?.updatedAt) {
    HIDDEN_META_KEYS.add(UPDATED_KEY);
  }
  if (!timestampKeys?.deletedAt) {
    HIDDEN_META_KEYS.add(DELETED_KEY);
  }

  // add version field to hidden meta keys if using internal field
  if (versionConfig === true) {
    HIDDEN_META_KEYS.add(VERSION_KEY);
  }

  // helper to centralize timestamp handling
  type WriteOp = 'create' | 'update' | 'delete' | 'upsert';
  function applyTimestamps(op: WriteOp, mongoUpdate: any): any {
    const useMongoTimestamps = effectiveTraceTimestamps === 'mongo';
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
      case 'upsert':
        parts.$setOnInsert = { [CREATED_KEY]: now ?? new Date() }; // always use app time here as we cannot distinguish between insert and update in $currentDate
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
      case 'upsert':
        return {
          ...mongoUpdate,
          $inc: {
            ...(mongoUpdate.$inc ?? {}),
            [VERSION_KEY]: 1,
          },
        };
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

  function applyRepoConstraints(
    input: any,
    options?: { includeSoftDeleted?: boolean }
  ): any {
    const includeSoftDeleted = options?.includeSoftDeleted ?? false;
    return softDeleteEnabled && !includeSoftDeleted
      ? { ...input, ...scope, [SOFT_DELETE_KEY]: { $exists: false } }
      : { ...input, ...scope };
  }

  function validateNoReadonly(entity: any, operation: WriteOp): void {
    const entityKeys = Object.keys(entity);
    const conflictingKeys = entityKeys.filter((key) => READONLY_KEYS.has(key));

    if (conflictingKeys.length > 0) {
      throw new Error(
        `Cannot ${operation} readonly properties: ${conflictingKeys.join(', ')}`
      );
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
        result.id = mongoId;
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
    return { id: mongoId, ...filteredRest } as Projected<T, P>;
  }

  // helper to map entity to Mongo doc, omitting all undefined and readonly properties
  function toMongoDoc(entity: Entity & { id?: string }, op: WriteOp): any {
    const { id, ...entityData } = entity;
    validateNoReadonly(entityData, op);
    const filtered = Object.fromEntries(
      Object.entries(entityData).filter(([_, value]) => value !== undefined)
    );
    return { ...filtered, ...scope, _id: id ?? generateIdFn() };
  }

  // helper to build MongoDB update operation from set/unset
  function buildUpdateOperation(update: UpdateOperation<Entity>): any {
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
      validateNoReadonly(set, 'update');
      mongoUpdate.$set = set;
    }

    if (unset) {
      const conflictingUnset = unset.filter((key) =>
        READONLY_KEYS.has(String(key))
      );
      if (conflictingUnset.length > 0) {
        throw new Error(
          `Cannot unset readonly properties: ${conflictingUnset.join(', ')}`
        );
      }
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

  const repo: MongoRepo<T, Scope, Entity> = {
    getById: async <P extends Projection<T>>(
      id: string,
      projection?: P
    ): Promise<Projected<T, P> | null> => {
      const mongoProjection = projection
        ? Object.fromEntries(Object.keys(projection).map((k) => [k, 1]))
        : undefined;
      const doc = await collection.findOne(
        applyRepoConstraints({ _id: id }),
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
          applyRepoConstraints({ _id: { $in: ids } }),
          withSessionOptions(
            mongoProjection ? { projection: mongoProjection } : undefined
          )
        )
        .toArray();
      const foundIds = new Set(docs.map((doc) => doc._id as unknown as string));
      const foundDocs = docs.map((doc) => fromMongoDoc(doc, projection));
      const notFoundIds = ids.filter((id) => !foundIds.has(id));
      return [foundDocs, notFoundIds];
    },

    create: async (entity: Entity): Promise<string> => {
      const ids = await repo.createMany([entity]);
      return ids[0];
    },

    createMany: async (entities: Entity[]): Promise<string[]> => {
      if (entities.length < 1) {
        return [];
      }

      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(entities, MONGODB_MAX_MODIFICATIONS_PER_TRANSACTION);
      const allIds: string[] = [];

      for (const entityChunk of chunks) {
        const ops = entityChunk.map((e) => {
          const doc = toMongoDoc(e, 'create');
          const filter = applyRepoConstraints({ _id: doc._id });
          const update: any = applyVersion(
            'create',
            applyTimestamps('create', { $setOnInsert: doc })
          );
          return { updateOne: { filter, update, upsert: true } } as any;
        });
        const result = await collection.bulkWrite(ops, withSessionOptions());
        for (let i = 0; i < result.upsertedCount; i++) {
          allIds.push(result.upsertedIds[i]);
        }
      }

      return allIds;
    },

    update: async (
      id: string,
      update: UpdateOperation<Entity>,
      options?: { includeSoftDeleted?: boolean }
    ): Promise<void> => {
      await repo.updateMany([id], update, options);
    },

    updateMany: async (
      ids: string[],
      update: UpdateOperation<Entity>,
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
          applyRepoConstraints({ _id: { $in: idChunk } }, options),
          updateOperation,
          withSessionOptions()
        );
      }
    },

    upsert: async (
      entity: Entity & { id: string },
      options?: { includeSoftDeleted?: boolean }
    ): Promise<void> => {
      await repo.upsertMany([entity], options);
    },

    upsertMany: async (
      entities: (Entity & { id: string })[],
      options?: { includeSoftDeleted?: boolean }
    ): Promise<void> => {
      if (entities.length < 1) {
        return;
      }

      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(entities, MONGODB_MAX_MODIFICATIONS_PER_TRANSACTION);

      for (const entityChunk of chunks) {
        const ops = entityChunk.map((entity) => {
          const doc = toMongoDoc(entity, 'upsert');
          const filter = applyRepoConstraints({ _id: doc._id }, options);
          const update = applyVersion(
            'upsert',
            applyTimestamps('upsert', {
              $set: doc,
            })
          );
          return { updateOne: { filter, update, upsert: true } };
        });
        await collection.bulkWrite(ops, withSessionOptions());
      }
    },

    delete: async (id: string): Promise<void> => {
      await repo.deleteMany([id]);
    },

    deleteMany: async (ids: string[]): Promise<void> => {
      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(ids, MONGODB_IN_OPERATOR_MAX_CLAUSES);

      for (const idChunk of chunks) {
        const filter = applyRepoConstraints({ _id: { $in: idChunk } });
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
      // convert id to _id for MongoDB queries
      const { id, ...restFilter } = filter;
      const mongoFilter = id ? { _id: id, ...restFilter } : restFilter;

      const mongoProjection = projection
        ? Object.fromEntries(Object.keys(projection).map((k) => [k, 1]))
        : undefined;
      const docs = await collection
        .find(
          applyRepoConstraints(mongoFilter),
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
      // convert id to _id for MongoDB queries
      const { id, ...restFilter } = filter;
      const mongoFilter = id ? { _id: id, ...restFilter } : restFilter;
      return await collection.countDocuments(
        applyRepoConstraints(mongoFilter),
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
    collection: collection,

    // Adds scope filter and soft-delete filter (if configured), with option to include soft-deleted
    applyRepoConstraints: applyRepoConstraints,

    // Applies enrichments (such as timestamps) and enforces constraints (writing readonly props not allowed)
    buildUpdateOperation: buildUpdateOperation as (
      update: UpdateOperation<any>
    ) => any,

    // Factory method for session-aware repository
    withSession: (clientSession: ClientSession) => {
      return createSmartMongoRepo({
        collection,
        mongoClient,
        scope,
        options: { ...options, session: clientSession },
      });
    },

    // Convenience method for running multiple repo functions in a transaction
    runTransaction: async <R>(
      operation: (txRepo: SmartRepo<T, Scope, Entity>) => Promise<R>
    ): Promise<R> => {
      return mongoClient.withSession(async (clientSession) => {
        return clientSession.withTransaction(async () => {
          const txRepo = createSmartMongoRepo({
            collection,
            mongoClient,
            scope,
            options: { ...options, session: clientSession },
          });
          return operation(txRepo as SmartRepo<T, Scope, Entity>);
        });
      });
    },
  };

  return repo;
}
