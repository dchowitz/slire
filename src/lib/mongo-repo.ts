import { chunk } from 'lodash-es';
import { ClientSession, Collection, MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  ManagedFields,
  Projected,
  Projection,
  repoConfig,
  RepositoryConfig,
  UpdateOperation,
  WriteOp,
} from './repo-config';
import {
  CreateManyPartialFailure,
  SmartRepo,
  Specification,
} from './smart-repo';
import { Prettify } from './types';

// https://www.mongodb.com/resources/basics/databases/acid-transactions#:~:text=Limit%20each,1%2C000%20document%20modifications.
const MONGODB_MAX_MODIFICATIONS_PER_TRANSACTION = 1000;

// no hard limit, however, it's recommended to limit the number as one might otherwise see performance issues
// https://www.mongodb.com/docs/manual/reference/operator/query/in/#syntax
const MONGODB_IN_OPERATOR_MAX_CLAUSES = 100;

// MongoDB repository type with additional MongoDB-specific helpers and transaction methods
// Prettified to show expanded type in IDE tooltips instead of complex intersection
export type MongoRepo<
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
    buildUpdateOperation: (
      update: UpdateOperation<UpdateInput>,
      mergeTrace?: any
    ) => any;
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
  traceContext,
  options,
  session,
}: {
  collection: Collection<T>;
  mongoClient: MongoClient;
  scope?: Scope;
  traceContext?: any;
  options?: Config;
  session?: ClientSession;
}): MongoRepo<T, Scope, Config, Managed, UpdateInput, CreateInput> {
  const config = repoConfig(options ?? ({} as Config), traceContext, scope);

  const generateIdFn = options?.generateId ?? uuidv4;
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

  const SOFT_DELETE_MARK = { [config.getSoftDeleteKey()]: true };

  const timestampKeys = config.getTimestampKeys();
  const CREATED_KEY = timestampKeys.createdAt;
  const UPDATED_KEY = timestampKeys.updatedAt;
  const DELETED_KEY = timestampKeys.deletedAt;

  // MongoDB-specific timestamp handling using shared config
  function applyTimestamps(op: WriteOp, mongoUpdate: any): any {
    if (!config.timestampsEnabled) {
      return mongoUpdate;
    }

    const useMongoTimestamps = config.shouldUseServerTimestamp();
    const now = config.getTimestamp();

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

  // MongoDB-specific version handling using shared config
  function applyVersion(op: WriteOp, mongoUpdate: any): any {
    if (!config.shouldIncrementVersion()) {
      return mongoUpdate;
    }

    const versionKey = config.getVersionKey();

    switch (op) {
      case 'create':
        return {
          ...mongoUpdate,
          $setOnInsert: {
            ...(mongoUpdate.$setOnInsert ?? {}),
            [versionKey]: 1,
          },
        };
      case 'update':
      case 'delete':
        return {
          ...mongoUpdate,
          $inc: {
            ...(mongoUpdate.$inc ?? {}),
            [versionKey]: 1,
          },
        };
      default:
        const ex: never = op;
        throw new Error(`Unexpected op: ${ex}`);
    }
  }

  // MongoDB-specific trace handling using shared config
  function applyTrace(
    op: WriteOp,
    mongoUpdate: any,
    contextOverride?: any
  ): any {
    if (!config.traceEnabled) {
      return mongoUpdate;
    }

    const traceValue = config.buildTraceContext(op, contextOverride);
    if (!traceValue) {
      return mongoUpdate;
    }

    const traceStrategy = config.getTraceStrategy();
    const traceKey = config.getTraceKey();

    if (traceStrategy === 'latest') {
      return {
        ...mongoUpdate,
        $set: {
          ...(mongoUpdate.$set ?? {}),
          [traceKey]: traceValue,
        },
      };
    } else if (traceStrategy === 'bounded') {
      return {
        ...mongoUpdate,
        $push: {
          ...(mongoUpdate.$push ?? {}),
          [traceKey]: {
            $each: [traceValue],
            $slice: -(config.getTraceLimit() as number),
          },
        },
      };
    }

    return mongoUpdate;
  }

  function applyConstraints(
    input: any,
    options?: { includeSoftDeleted?: boolean }
  ): any {
    const includeSoftDeleted = options?.includeSoftDeleted ?? false;
    return config.softDeleteEnabled && !includeSoftDeleted
      ? {
          ...input,
          ...scope,
          [config.getSoftDeleteKey()]: { $exists: false },
        }
      : { ...input, ...scope };
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
      Object.entries(rest).filter(([k]) => !config.isHiddenField(k))
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
    config.validateScopeProperties(cleanEntityData, op);

    // Strip all system-managed fields to prevent external manipulation
    const strippedEntityData = Object.fromEntries(
      Object.entries(cleanEntityData).filter(
        ([key]) => !config.isReadOnlyField(key)
      )
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
  function buildUpdateOperation(
    update: UpdateOperation<UpdateInput>,
    mergeTrace?: any
  ): any {
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
      config.validateNoReadonly(Object.keys(set), 'update');
      mongoUpdate.$set = deepFilterUndefined(set);
    }

    if (unset) {
      config.validateNoReadonly(unset.map(String), 'unset');
      mongoUpdate.$unset = unset.reduce((acc, key) => {
        acc[String(key)] = '';
        return acc;
      }, {} as Record<string, string>);
    }

    return applyTrace(
      'update',
      applyVersion('update', applyTimestamps('update', mongoUpdate)),
      mergeTrace
    );
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

    create: async (
      entity: CreateInput,
      options?: { mergeTrace?: any }
    ): Promise<string> => {
      const ids = await repo.createMany([entity], options);
      return ids[0];
    },

    createMany: async (
      entities: CreateInput[],
      options?: { mergeTrace?: any }
    ): Promise<string[]> => {
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
          const update: any = applyTrace(
            'create',
            applyVersion(
              'create',
              applyTimestamps('create', { $setOnInsert: doc })
            ),
            options?.mergeTrace
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
      options?: { includeSoftDeleted?: boolean; mergeTrace?: any }
    ): Promise<void> => {
      await repo.updateMany([id], update as any, options);
    },

    updateMany: async (
      ids: string[],
      update: UpdateOperation<UpdateInput>,
      options?: { includeSoftDeleted?: boolean; mergeTrace?: any }
    ): Promise<void> => {
      if (ids.length < 1) {
        return;
      }

      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(ids, MONGODB_IN_OPERATOR_MAX_CLAUSES);

      for (const idChunk of chunks) {
        const updateOperation = buildUpdateOperation(
          update,
          options?.mergeTrace
        );
        await collection.updateMany(
          applyConstraints(idsFilter(idChunk), options),
          updateOperation,
          withSessionOptions()
        );
      }
    },

    delete: async (
      id: string,
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      await repo.deleteMany([id], options);
    },

    deleteMany: async (
      ids: string[],
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      // use chunking for large batches to avoid MongoDB limitations
      const chunks = chunk(ids, MONGODB_IN_OPERATOR_MAX_CLAUSES);

      for (const idChunk of chunks) {
        const filter = applyConstraints(idsFilter(idChunk));
        if (config.softDeleteEnabled) {
          const updateOperation = applyTrace(
            'delete',
            applyVersion(
              'delete',
              applyTimestamps('delete', { $set: SOFT_DELETE_MARK })
            ),
            options?.mergeTrace
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
      if (config.detectScopeBreach(filter)) {
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
      if (config.detectScopeBreach(filter)) {
        // result is 0 for attempted scope breach
        return 0;
      }

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
        traceContext,
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
