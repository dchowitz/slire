import {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  FieldValue,
  Firestore,
  Query,
  QueryDocumentSnapshot,
  Timestamp,
  Transaction,
} from '@google-cloud/firestore';
import { chunk } from 'lodash-es';
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

// Firestore-specific repository config that excludes 'bounded' strategy
export type FirestoreRepositoryConfig<T> = Omit<
  RepositoryConfig<T>,
  'traceStrategy'
> & {
  traceStrategy?: 'latest' | 'unbounded';
};

// Firestore-specific constants
const FIRESTORE_MAX_WRITES_PER_BATCH = 300; // conservative (max is 500)
const FIRESTORE_IN_LIMIT = 10; // conservative 'in' operator limit across SDKs

// Firestore repository type with additional Firestore-specific helpers and transaction methods
// Prettified to show expanded type in IDE tooltips instead of complex intersection
export type FirestoreRepo<
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
    collection: CollectionReference<T>;
    applyConstraints: (query: Query) => Query;
    buildUpdateOperation: (
      update: UpdateOperation<UpdateInput>,
      mergeTrace?: any
    ) => Record<string, any>;
    withTransaction(
      transaction: Transaction
    ): FirestoreRepo<T, Scope, Config, Managed, UpdateInput, CreateInput>;
    runTransaction<R>(
      operation: (
        txRepo: SmartRepo<T, Scope, Config, Managed, UpdateInput, CreateInput>
      ) => Promise<R>
    ): Promise<R>;
  }
>;

/**
 * Creates a Firestore repository with type-safe CRUD operations.
 *
 * @template T The entity type (must have id: string)
 * @template Config Repository configuration options (inferred from options parameter)
 *
 * Advanced generics (Managed, UpdateInput, CreateInput) are computed automatically - you typically don't need to specify them.
 *
 * @example
 * ```typescript
 * type User = { id: string; name: string; email: string };
 * const repo = createSmartFirestoreRepo<User>({ collection, firestore });
 * // Config, Managed, and InputEntity are inferred automatically
 *
 * // With configuration:
 * const repoWithConfig = createSmartFirestoreRepo<User>({
 *   collection,
 *   firestore,
 *   options: { softDelete: true, traceTimestamps: true }
 * });
 * // InputEntity becomes: { name: string; email: string; id?: string }
 * ```
 *
 */
