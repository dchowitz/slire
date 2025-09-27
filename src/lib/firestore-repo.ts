import {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Firestore,
  Query,
  QueryDocumentSnapshot,
  Transaction,
} from '@google-cloud/firestore';
import { chunk } from 'lodash-es';
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
    applyConstraints: (
      query: Query<T>,
      options?: { includeSoftDeleted?: boolean }
    ) => Query<T>;
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
  // Create shared configuration helper
  const config = repoConfig(options ?? ({} as Config), traceContext);

  // Repository-specific configuration
  const generateIdFn = options?.generateId ?? uuidv4;
  const identityMode = options?.identity ?? 'synced';
  const isDetachedIdentity = identityMode === 'detached';

  // Validate trace configuration
  if (
    config.traceEnabled &&
    config.getTraceStrategy() === 'bounded' &&
    !config.getTraceLimit()
  ) {
    throw new Error('traceLimit is required when traceStrategy is "bounded"');
  }

  // centralized id handling helpers
  const getDocRef = (id: string): DocumentReference<T> => collection.doc(id);

  // Firestore-specific helpers using shared config
  const SCOPE_KEYS = new Set<string>([...Object.keys(scope)]);
  const SOFT_DELETE_MARK = { [config.getSoftDeleteKey()]: true };

  // Get timestamp keys from config
  const timestampKeys = config.getTimestampKeys();
  const CREATED_KEY = timestampKeys.createdAt;
  const UPDATED_KEY = timestampKeys.updatedAt;
  const DELETED_KEY = timestampKeys.deletedAt;

  // Validate scope doesn't use readonly fields
  const readOnlyFieldsInScope = Object.keys(scope).filter((f) =>
    config.isReadOnlyField(f)
  );
  if (readOnlyFieldsInScope.length > 0) {
    throw new Error(
      `Readonly fields found in scope: ${readOnlyFieldsInScope.join(', ')}`
    );
  }

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

    const traceValue = config.buildTraceContext(op, contextOverride);
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
    } else if (traceStrategy === 'bounded') {
      return {
        ...firestoreUpdate,
        [traceKey]: FieldValue.arrayUnion(traceValue),
        // Note: Firestore doesn't have a built-in array slice operation like MongoDB
        // We'll need to handle bounded array size in a separate operation or via Cloud Functions
      };
    }

    return firestoreUpdate;
  }

  function applyConstraints(
    query: Query<T>,
    options?: { includeSoftDeleted?: boolean }
  ): Query<T> {
    const includeSoftDeleted = options?.includeSoftDeleted ?? false;

    let constrainedQuery = query;

    // Apply scope constraints
    for (const [key, value] of Object.entries(scope)) {
      constrainedQuery = constrainedQuery.where(key, '==', value);
    }

    // Apply soft delete constraint
    if (config.softDeleteEnabled && !includeSoftDeleted) {
      // In Firestore, we check that the soft delete field doesn't exist
      constrainedQuery = constrainedQuery.where(
        config.getSoftDeleteKey(),
        '==',
        null
      );
    }

    return constrainedQuery;
  }

  function validateNoReadonly(
    keys: string[],
    operation: WriteOp | 'unset'
  ): void {
    const readonlyKeys = keys.filter((key) => config.isReadOnlyField(key));

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

  // helper to map Firestore doc to entity
  function fromFirestoreDoc<P extends Projection<T>>(
    doc: QueryDocumentSnapshot<T> | DocumentSnapshot<T>,
    projection?: P
  ): Projected<T, P> | null {
    if (!doc.exists) {
      return null;
    }

    const docData = doc.data()!;
    const docId = doc.id;

    // if the projection is specified, only include id if it's in the projection
    if (projection) {
      const projectedFields = Object.keys(projection);
      const result: any = {};

      // always include id if it's in the projection
      if (projectedFields.includes('id')) {
        result.id = isDetachedIdentity ? docData.id : docId;
      }

      // include other projected fields
      for (const field of projectedFields) {
        if (field !== 'id' && field in docData) {
          result[field] = (docData as any)[field];
        }
      }

      return result as Projected<T, P>;
    }

    // no projection, return all fields except hidden meta-keys
    const filteredData = Object.fromEntries(
      Object.entries(docData).filter(([k]) => !config.isHiddenField(k))
    );

    if (isDetachedIdentity) {
      // in detached mode, the entity already contains its business id field
      return { ...filteredData } as Projected<T, P>;
    }
    return { id: docId, ...filteredData } as Projected<T, P>;
  }

  // helper to map entity to Firestore doc data, omitting all undefined properties and system fields
  function toFirestoreDoc(
    entity: CreateInput,
    op: 'create'
  ): { docId: string; docData: any } {
    const { id, ...entityData } = entity;
    validateScopeProperties(entityData, op);

    // Strip all system-managed fields to prevent external manipulation
    const strippedEntityData = Object.fromEntries(
      Object.entries(entityData).filter(([key]) => !config.isReadOnlyField(key))
    );

    const filtered = deepFilterUndefined(strippedEntityData);

    // identity handling
    if (isDetachedIdentity) {
      // business id and internal id are different
      const businessId = generateIdFn();
      const internalId = generateIdFn();
      return {
        docId: internalId,
        docData: { ...filtered, ...scope, id: businessId },
      };
    } else {
      // synced: use single id for both
      const syncId = generateIdFn();
      return {
        docId: syncId,
        docData: { ...filtered, ...scope },
      };
    }
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
      validateNoReadonly(Object.keys(set), 'update');
      Object.assign(firestoreUpdate, deepFilterUndefined(set));
    }

    if (unset) {
      validateNoReadonly(unset.map(String), 'unset');
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
      const docRef = getDocRef(id);
      const doc = transaction
        ? await transaction.get(docRef)
        : await docRef.get();

      const result = fromFirestoreDoc(doc, projection);

      // Apply soft delete filtering if not included
      if (
        result &&
        config.softDeleteEnabled &&
        !(result as any)[config.getSoftDeleteKey()]
      ) {
        return result;
      } else if (result && config.softDeleteEnabled) {
        return null; // Document is soft deleted
      }

      return result;
    },

    getByIds: async <P extends Projection<T>>(
      ids: string[],
      projection?: P
    ): Promise<[Projected<T, P>[], string[]]> => {
      if (ids.length === 0) {
        return [[], []];
      }

      const docRefs = ids.map((id) => getDocRef(id));
      const docs = transaction
        ? await Promise.all(docRefs.map((ref) => transaction.get(ref)))
        : await firestore.getAll(...docRefs);

      const foundDocs: Projected<T, P>[] = [];
      const notFoundIds: string[] = [];

      for (const [index, doc] of docs.entries()) {
        const result = fromFirestoreDoc(doc as DocumentSnapshot<T>, projection);
        if (
          result &&
          (!config.softDeleteEnabled ||
            !(result as any)[config.getSoftDeleteKey()])
        ) {
          foundDocs.push(result);
        } else {
          notFoundIds.push(ids[index]);
        }
      }

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
      const preparedPublicIds = preparedDocs.map((doc) =>
        isDetachedIdentity ? (doc.docData as any).id : doc.docId
      );

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
          // Handle partial failure - this is simplified for now
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
              // Check soft delete constraint
              if (
                config.softDeleteEnabled &&
                !options?.includeSoftDeleted &&
                docData[config.getSoftDeleteKey()]
              ) {
                continue; // Skip soft deleted documents
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
              // Check soft delete constraint
              if (
                config.softDeleteEnabled &&
                !options?.includeSoftDeleted &&
                docData[config.getSoftDeleteKey()]
              ) {
                continue; // Skip soft deleted documents
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
      // Check for scope breach
      if (
        Object.entries(scope).some(
          ([k, v]) =>
            (filter as any)[k] !== undefined && v !== (filter as any)[k]
        )
      ) {
        // result is empty for attempted scope breach
        return [];
      }

      let query: Query<T> = collection;

      // Apply filter constraints
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined) {
          query = query.where(key, '==', value);
        }
      }

      // Apply scope and soft delete constraints
      query = applyConstraints(query);

      const snapshot = await query.get();
      const results: Projected<T, P>[] = [];

      for (const doc of snapshot.docs) {
        const result = fromFirestoreDoc(doc, projection);
        if (result) {
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
      let query: Query<T> = collection;

      // Apply filter constraints
      for (const [key, value] of Object.entries(filter)) {
        if (value !== undefined) {
          query = query.where(key, '==', value);
        }
      }

      // Apply scope and soft delete constraints
      query = applyConstraints(query);

      const snapshot = await query.get();
      return snapshot.size;
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
