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

// Firestore-specific repository config that excludes 'bounded' strategy
export type FirestoreRepositoryConfig<T> = Omit<
  RepositoryConfig<T>,
  'traceStrategy'
> & {
  traceStrategy?: 'latest' | 'unbounded';
};

// Firestore-specific constants
const FIRESTORE_MAX_WRITES_PER_BATCH = 500;

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
  if (config.traceEnabled && config.getTraceStrategy() === 'bounded') {
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
    if (!config.traceEnabled) {
      return firestoreUpdate;
    }

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

    // Apply scope constraints
    for (const [key, value] of Object.entries(scope)) {
      constrainedQuery = constrainedQuery.where(key, '==', value);
    }

    // Note: Firestore has no "field-does-not-exist" operator like MongoDB's $exists: false
    // So we can't filter soft-deleted documents server-side and must rely on client-side filtering
    // The includeSoftDeleted option is passed through for client-side filtering

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

    if (config.scopeBreach(rawDocData) || config.softDeleted(rawDocData)) {
      return null;
    }

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
      },
    };
  }

  // helper to build Firestore update operation from set/unset
  function buildUpdateOperation(
    update: UpdateOperation<UpdateInput>,
    mergeTrace?: any
  ): Record<string, any> {
    const { set, unset } = update;
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
      for (const key of unset) {
        firestoreUpdate[String(key)] = FieldValue.delete();
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
    ): Promise<Projected<T, P> | null> => {
      const [found] = await repo.getByIds<P>([id], projection as any);
      return found[0] ?? null;
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

      // use chunking for large batches to avoid Firestore limitations
      const chunks = chunk(ids, FIRESTORE_MAX_WRITES_PER_BATCH);

      for (const idChunk of chunks) {
        const updateOperation = buildUpdateOperation(
          update,
          options?.mergeTrace
        );

        if (transaction) {
          // Handle transaction updates
          for (const id of idChunk) {
            const docRef = getDocRef(id);
            const doc = await transaction.get(docRef);

            if (doc.exists) {
              const docData = doc.data()! as any;
              // Skip soft-deleted documents
              if (config.softDeleteEnabled && docData[SOFT_DELETE_KEY]) {
                continue;
              }
              transaction.update(docRef, updateOperation);
            }
          }
        } else {
          // Handle batch updates
          const batch = firestore.batch();

          // We need to check each document first due to soft delete constraints
          const docRefs = idChunk.map((id) => getDocRef(id));
          const docs = await firestore.getAll(...docRefs);

          for (const doc of docs) {
            if (doc.exists) {
              const docData = doc.data()! as any;
              // Skip soft-deleted documents
              if (config.softDeleteEnabled && docData[SOFT_DELETE_KEY]) {
                continue;
              }
              batch.update(doc.ref, updateOperation);
            }
          }

          await batch.commit();
        }
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
      // use chunking for large batches to avoid Firestore limitations
      const chunks = chunk(ids, FIRESTORE_MAX_WRITES_PER_BATCH);

      for (const idChunk of chunks) {
        if (config.softDeleteEnabled) {
          const updateOperation = applyTrace(
            'delete',
            applyVersion('delete', applyTimestamps('delete', SOFT_DELETE_MARK)),
            options?.mergeTrace
          );

          if (transaction) {
            for (const id of idChunk) {
              const docRef = getDocRef(id);
              transaction.update(docRef, updateOperation);
            }
          } else {
            const batch = firestore.batch();
            for (const id of idChunk) {
              const docRef = getDocRef(id);
              batch.update(docRef, updateOperation);
            }
            await batch.commit();
          }
        } else {
          // Hard delete
          if (transaction) {
            for (const id of idChunk) {
              const docRef = getDocRef(id);
              transaction.delete(docRef);
            }
          } else {
            const batch = firestore.batch();
            for (const id of idChunk) {
              const docRef = getDocRef(id);
              batch.delete(docRef);
            }
            await batch.commit();
          }
        }
      }
    },

    find: async <P extends Projection<T>>(
      filter: Partial<T>,
      projection?: P
    ): Promise<Projected<T, P>[]> => {
      if (config.scopeBreach(filter)) {
        return [];
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

      // Apply scope constraints
      query = applyConstraints(query);

      // Apply server-side projection
      if (projection) {
        const projectionFields = Object.keys(projection);
        const firestoreProjectionFields: string[] = [];

        for (const field of projectionFields) {
          if (field !== idKey) {
            firestoreProjectionFields.push(field);
          }
        }

        if (
          config.softDeleteEnabled &&
          !firestoreProjectionFields.includes(SOFT_DELETE_KEY)
        ) {
          firestoreProjectionFields.push(SOFT_DELETE_KEY);
        }

        if (firestoreProjectionFields.length > 0) {
          query = query.select(...firestoreProjectionFields);
        }
      }

      const snapshot = await query.get();
      const results: Projected<T, P>[] = [];

      for (const doc of snapshot.docs) {
        const result = fromFirestoreDoc(doc, projection);
        if (result) {
          // Client-side soft delete filtering (since Firestore can't do server-side filtering)
          if (config.softDeleteEnabled) {
            const docData = doc.data();
            if (
              SOFT_DELETE_KEY in docData &&
              (docData as any)[SOFT_DELETE_KEY]
            ) {
              continue; // Skip soft deleted document
            }
          }
          results.push(result);
        }
      }

      return results;
    },

    findBySpec: async <P extends Projection<T>>(
      spec: Specification<T>,
      projection?: P
    ): Promise<Projected<T, P>[]> => {
      return repo.find(spec.toFilter(), projection as P);
    },

    count: async (filter: Partial<T>): Promise<number> => {
      if (config.scopeBreach(filter)) {
        return 0;
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

      // Apply scope constraints
      query = applyConstraints(query);

      // Apply server-side projection for efficiency
      if (config.softDeleteEnabled) {
        // Only fetch soft-delete key for client-side filtering
        query = query.select(SOFT_DELETE_KEY);
      } else {
        // No fields needed for count when soft delete is disabled - empty projection
        query = query.select();
      }

      const snapshot = await query.get();

      // Client-side soft delete filtering (since Firestore can't do server-side filtering)
      if (!config.softDeleteEnabled) {
        return snapshot.size;
      }

      let count = 0;
      for (const doc of snapshot.docs) {
        const docData = doc.data();
        // Only count documents that are not soft deleted
        if (
          !(SOFT_DELETE_KEY in docData && (docData as any)[SOFT_DELETE_KEY])
        ) {
          count++;
        }
      }

      return count;
    },

    countBySpec: async (spec: Specification<T>): Promise<number> => {
      return repo.count(spec.toFilter());
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