export function createSmartFirestoreRepo<
  T extends { id: string },
  Scope extends Partial<T> = {},
  Config extends FirestoreRepositoryConfig<T> = {},
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
  firestore,
  scope = {} as Scope,
  traceContext,
  options,
  transaction,
}: {
  collection: CollectionReference<T>;
  firestore: Firestore;
  scope?: Scope;
  traceContext?: any;
  options?: Config;
  transaction?: Transaction;
}): FirestoreRepo<T, Scope, Config, Managed, UpdateInput, CreateInput> {
  const config = repoConfig(options ?? ({} as Config), traceContext, scope);

  // Firestore-specific validation: reject 'bounded' strategy
  if (config.getTraceStrategy() === 'bounded') {
    throw new Error(
      'Firestore does not support "bounded" trace strategy due to lack of server-side array slicing. ' +
        'Use "latest" for single trace or "unbounded" for unlimited trace history.'
    );
  }

  const idKey = config.idKey;
  const mirrorId = config.mirrorId;
  const generateIdFn: () => string =
    config.idStrategy === 'server'
      ? () => collection.doc().id
      : (config.idStrategy as () => string);

  const getDocRef = (id: string): DocumentReference<T> => collection.doc(id);

  const SOFT_DELETE_KEY = config.getSoftDeleteKey();
  const SOFT_DELETE_MARK = { [SOFT_DELETE_KEY]: true };

  // Get timestamp keys from config
  const timestampKeys = config.getTimestampKeys();
  const CREATED_KEY = timestampKeys.createdAt;
  const UPDATED_KEY = timestampKeys.updatedAt;
  const DELETED_KEY = timestampKeys.deletedAt;

  // Firestore-specific timestamp handling using shared config
  function applyTimestamps(
    op: WriteOp,
    firestoreUpdate: Record<string, any>
  ): Record<string, any> {
    if (!config.timestampsEnabled) {
      return firestoreUpdate;
    }

    const useServerTimestamps = config.shouldUseServerTimestamp();
    const now = config.getTimestamp();

    if (!useServerTimestamps && !now) {
      return firestoreUpdate;
    }

    const timestampValue = useServerTimestamps
      ? FieldValue.serverTimestamp()
      : now;

    switch (op) {
      case 'create':
        return {
          ...firestoreUpdate,
          [CREATED_KEY]: timestampValue,
          [UPDATED_KEY]: timestampValue,
        };
      case 'update':
        return {
          ...firestoreUpdate,
          [UPDATED_KEY]: timestampValue,
        };
      case 'delete':
        return {
          ...firestoreUpdate,
          [UPDATED_KEY]: timestampValue,
          [DELETED_KEY]: timestampValue,
        };
      default:
        const ex: never = op;
        throw new Error(`Unexpected op: ${ex}`);
    }
  }

  // Firestore-specific version handling using shared config
  function applyVersion(
    op: WriteOp,
    firestoreUpdate: Record<string, any>
  ): Record<string, any> {
    if (!config.shouldIncrementVersion()) {
      return firestoreUpdate;
    }

    const versionKey = config.getVersionKey();

    switch (op) {
      case 'create':
        return {
          ...firestoreUpdate,
          [versionKey]: 1,
        };
      case 'update':
      case 'delete':
        return {
          ...firestoreUpdate,
          [versionKey]: FieldValue.increment(1),
        };
      default:
        const ex: never = op;
        throw new Error(`Unexpected op: ${ex}`);
    }
  }

  // Firestore-specific trace handling using shared config
  function applyTrace(
    op: WriteOp,
    firestoreUpdate: Record<string, any>,
    contextOverride?: any
  ): Record<string, any> {
    const traceValue = config.buildTraceContext(
      op,
      contextOverride,
      FieldValue.serverTimestamp()
    );
    if (!traceValue) {
      return firestoreUpdate;
    }

    const traceStrategy = config.getTraceStrategy();
    const traceKey = config.getTraceKey();

    if (traceStrategy === 'latest') {
      return {
        ...firestoreUpdate,
        [traceKey]: traceValue,
      };
    } else if (traceStrategy === 'unbounded') {
      return {
        ...firestoreUpdate,
        [traceKey]: FieldValue.arrayUnion(traceValue),
      };
    }

    return firestoreUpdate;
  }

  function applyConstraints(query: Query): Query {
    let constrainedQuery = query;

    if (config.softDeleteEnabled) {
      constrainedQuery = constrainedQuery.where(SOFT_DELETE_KEY, '==', false);
    }

    // Path-scoped mode: do not add scope filters to queries. Scope is validated on writes only.
    return constrainedQuery;
  }

  // helper to map Firestore doc to entity
  function fromFirestoreDoc<P extends Projection<T>>(
    doc: QueryDocumentSnapshot | DocumentSnapshot,
    projection?: P
  ): Projected<T, P> | null {
    if (!doc.exists) {
      return null;
    }

    const rawDocData = doc.data()!;
    const docData = convertFirestoreTimestamps(rawDocData);
    const docId = doc.id;

    // if the projection is specified, only include id if it's in the projection
    if (projection) {
      const projectedFields = Object.keys(projection);
      const result: any = {};

      // include idKey if requested (computed from docId)
      if (projectedFields.includes(idKey)) {
        result[idKey] = docId;
      }

      // include other projected fields from stored data
      for (const field of projectedFields) {
        if (field !== idKey && field in docData) {
          result[field] = (docData as any)[field];
        }
      }

      return result as Projected<T, P>;
    }

    // no projection, return all fields except hidden meta-keys
    const filteredData = Object.fromEntries(
      Object.entries(docData).filter(([k]) => !config.isHiddenField(k))
    );

    return { [idKey]: docId, ...filteredData } as Projected<T, P> as any;
  }

  // helper to map entity to Firestore doc data, omitting all undefined properties and system fields
  function toFirestoreDoc(
    entity: CreateInput,
    op: 'create'
  ): { docId: string; docData: any } {
    const { [idKey]: _ignoredId, ...entityData } = entity as any;
    config.validateScopeProperties(entityData, op);

    // Strip all system-managed fields to prevent external manipulation
    const strippedEntityData = Object.fromEntries(
      Object.entries(entityData).filter(([key]) => !config.isReadOnlyField(key))
    );

    const filtered = deepFilterUndefined(strippedEntityData);

    // identity handling
    const docId = generateIdFn();
    return {
      docId,
      docData: {
        ...filtered,
        ...scope,
        ...(mirrorId ? { [idKey]: docId } : {}),
        ...(config.softDeleteEnabled ? { [SOFT_DELETE_KEY]: false } : {}),
      },
    };
  }

  // helper to build Firestore update operation from set/unset
  function buildUpdateOperation(
    update: UpdateOperation<UpdateInput>,
    mergeTrace?: any
  ): Record<string, any> {
    const { set } = update;
    const unset = update.unset ? [update.unset].flat() : undefined;
    const firestoreUpdate: Record<string, any> = {};

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
      Object.assign(firestoreUpdate, deepFilterUndefined(set));
    }

    if (unset) {
      config.validateNoReadonly(unset.map(String), 'unset');
      for (const keyOrPath of unset) {
        firestoreUpdate[String(keyOrPath)] = FieldValue.delete();
      }
    }

    return applyTrace(
      'update',
      applyVersion('update', applyTimestamps('update', firestoreUpdate)),
      mergeTrace
    );
  }

  const repo: FirestoreRepo<
    T,
    Scope,
    Config,
    Managed,
    UpdateInput,
    CreateInput
  > = {
    getById: async <P extends Projection<T>>(
      id: string,
      projection?: P
    ): Promise<Projected<T, P> | undefined> => {
      const [found] = await repo.getByIds<P>([id], projection as P);
      return found[0] ?? undefined;
    },

    getByIds: async <P extends Projection<T>>(
      ids: string[],
      projection?: P
    ): Promise<[Projected<T, P>[], string[]]> => {
      if (ids.length === 0) {
        return [[], []];
      }

      const foundDocs: Projected<T, P>[] = [];
      const foundIds = new Set<string>();

      const docRefs = ids.map((id) => getDocRef(id));
      const docs = transaction
        ? await Promise.all(docRefs.map((ref) => transaction.get(ref)))
        : await firestore.getAll(...docRefs);

      for (const [index, doc] of docs.entries()) {
        if (!doc.exists) {
          continue;
        }
        const docData = doc.data()!;
        // Path-scoped reads: only exclude soft-deleted documents; scope is enforced by collection path
        if (config.softDeleted(docData)) {
          continue;
        }
        const result = fromFirestoreDoc(doc, projection);
        if (result) {
          foundDocs.push(result);
          foundIds.add(ids[index]);
        }
      }

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
      const preparedDocs = entities.map((e) => toFirestoreDoc(e, 'create'));
      const preparedPublicIds = preparedDocs.map((doc) => doc.docId);

      const insertedSoFar: string[] = [];

      // process in batches to respect Firestore limitations
      for (
        let offset = 0;
        offset < preparedDocs.length;
        offset += FIRESTORE_MAX_WRITES_PER_BATCH
      ) {
        const batch = preparedDocs.slice(
          offset,
          offset + FIRESTORE_MAX_WRITES_PER_BATCH
        );

        const writeBatch = transaction ? null : firestore.batch();

        // Single loop to handle both batch and transaction cases
        for (const { docId, docData } of batch) {
          const docRef = collection.doc(docId);
          const finalData = applyTrace(
            'create',
            applyVersion('create', applyTimestamps('create', docData)),
            options?.mergeTrace
          );

          if (transaction) {
            transaction.create(docRef, finalData);
          } else {
            writeBatch!.create(docRef, finalData);
          }
        }

        try {
          if (!transaction) {
            await writeBatch!.commit();
          }

          // record successful inserts for this batch
          insertedSoFar.push(
            ...preparedPublicIds.slice(offset, offset + batch.length)
          );
        } catch {
          // Firestore batch failed - entire batch fails atomically
          // All remaining operations (this batch + subsequent batches) are considered failed
          const failedIds = preparedPublicIds.slice(offset);
          throw new CreateManyPartialFailure({
            insertedIds: insertedSoFar,
            failedIds: failedIds,
          });
        }
      }

      // success: return ids in input order
      return preparedPublicIds;
    },

    update: async (
      id: string,
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      const updateOperation = buildUpdateOperation(update, options?.mergeTrace);
      const query = applyConstraints(
        collection.where(FieldPath.documentId(), '==', id).select()
      );

      if (transaction) {
        const snapshot = await transaction.get(query);
        if (!snapshot.empty) {
          transaction.update(snapshot.docs[0].ref, updateOperation);
        }
        return;
      }

      const snapshot = await query.get();
      if (!snapshot.empty) {
        await snapshot.docs[0].ref.update(updateOperation);
      }
    },

    updateMany: async (
      ids: string[],
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      if (ids.length < 1) {
        return;
      }

      for (const idChunk of chunk(ids, FIRESTORE_MAX_WRITES_PER_BATCH)) {
        const updateOperation = buildUpdateOperation(
          update,
          options?.mergeTrace
        );

        for (const inChunk of chunk(idChunk, FIRESTORE_IN_LIMIT)) {
          const query = applyConstraints(
            collection.where(FieldPath.documentId(), 'in', inChunk).select()
          );

          if (transaction) {
            const snap = await transaction.get(query);
            for (const doc of snap.docs) {
              transaction.update(doc.ref, updateOperation);
            }
          } else {
            const batch = firestore.batch();
            const snap = await query.get();
            for (const doc of snap.docs) {
              batch.update(doc.ref, updateOperation);
            }
            await batch.commit();
          }
        }
      }
    },

    delete: async (
      id: string,
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      if (config.softDeleteEnabled) {
        const updateOperation = applyTrace(
          'delete',
          applyVersion('delete', applyTimestamps('delete', SOFT_DELETE_MARK)),
          options?.mergeTrace
        );

        const query = applyConstraints(
          collection.where(FieldPath.documentId(), '==', id).select()
        );

        if (transaction) {
          const snap = await transaction.get(query);
          if (!snap.empty) {
            transaction.update(snap.docs[0].ref, updateOperation);
          }
        } else {
          const snap = await query.get();
          if (!snap.empty) {
            await snap.docs[0].ref.update(updateOperation);
          }
        }
      } else {
        const docRef = getDocRef(id);
        if (transaction) {
          transaction.delete(docRef);
        } else {
          await docRef.delete();
        }
      }
    },

    deleteMany: async (
      ids: string[],
      options?: { mergeTrace?: any }
    ): Promise<void> => {
      if (ids.length < 1) {
        return;
      }

      const softDelete = config.softDeleteEnabled
        ? applyTrace(
            'delete',
            applyVersion('delete', applyTimestamps('delete', SOFT_DELETE_MARK)),
            options?.mergeTrace
          )
        : undefined;

      for (const idChunk of chunk(ids, FIRESTORE_MAX_WRITES_PER_BATCH)) {
        // make sure we only try to delete docs that exist (to prevent errors)
        // and are not soft-deleted (idempotency, otherwise we'd have multiple delete trace entries)
        const snaps = await Promise.all(
          chunk(idChunk, FIRESTORE_IN_LIMIT).map((inChunk) => {
            const query = applyConstraints(
              collection.where(FieldPath.documentId(), 'in', inChunk).select()
            );
            return transaction ? transaction.get(query) : query.get();
          })
        );

        const batch = transaction ? undefined : firestore.batch();

        const doUpdate: any = transaction
          ? transaction.update.bind(transaction)
          : batch!.update.bind(batch!);

        const doDelete: any = transaction
          ? transaction.delete.bind(transaction)
          : batch!.delete.bind(batch!);

        for (const doc of snaps.map((s) => s.docs).flat()) {
          if (softDelete) {
            doUpdate(doc.ref, softDelete);
          } else {
            doDelete(doc.ref);
          }
        }

        if (batch) {
          await batch.commit();
        }
      }
    },

    find: <P extends Projection<T>>(
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

      let query: Query = collection;

      // Apply filter constraints (map idKey to documentId)
      for (const [key, value] of Object.entries(filter)) {
        if (value === undefined) continue;
        if (key === idKey) {
          query = query.where(FieldPath.documentId(), '==', value as any);
        } else {
          query = query.where(key, '==', value as any);
        }
      }

      query = applyConstraints(query);

      // Apply ordering
      if (options?.orderBy) {
        for (const [field, dir] of Object.entries(options.orderBy)) {
          query = query.orderBy(
            field,
            isAscending(dir as SortDirection) ? 'asc' : 'desc'
          );
        }
      } else {
        // Default sort by document ID for deterministic ordering
        query = query.orderBy('__name__', 'asc');
      }

      // Apply server-side projection (idKey is computed from doc.id)
      if (options?.projection) {
        const projectionFields = Object.keys(options?.projection);
        const firestoreProjectionFields: string[] = [];

        for (const field of projectionFields) {
          if (field !== idKey) {
            firestoreProjectionFields.push(field);
          }
        }

        if (firestoreProjectionFields.length > 0) {
          query = query.select(...firestoreProjectionFields);
        }
      }

      const generator = async function* () {
        const snapshot = await query.get();

        for (const doc of snapshot.docs) {
          if (!doc.exists) {
            continue;
          }
          const result = fromFirestoreDoc(doc, options?.projection);
          if (result) {
            yield result;
          }
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

      let query: any = collection;

      // Apply filter constraints
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined) {
          query = query.where(key, '==', value);
        }
      }

      // Apply repository constraints (soft delete, etc.)
      query = applyConstraints(query);

      // Apply ordering
      if (options.orderBy) {
        for (const [field, dir] of Object.entries(options.orderBy)) {
          query = query.orderBy(
            field,
            isAscending(dir as SortDirection) ? 'asc' : 'desc'
          );
        }
      } else {
        // Default sort by __name__ for deterministic ordering
        query = query.orderBy('__name__', 'asc');
      }

      // Apply startAfter cursor if provided
      if (options.startAfter) {
        const docRef = collection.doc(options.startAfter);
        const docSnapshot = await (transaction
          ? transaction.get(docRef)
          : docRef.get());
        if (docSnapshot.exists) {
          query = query.startAfter(docSnapshot);
        } else {
          throw new Error(`Invalid startAfter cursor: ${options.startAfter}`);
        }
      }

      // Fetch limit + 1 to determine if there are more results
      query = query.limit(options.limit + 1);

      // Apply server-side projection (idKey is computed from doc.id)
      if (options.projection) {
        const projectionFields = Object.keys(options.projection);
        const nonIdFields = projectionFields.filter((k) => k !== idKey);
        if (nonIdFields.length > 0) {
          query = query.select(...nonIdFields);
        }
      }

      const snapshot = transaction
        ? await transaction.get(query)
        : await query.get();

      const docs = snapshot.docs;
      const hasMore = docs.length > options.limit;

      // Take only the requested limit
      const items = docs
        .slice(0, options.limit)
        .map((doc: any) => fromFirestoreDoc(doc, options.projection));

      // Get the cursor for the next page (last document's id)
      const nextStartAfter =
        hasMore && items.length > 0 ? docs[options.limit - 1].id : undefined;

      return {
        items: items as Projected<T, P>[],
        nextStartAfter,
      };
    },

    count: async (
      filter: Partial<T>,
      options?: { onScopeBreach?: 'zero' | 'error' }
    ): Promise<number> => {
      let query: Query = collection;

      if (config.scopeBreach(filter)) {
        const mode = options?.onScopeBreach ?? 'zero';
        if (mode === 'error') {
          throw new Error('Scope breach detected in count filter');
        }
        return 0;
      }

      // Apply filter constraints (map idKey to documentId)
      for (const [key, value] of Object.entries(filter)) {
        if (value === undefined) continue;
        if (key === idKey) {
          query = query.where(FieldPath.documentId(), '==', value as any);
        } else {
          query = query.where(key, '==', value as any);
        }
      }

      query = applyConstraints(query.select());

      const agg = await query.count().get();
      return agg.data().count;
    },

    countBySpec: async (
      spec: Specification<T>,
      options?: { onScopeBreach?: 'zero' | 'error' }
    ): Promise<number> => {
      return repo.count(spec.toFilter(), options);
    },

    // Firestore-specific helpers

    // Repo collection reference
    collection: collection,

    // Adds scope filter and soft-delete filter (if configured), with option to include soft-deleted
    applyConstraints: applyConstraints,

    // Applies enrichments (such as timestamps) and enforces constraints (writing readonly props not allowed)
    buildUpdateOperation: buildUpdateOperation,

    // Factory method for transaction-aware repository
    withTransaction: (tx: Transaction) => {
      return createSmartFirestoreRepo({
        collection,
        firestore,
        scope,
        traceContext,
        options: { ...options },
        transaction: tx,
      });
    },

    // Convenience method for running multiple repo functions in a transaction
    runTransaction: async <R>(
      operation: (
        txRepo: SmartRepo<T, Scope, Config, Managed, UpdateInput, CreateInput>
      ) => Promise<R>
    ): Promise<R> => {
      return firestore.runTransaction(async (tx) => {
        const txRepo = repo.withTransaction(tx);
        return operation(
          txRepo as SmartRepo<
            T,
            Scope,
            Config,
            Managed,
            UpdateInput,
            CreateInput
          >
        );
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

  // Handle arrays - preserve undefined elements but filter them out for Firestore
  if (Array.isArray(obj)) {
    return obj.map(deepFilterUndefined).filter((item) => item !== undefined);
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
 * Recursively converts Firestore Timestamp objects to JavaScript Date objects.
 * This maintains API consistency - users expect Date objects regardless of database.
 */
export function convertFirestoreTimestamps(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Convert Firestore Timestamp to Date
  // Try both instanceof check and duck typing for compatibility
  if (obj instanceof Timestamp) {
    return obj.toDate();
  }
  if (obj.toDate && typeof obj.toDate === 'function') {
    return obj.toDate();
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(convertFirestoreTimestamps);
  }

  // Handle objects
  if (typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertFirestoreTimestamps(value);
    }
    return result;
  }

  // Primitives
  return obj;
}
