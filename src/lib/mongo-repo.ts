import { chunk } from 'lodash-es';
import {
  ClientSession,
  Collection,
  MongoClient,
  ObjectId,
  MinKey,
} from 'mongodb';
import { QueryStream } from './query-stream';
import {
  ManagedFields,
  Projected,
  Projection,
  repoConfig,
  RepositoryConfig,
  WriteOp,
} from './repo-config';
import {
  CreateManyPartialFailure,
  isAscending,
  OrderBy,
  SmartRepo,
  SortDirection,
  Specification,
  UpdateOperation,
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
    applyConstraints: (input: any) => any;
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

  // Identity configuration
  const idKey = config.idKey;
  const mirrorId = config.mirrorId;
  const useServerIds = config.idStrategy === 'server';
  const generateDocId = (): any =>
    useServerIds ? new ObjectId() : (config.idStrategy as () => string)();
  const toMongoId = (id: string): any => (useServerIds ? new ObjectId(id) : id);
  const fromMongoId = (id: any): string =>
    useServerIds ? (id as ObjectId).toHexString() : (id as string);

  // centralized id handling helpers
  const idFilter = (id: string): any => ({ _id: toMongoId(id) } as any);
  const idsFilter = (ids: string[]): any =>
    ({ _id: { $in: ids.map(toMongoId) } } as any);
  const getPublicIdFromDoc = (doc: any): string =>
    fromMongoId((doc as any)._id);
  const convertFilter = (filter: Partial<T>): any => {
    const f: any = { ...filter };
    if (f[idKey] !== undefined) {
      const val = f[idKey];
      delete f[idKey];
      f._id = toMongoId(val as string);
    }
    return f;
  };
  const filterForDoc = (doc: any): any => ({ _id: (doc as any)._id } as any);

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
    const traceValue = config.buildTraceContext(op, contextOverride);
    if (!traceValue) {
      return mongoUpdate;
    }

    const traceStrategy = config.getTraceStrategy();
    const traceKey = config.getTraceKey();
    const needsServerTimestamp =
      !traceValue._at && config.shouldUseServerTimestamp();

    if (traceStrategy === 'latest') {
      const result = {
        ...mongoUpdate,
        $set: {
          ...(mongoUpdate.$set ?? {}),
          [traceKey]: traceValue,
        },
      };

      // Add server timestamp for _at field if needed
      if (needsServerTimestamp) {
        result.$currentDate = {
          ...(mongoUpdate.$currentDate ?? {}),
          [`${traceKey}._at`]: true,
        };
      }

      return result;
    } else if (traceStrategy === 'bounded') {
      // For bounded strategy with server timestamps, add client timestamp to avoid complexity
      const finalTraceValue = needsServerTimestamp
        ? { ...traceValue, _at: new Date() }
        : traceValue;

      return {
        ...mongoUpdate,
        $push: {
          ...(mongoUpdate.$push ?? {}),
          [traceKey]: {
            $each: [finalTraceValue],
            $slice: -(config.getTraceLimit() as number),
          },
        },
      };
    } else if (traceStrategy === 'unbounded') {
      // For unbounded strategy with server timestamps, add client timestamp to avoid complexity
      const finalTraceValue = needsServerTimestamp
        ? { ...traceValue, _at: new Date() }
        : traceValue;

      return {
        ...mongoUpdate,
        $push: {
          ...(mongoUpdate.$push ?? {}),
          [traceKey]: finalTraceValue,
        },
      };
    }

    return mongoUpdate;
  }

  function applyConstraints(input: any): any {
    return {
      ...input,
      ...scope,
      ...(config.softDeleteEnabled
        ? { [config.getSoftDeleteKey()]: { $exists: false } }
        : undefined),
    };
  }

  // helper to map Mongo doc to entity
  function fromMongoDoc<P extends Projection<T> | undefined>(
    doc: any,
    projection?: P
  ): Projected<T, P> {
    const { _id: mongoId, ...rest } = doc;

    // if the projection is specified, only include id if it's in the projection
    if (projection) {
      const projectedFields = Object.keys(projection);
      const result: any = {};

      // include idKey if requested (computed)
      if (projectedFields.includes(idKey)) {
        result[idKey] = fromMongoId(mongoId);
      }

      // include other projected fields
      for (const field of projectedFields) {
        if (field !== idKey && field in rest) {
          result[field] = rest[field];
        }
      }

      return result as Projected<T, P>;
    }

    // no projection, return all fields except hidden meta-keys
    const filteredRest = Object.fromEntries(
      Object.entries(rest).filter(([k]) => !config.isHiddenField(k))
    );
    return { [idKey]: fromMongoId(mongoId), ...filteredRest } as Projected<
      T,
      P
    > as any;
  }

  // helper to map entity to Mongo doc, omitting all undefined properties and system fields (system fields auto-managed)
  function toMongoDoc(entity: CreateInput, op: 'create'): any {
    const { [idKey]: _ignoredId, ...entityData } = entity as any;
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

    const docId = generateDocId();
    return {
      ...filtered,
      ...scope,
      _id: docId,
      ...(mirrorId ? { [idKey]: fromMongoId(docId) } : {}),
    };
  }

  // helper to build MongoDB update operation from set/unset
  function buildUpdateOperation(
    update: UpdateOperation<UpdateInput>,
    mergeTrace?: any
  ): any {
    const { set } = update;
    const unset = update.unset ? [update.unset].flat() : undefined;
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
      mongoUpdate.$unset = unset.reduce((acc, keyOrPath) => {
        acc[String(keyOrPath)] = '';
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
    ): Promise<Projected<T, P> | undefined> => {
      const mongoProjection = projection
        ? Object.fromEntries(
            Object.keys(projection)
              .filter((k) => k !== idKey)
              .map((k) => [k, 1])
          )
        : undefined;
      const doc = await collection.findOne(
        applyConstraints(idFilter(id)),
        withSessionOptions(
          mongoProjection ? { projection: mongoProjection } : undefined
        )
      );
      return doc ? fromMongoDoc(doc, projection) : undefined;
    },

    getByIds: async <P extends Projection<T>>(
      ids: string[],
      projection?: P
    ): Promise<[Projected<T, P>[], string[]]> => {
      const mongoProjection = projection
        ? Object.fromEntries(
            Object.keys(projection)
              .filter((k) => k !== idKey)
              .map((k) => [k, 1])
          )
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
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      await repo.updateMany([id], update as any, options);
    },

    updateMany: async (
      ids: string[],
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
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
          applyConstraints(idsFilter(idChunk)),
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

    find: <P extends Projection<T> | undefined>(
      filter: Partial<T>,
      options?: {
        projection?: P;
        onScopeBreach?: 'empty' | 'error';
        orderBy?: OrderBy<T>;
      }
    ): QueryStream<Projected<T, P>> => {
      if (config.scopeBreach(filter)) {
        const mode = options?.onScopeBreach ?? 'empty';
        if (mode === 'error') {
          throw new Error('Scope breach detected in find filter');
        }
        return QueryStream.empty();
      }

      const mongoFilter = convertFilter(filter);

      const mongoProjection = options?.projection
        ? Object.fromEntries(
            Object.keys(options.projection)
              .filter((k) => k !== idKey)
              .map((k) => [k, 1])
          )
        : undefined;

      // Build sort option from orderBy
      const sortOption: Record<string, 1 | -1> = {};
      if (options?.orderBy) {
        for (const [field, dir] of Object.entries(options.orderBy)) {
          sortOption[field] = isAscending(dir as SortDirection) ? 1 : -1;
        }
      } else {
        // Default sort by _id for deterministic ordering
        sortOption._id = 1;
      }

      const cursor = collection
        .find(
          applyConstraints(mongoFilter),
          withSessionOptions(
            mongoProjection ? { projection: mongoProjection } : undefined
          )
        )
        .sort(sortOption);

      const generator = async function* () {
        try {
          while (await cursor.hasNext()) {
            const doc = await cursor.next();
            yield fromMongoDoc<P>(doc, options?.projection as P) as Projected<
              T,
              P
            >;
          }
        } finally {
          await cursor.close();
        }
      };

      return new QueryStream(generator());
    },

    findBySpec: <P extends Projection<T>>(
      spec: Specification<T>,
      options?: {
        projection?: P;
        onScopeBreach?: 'empty' | 'error';
        orderBy?: OrderBy<T>;
      }
    ): QueryStream<Projected<T, P>> => {
      return repo.find<P>(spec.toFilter(), options as any);
    },

    findPage: async <P extends Projection<T> | undefined>(
      filter: Partial<T>,
      options: {
        startAfter?: string;
        limit: number;
        orderBy?: OrderBy<T>;
        onScopeBreach?: 'empty' | 'error';
        projection?: P;
      }
    ): Promise<{
      items: Projected<T, P>[];
      nextStartAfter: string | undefined;
    }> => {
      if (config.scopeBreach(filter)) {
        const mode = options.onScopeBreach ?? 'empty';
        if (mode === 'error') {
          throw new Error('Scope breach detected in findPage filter');
        }
        return { items: [], nextStartAfter: undefined };
      }

      let mongoFilter = convertFilter(filter);

      const mongoProjection = options.projection
        ? Object.fromEntries(
            Object.keys(options.projection)
              .filter((k) => k !== idKey)
              .map((k) => [k, 1])
          )
        : undefined;

      // Build sort option from orderBy
      const sortOption: Record<string, 1 | -1> = {};
      if (options.orderBy) {
        for (const [field, dir] of Object.entries(options.orderBy)) {
          const mongoField = field === idKey ? '_id' : field;
          const direction = isAscending(dir as SortDirection) ? 1 : -1;
          sortOption[mongoField] = direction;
          if (mongoField === '_id') {
            // ignoring everything after _id because it's irrelevant
            break;
          }
        }
      }

      // Always ensure _id is in the sort (as tiebreaker) for deterministic ordering
      if (!sortOption._id) {
        sortOption._id = 1;
      }

      // Apply startAfter cursor if provided
      if (options.startAfter) {
        let cursorId;
        try {
          cursorId = toMongoId(options.startAfter);
        } catch (error) {
          throw new Error(
            `Invalid startAfter cursor: ${
              error instanceof Error ? error.message : options.startAfter
            }`
          );
        }

        const startAfterDoc = await collection.findOne(
          { _id: cursorId } as any,
          withSessionOptions()
        );
        if (!startAfterDoc) {
          throw new Error(`Invalid startAfter cursor: document not found`);
        }

        mongoFilter = {
          $and: [
            mongoFilter,
            getMinFilter({
              sortOption,
              startAfterDoc,
            }),
          ],
        };
      }

      let cursor = collection
        .find(
          applyConstraints(mongoFilter),
          withSessionOptions(
            mongoProjection ? { projection: mongoProjection } : undefined
          )
        )
        .sort(sortOption);

      // Fetch limit + 1 to determine if there are more results
      cursor = cursor.limit(options.limit + 1);

      const docs = await cursor.toArray();
      const hasMore = docs.length > options.limit;

      // Take only the requested limit
      const items = docs
        .slice(0, options.limit)
        .map((doc) => fromMongoDoc<P>(doc, options.projection as P));

      // Get the cursor for the next page (last document's _id)
      const nextStartAfter =
        hasMore && items.length > 0
          ? fromMongoId(docs[options.limit - 1]._id)
          : undefined;

      return {
        items: items as Projected<T, P>[],
        nextStartAfter,
      };
    },

    findPageBySpec: async <P extends Projection<T>>(
      spec: Specification<T>,
      options: {
        startAfter?: string;
        limit: number;
        orderBy?: OrderBy<T>;
        onScopeBreach?: 'empty' | 'error';
        projection?: P;
      }
    ): Promise<{
      items: Projected<T, P>[];
      nextStartAfter: string | undefined;
    }> => {
      return repo.findPage<P>(spec.toFilter(), options as any);
    },

    count: async (
      filter: Partial<T>,
      options?: { onScopeBreach?: 'zero' | 'error' }
    ): Promise<number> => {
      if (config.scopeBreach(filter)) {
        const mode = options?.onScopeBreach ?? 'zero';
        if (mode === 'error') {
          throw new Error('Scope breach detected in count filter');
        }
        return 0;
      }

      const mongoFilter = convertFilter(filter);
      return await collection.countDocuments(
        applyConstraints(mongoFilter),
        withSessionOptions()
      );
    },

    countBySpec: async (
      spec: Specification<T>,
      options?: { onScopeBreach?: 'zero' | 'error' }
    ): Promise<number> => {
      return repo.count(spec.toFilter(), options);
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

/**
 * Builds a filter that guarantees cursor-based pagination works correctly
 * with custom orderBy clauses. This creates a lexicographic comparison filter
 * that skips all documents up to and including the startAfter document.
 *
 * The sortOption should contain the effective sort fields (with _id last).
 *
 * Example 1:
 * - sortOption: { name: 1, age: 1, _id: 1 }
 * - startAfter doc: { _id: 'X', name: 'Bob', age: 25 }
 * - resulting filter:
 *    (name > 'Bob')
 *    OR (name = 'Bob' AND age > 25)
 *    OR (name = 'Bob' AND age = 25 AND _id > 'X')
 *
 * Example 2:
 * - sortOption: { name: -1, age: 1, _id: 1 }
 * - startAfter doc: { _id: 'X', name: 'Bob', age: 25 }
 * - resulting filter:
 *    (name < 'Bob' OR NULLISH(name))
 *    OR (name = 'Bob' AND age > 25)
 *    OR (name = 'Bob' AND age = 25 AND _id > 'X')
 *
 * Example 3 (only _id):
 * - sortOption: { _id: 1 }
 * - startAfter doc: { _id: 'X' }
 * - resulting filter: (_id > 'X')
 *
 * @see https://www.mongodb.com/docs/manual/reference/bson-type-comparison-order/
 */
function getMinFilter({
  sortOption,
  startAfterDoc,
}: {
  sortOption: Record<string, 1 | -1>;
  startAfterDoc: any;
}): any {
  // MongoDB BSON type ordering helpers
  const greaterThanNullAndUndefined = {
    $nin: [[], null, MinKey],
    $exists: true,
  };
  const lowerThanNullAndUndefined = { $in: [[], MinKey] };
  const nullish = (field: string) => [
    { [field]: { $exists: false } },
    { [field]: null },
  ];

  const filters: any[] = [];
  const equalityPredicates: any[] = [];

  for (const [field, direction] of Object.entries(sortOption)) {
    const startAfterValue = startAfterDoc[field];
    const filter: any[] = [...equalityPredicates];

    if (startAfterValue == null) {
      filter.push({
        [field]:
          direction === 1
            ? greaterThanNullAndUndefined
            : lowerThanNullAndUndefined,
      });
      equalityPredicates.push({ $or: nullish(field) });
    } else {
      if (direction === 1) {
        filter.push({ [field]: { $gt: startAfterValue } });
      } else {
        filter.push({
          $or: [{ [field]: { $lt: startAfterValue } }, ...nullish(field)],
        });
      }
      equalityPredicates.push({ [field]: startAfterValue });
    }

    filters.push({ $and: filter });
  }

  return { $or: filters };
}
