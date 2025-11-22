# Slire

- [Install](#install)
- [Quickstart](#quickstart)
- [API](#api)
- [Configuration](#configuration)
- [MongoDB Implementation](#mongodb-implementation)
- [Firestore Implementation](#firestore-implementation)

---

- [Recommended Usage Patterns](#recommended-usage-patterns)
- [Limitations and Caveats](#limitations-and-caveats)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [License](#license)
- [Why Slire?](docs/WHY.md)

---

Slire is a Node.js library providing a minimal, database‑agnostic repository layer that adds the consistency features most teams rewrite over and over: scope, timestamps, versioning, soft delete, and tracing — while keeping native drivers front and center. Use Slire when you want less boilerplate and safer CRUD, and keep using native drivers for anything advanced.

- Minimal abstraction over native drivers (no generic query DSL)
- Managed fields applied automatically and consistently
- Type‑safe CRUD, projections, and streaming queries
- Helpers for native ops: `applyConstraints`, `buildUpdateOperation`
- Transactions support
- Cursor‑based pagination with stable ordering

Currently implemented for [MongoDB](https://www.mongodb.com/) and [Firestore](https://firebase.google.com/docs/firestore).

Want the full rationale? See [Why Slire?](docs/WHY.md).

## Install

```bash
npm install slire
# or
pnpm add slire
# or
yarn add slire
```

## Quickstart

Slire implements the repository pattern: a collection‑like interface for accessing and manipulating domain objects. Each repository is bound to a specific database collection.

A Slire repository is instantiated with a configuration that defines which fields are managed automatically (id, timestamps, version, trace) and which scope to apply. Scope is a fixed filter that enforces tenancy/data partitioning across all operations.

For MongoDB, scope is merged into reads and writes; for Firestore, scope is validated on writes and typically enforced by path‑scoped collections. Managed fields are read‑only for updates and validated or ignored on create.

For the following examples, let's assume a simple collection type representing tasks:

```typescript
type Task = {
  id: string;
  tenantId: string; // scope
  title: string;
  status: 'todo' | 'in_progress' | 'done' | 'archived';
  dueDate?: Date;
  _createdAt?: Date;
};
```

Repository instantiation with MongoDB:

```typescript
import { MongoClient } from 'mongodb';
import { createMongoRepo } from 'slire';

const client = new MongoClient(process.env.MONGO_URI!);

const repo = createMongoRepo({
  collection: client.db('app').collection<Task>('tasks'),
  mongoClient: client,
  scope: { tenantId: 'acme-123' },
  options: { softDelete: true, traceTimestamps: true, version: true },
});
```

Repository instantiation with Firestore:

```typescript
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreRepo } from 'slire';

const db = new Firestore();

const repo = createFirestoreRepo({
  collection: db.collection('tenants/acme-123/tasks'),
  firestore: db,
  scope: { tenantId: 'acme-123' }, // validated on writes only
  options: { softDelete: true, traceTimestamps: 'server', version: true },
});
```

It’s recommended to provide a factory to encapsulate configuration (managed fields, scope) and database/collection names. For example, in MongoDB:

```typescript
function createTaskRepo(client: MongoClient, tenantId: string) {
  return createMongoRepo({
    collection: client.db('app').collection<Task>('tasks'),
    mongoClient: client,
    scope: { tenantId },
  });
}
```

A Slire repository implements a set of basic, DB-agnostic CRUD operations:

```typescript
const id = await repo.create({ title: 'Draft onboarding guide', status: 'todo' });

await repo.update(id, { set: { status: 'in_progress' } });

await repo.delete(id);

await repo.getById(id); // undefined
```

All read operations support projections. `find` returns a single‑use `QueryStream` you can iterate over or convert with `.toArray()`.

```typescript
const summary = await repo.getById(id, { id: true, title: true, status: true }); // -> { id: string; title: string; status: Task['status'] } | undefined

for await (const chunk of repo.find({ status: 'in_progress' }).paged(50)) {
  doSomething(chunk);
}

const list = await repo
  .find({}, { projection: { id: true, title: true } })
  .skip(5)
  .take(10)
  .toArray();
```

The full list is documented in the [API Reference](#api-reference-core-crud-operations-slire-interface) section.

Here's how [transactions](#runtransaction) work:

```typescript
await repo.runTransaction(async (tx) => {
  // tx is a transaction-aware repository instance
  // read overdue in-progress tasks, then archive them
  const now = new Date();
  const tasks = await tx
    // note: find currently supports exact equality matches only (no range operators)
    .find({ status: 'in_progress' }, { id: true, dueDate: true })
    .toArray();

  const overdueIds = tasks
    .filter((t) => t.dueDate && t.dueDate < now)
    .map((t) => t.id);

  if (overdueIds.length > 0) {
    await tx.updateMany(overdueIds, { set: { status: 'archived' } });
  }
});
```

This is a partially contrived example. For MongoDB, you’d normally perform a query‑based update in one round trip using the native driver directly. Firestore does not support query‑based writes, so they are not part of Slire’s DB-agnostic API.

The example above can be written more verbosely like this when working with MongoDB (revealing how `runTransaction` is implemented):

```typescript
await mongoClient.withSession(async (session) => {
  await session.withTransaction(async () => {
    const tx = repo.withSession(session); // a new transaction-aware repo instance

    const now = new Date();
    const tasks = await tx
      .find({ status: 'in_progress' }, { id: true, dueDate: true })
      .toArray();

    const overdueIds = tasks
      .filter((t) => t.dueDate && t.dueDate < now)
      .map((t) => t.id);

    if (overdueIds.length > 0) {
      await tx.updateMany(overdueIds, { set: { status: 'archived' } });
    }
  });
});
```

This approach obviously also allows you to have transactions that span multiple repositories - just create session-aware instances from different MongoDB repositories using the same session and all their operations will participate in the same transaction.

Finally, Slire intentionally steps aside for advanced operations that aren’t a good fit for a DB‑agnostic API. In those cases, use the native driver directly while reusing repository helpers to keep scope, timestamps, versioning, and tracing consistent.

```typescript
export async function archiveOverdueInProgressTasks({
  mongoClient,
  tenantId,
}: {
  mongoClient: MongoClient;
  tenantId: string;
}): Promise<void> {
  const repo = createTaskRepo(mongoClient, tenantId);
  const now = new Date();

  await mongoClient.withSession(async (session) => {
    await session.withTransaction(async () => {
      // Use native MongoDB update with Slire helpers:
      // - applyConstraints: merges scope and soft-delete filtering
      // - buildUpdateOperation: applies timestamps/versioning/tracing consistently
      await repo.collection.updateMany(
        repo.applyConstraints({ status: 'in_progress', dueDate: { $lt: now } }),
        repo.buildUpdateOperation({ set: { status: 'archived' } }),
        { session }
      );
    });
  });
}
```

This keeps database and collection details encapsulated by your factory while letting you use the full power of the native driver. You still benefit from consistent scope enforcement and managed fields without rewriting that logic.

## API

- CRUD
  - [getById](#getbyid), [getByIds](#getbyids)
  - [create](#create), [createMany](#createmany)
  - [update](#update), [updateMany](#updatemany)
  - [delete](#delete), [deleteMany](#deletemany)
- Queries
  - [find](#find), [findBySpec](#findbyspec)
  - [findPage](#findpage), [findPageBySpec](#findpagebyspec)
  - [count](#count), [countBySpec](#countbyspec)
- Transactions and helpers are implementation specific
  - [MongoDB Implementation](#mongodb-implementation)
  - [Firestore Implementation](#firestore-implementation)

The operations below comprise the full set of repository functions in Slire. The interface is database‑agnostic; where an implementation exhibits different performance characteristics or constraints, those differences are called out where relevant.

**Note 1**: In the function signatures below, `T` represents the entity type; `UpdateInput` is the subset of `T` that can be modified via updates (excluding managed fields); and `CreateInput` is the input shape for creating entities (includes optional managed fields). Managed fields include system fields (id, timestamps, version, soft‑delete markers) and scope fields.

**Note 2**: All read functions support projections, specified as `{ propA: true, propB: true }` where keys are valid properties of `T`. The return type reflects the projection.

**Note 3**: Scope filtering and other consistency features are configured at repository instantiation, not in the function signatures. Where relevant, function descriptions reference their effects as part of the interface contract that every implementation must honor.

### getById

`getById(id: string): Promise<T | undefined>`

`getById<P extends Projection<T>>(id: string, projection: P): Promise<Projected<T, P> | undefined>`

Retrieves a single entity by its ID, applying scope and consistency rules. Returns `undefined` if no entity exists with the given ID, if it’s out of scope (e.g., wrong tenant), or if it’s soft‑deleted (when enabled). With a projection, only the requested fields are returned and the result type reflects the projection.

Firestore notes:
- Slire expects path‑scoped collections; scope is not added to read filters (it’s enforced by the collection path and validated on writes).
- Projection is applied client-side.

### getByIds

`getByIds(ids: string[]): Promise<[T[], string[]]>`

`getByIds<P extends Projection<T>>(ids: string[], projection: P): Promise<[Projected<T, P>[], string[]]>`

Bulk version of `getById`. Returns a tuple `[found, notFoundIds]`. An ID is included in `notFoundIds` if it does not exist, is out of scope, or is soft‑deleted. The order of found entities is not guaranteed to match the input order. With the projection variant, only the requested fields are returned and the result types reflect the projection.

Firestore notes:
- Slire expects path‑scoped collections; scope is not added to read filters (it’s enforced by the collection path and validated on writes).
- Projection is applied client-side.

### create

`create(entity: CreateInput, options?: { mergeTrace?: any }): Promise<string>`

Creates a new entity. Generates an ID, applies scope values, and sets managed fields (timestamps, version, and trace if enabled). Managed system fields present in the input are ignored; scope fields are validated and must match the repository’s scope or the operation fails. Returns the generated ID. Use `options.mergeTrace` to add per‑operation trace context that is merged with the repository’s base trace.

Firestore notes:
- Slire expects path‑scoped collections; scope is validated on writes.
- When soft delete is enabled, documents are created with `_deleted: false` so reads can filter server‑side with `where('_deleted', '==', false)` (Firestore cannot query "field does not exist").

Note: This method delegates to `createMany` internally and can therefore throw `CreateManyPartialFailure` under the same conditions (for a single-entity batch, see below).

### createMany

`createMany(entities: CreateInput[], options?: { mergeTrace?: any }): Promise<string[]>`

Creates multiple entities. Generates IDs, applies scope, and sets managed fields (timestamps, version, and trace if enabled) for each entity. Returns generated IDs in the same order as the input. `options.mergeTrace` adds per‑operation trace context to all entities in the batch.

Firestore notes:
- Slire expects path‑scoped collections; scope is validated on writes.
- When soft delete is enabled, documents are created with `_deleted: false` so reads can filter server‑side with `where('_deleted', '==', false)`.
- Writes are chunked to Firestore batch limits; each batch is atomic.

MongoDB notes:
- Uses `bulkWrite` (upsert with `$setOnInsert`) for batched inserts; `insertMany` is not sufficient for Slire’s constraints and metadata handling.
- Writes are chunked to respect driver limits.

Error handling and partial writes: IDs are prepared up front. The operation runs in chunks to respect backend limits. If a chunk fails:
- MongoDB: the driver may have inserted a subset of the current chunk; the function throws `CreateManyPartialFailure` with `insertedIds` including prior chunks plus the inserted subset of the failing chunk, and `failedIndices` containing the 0‑based input indices of the remaining items in the failing chunk plus all subsequent chunks.
- Firestore: the entire failing batch is rolled back; the function throws `CreateManyPartialFailure` with `insertedIds` from prior batches only and `failedIndices` for the failed batch and all subsequent batches (0‑based input indices).

If you need atomicity across the whole input, wrap the call in a transaction via `runTransaction`.

### update

`update(id: string, update: UpdateOperation<UpdateInput>, options?: { mergeTrace?: any }): Promise<void>`

Updates a single entity by ID. Applies scope and excludes soft‑deleted documents (when enabled). Supports `set` and `unset` (single path or array; dot paths supported). Managed fields (id, scope, timestamps, version, trace) cannot be updated; this is enforced by types and validated at runtime. Timestamps/version are applied automatically, and `options.mergeTrace` merges per‑operation trace context. No error is thrown if the entity doesn’t exist or is out of scope.

Firestore notes:
- Firestore cannot perform "update with filter". To ensure we only update active (not soft-deleted) documents, the repo first queries for the doc by id with `_deleted == false`, then updates the returned doc reference.
- Transaction consequence: Firestore requires that all reads in a transaction happen before any writes. Because `update` performs that initial read, call it in the transaction’s read phase (before any writes). If you’ve already issued writes in the same transaction, defer `update` to a separate transaction or restructure your logic to read first, then write.

Examples:

```ts
await repo.update(id, {
  set: { status: 'in_progress', title: 'Refine onboarding guide' },
});

await repo.update(id, { unset: 'dueDate' });

await repo.update(id, {
  set: { status: 'done' },
  unset: ['metadata.audit.reviewedBy', 'metadata.flags.blocked'],
});
```

### updateMany

`updateMany(ids: string[], update: UpdateOperation<UpdateInput>, options?: { mergeTrace?: any }): Promise<void>`

Applies the same update to multiple entities by ID. Applies scope and excludes soft‑deleted documents (when enabled). Managed fields cannot be updated. Timestamps/version are applied automatically, and `options.mergeTrace` merges per‑operation trace context. Succeeds even if some IDs don’t exist or are out of scope (only active, in‑scope entities are updated).

For large inputs, implementations may process updates in chunks to respect native driver/datastore limits; chunked execution is not atomic across chunks. If you need all‑or‑nothing behavior across many IDs, wrap the call in a transaction with `runTransaction`. Be mindful of transaction size limits in your datastore (e.g., max operations per transaction); very large updates may need to be split across multiple transactions — atomicity is per transaction, not across multiple transactions.

Firestore notes:
- Uses `where(documentId(), 'in', [...])` and performs a read before writes; call inside the transaction’s read phase (before any writes).
- Respects Firestore limits (conservative `IN` size and batch size); executes multiple batches when needed. Not atomic across batches unless your transaction covers them.

MongoDB notes:
- Processes IDs in chunks to respect `$in` limits; each chunk is a single `updateMany` call with repository constraints applied. Not atomic across chunks unless wrapped in a transaction.

Example:

```ts
await repo.updateMany(
  [id1, id2, id3],
  { set: { status: 'archived' }, unset: 'dueDate' },
  { mergeTrace: { operation: 'archive-overdue' } }
);
```

### delete

`delete(id: string): Promise<void>`

Deletes a single entity by ID. Applies scope. With soft delete enabled, marks the entity as deleted (default `_deleted: true`) and applies timestamps/version/trace if configured; with hard delete, removes it physically. No error is thrown if the entity doesn’t exist or is out of scope. Soft‑deleted entities are excluded from subsequent reads.

Firestore notes:
- With soft delete, a read happens first to ensure the document is active (`_deleted == false`), then the delete mark is applied. In transactions, call during the read phase (before any writes).
- With hard delete, the document is deleted by path (no pre‑read). Path‑scoped collections are assumed; scope is validated on writes, not added to read filters.

### deleteMany

`deleteMany(ids: string[]): Promise<void>`

Removes multiple entities by ID. Applies scope. With soft delete enabled, marks entities as deleted (default `_deleted: true`) and applies timestamps/version/trace if configured; with hard delete, removes them physically. Succeeds even if some IDs don’t exist or are out of scope (only active, in‑scope entities are affected).

For large inputs, implementations may process deletions in chunks to respect native driver/datastore limits; chunked execution is not atomic across chunks. If you need all‑or‑nothing behavior across many IDs, run the deletion inside a transaction with `runTransaction`. Be mindful of transaction size limits (atomicity is per transaction; very large deletes may need multiple transactions).

Firestore notes:
- Soft delete: performs a read (by documentId IN) to select only active documents (`_deleted == false`), then applies the delete mark. In transactions, call during the read phase (before any writes).
- Hard delete: deletes documents by path (no pre‑read). Path‑scoped collections are assumed; scope is validated on writes, not added to read filters.
- Respects IN and batch limits; executes multiple batches when needed. Not atomic across batches unless the transaction covers them.

MongoDB notes:
- Soft delete: uses a single `updateMany` per chunk with repository constraints applied.
- Hard delete: uses `deleteMany` per chunk.
- Processes IDs in chunks to respect `$in` limits; not atomic across chunks unless wrapped in a transaction.

### find

`find(filter: Partial<T>, options?: FindOptions): QueryStream<T>`

`find<P extends Projection<T>>(filter: Partial<T>, options: FindOptions & { projection: P }): QueryStream<Projected<T, P>>`

Queries entities and returns a single‑use `QueryStream` (supports async iteration and `.toArray()`). Filters support exact equality on entity properties (no range operators). The repository applies scope rules and excludes soft‑deleted entities (when enabled). With projections, only the requested fields are returned and the result type reflects the projection.

The `FindOptions` parameter supports:

- `onScopeBreach?: 'empty' | 'error'` - Handle scope breaches
- `orderBy?: Record<string, 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'>` - Sort results (dot notation supported for nested properties)

Firestore notes:
- Path‑scoped collections are expected; scope is not added to read filters (it’s enforced by the collection path).
- When soft delete is enabled, Slire appends a server‑side filter.
- Projection is applied server‑side for non‑`idKey` fields; `idKey` is derived from `doc.id`.
- If `orderBy` doesn’t include an id field, `__name__` is appended as a tiebreaker for deterministic ordering.
- index requirements: composite indexes are required for queries that combine multiple equality filters and/or `orderBy` across fields. Firestore will fail such queries with an error that links to index creation. Create the composite index on the filtered and sorted fields in the order Firestore specifies.

MongoDB notes:
- Scope is merged into filters; with soft delete enabled, soft‑deleted documents are excluded.
- Public `idKey` maps to `_id` in filters/projections; string ids are converted to `ObjectId` when using server‑generated ids.
- If `orderBy` doesn’t include `_id`, `_id` is appended as a tiebreaker for deterministic ordering.
- index recommendations: add indexes that cover your equality filters and sort keys. For multi‑key sorting, prefer a compound index with the sort keys and `_id` last for a stable tiebreaker. Missing/insufficient indexes can cause collection scans and increased load.

Examples:

```typescript
// stream processing
for await (const task of repo.find({ status: 'in_progress' })) {
  console.log(task.title);
}

// convert to array
const tasks = await repo.find({ status: 'todo' }).toArray();

// chain operations
const nextTasks = await repo.find({ status: 'todo' }).skip(10).take(5).toArray();

// with ordering (dot paths supported)
const orderedTasks = await repo
  .find({}, { orderBy: { 'metadata.priority': 'desc', title: 'asc' } })
  .toArray();
```

**Important: QueryStream is single-use**

QueryStream instances are designed for single consumption. Once you start iterating (via `toArray()`, `for await`, or directly accessing the iterator), the stream is marked as consumed and cannot be reused:

```typescript
const stream = repo.find({ status: 'active' });

// first consumption - works fine
const results1 = await stream.toArray();

// second consumption - throws error
const results2 = await stream.toArray(); // Error: QueryStream has already been consumed

// chaining after consumption - also throws error
const limited = stream.take(10); // Error: Cannot chain operations on already-consumed QueryStream
```

To use the same query multiple times, call `find()` again to get a fresh stream. Chaining operations (like `take()`, `skip()`, `paged()`) is allowed before consumption starts, and each derived stream is independent:

```typescript
// valid: chain before consumption
const stream = repo.find({ status: 'active' });
const result = await stream.skip(10).take(5).toArray(); // Works fine

// valid: multiple derived streams from same base (before base is consumed)
const base = repo.find({});
const first10 = base.take(10);
const after10 = base.skip(10);
await first10.toArray(); // works
await after10.toArray(); // also works
```

### findBySpec

`findBySpec<S extends Specification<T>>(spec: S, options?: FindOptions): QueryStream<T>`

`findBySpec<S extends Specification<T>, P extends Projection<T>>(spec: S, options: FindOptions & { projection: P }): QueryStream<Projected<T, P>>`

Queries entities using a specification object that encapsulates filter criteria and business rules. Returns a single‑use `QueryStream`. Specifications resolve to equality filters via `toFilter()`. The repository applies scope rules and excludes soft‑deleted entities (when enabled). Supports the same options as `find` (e.g., `orderBy`, projections). Compose multiple specifications with `combineSpecs`.

See database‑specific notes under [find](#find).

Examples:

```typescript
// task specs
const inProgress: Specification<Task> = {
  toFilter: () => ({ status: 'in_progress' }),
  describe: 'in-progress tasks',
};

const withAssignee = (userId: string): Specification<Task> => ({
  toFilter: () => ({ 'metadata.assigneeId': userId }),
  describe: `assigned to ${userId}`,
});

// Combine and project
const tasks = await repo
  .findBySpec(combineSpecs(inProgress, withAssignee('u_123')), {
    orderBy: { 'metadata.priority': 'desc', title: 'asc' },
    projection: { id: true, title: true, status: true },
  })
  .toArray();
```

### findPage

`findPage(filter: Partial<T>, options: FindPageOptions): Promise<PageResult<T>>`

`findPage<P extends Projection<T>>(filter: Partial<T>, options: FindPageOptions & { projection: P }): Promise<PageResult<Projected<T, P>>>`

Provides efficient cursor-based pagination for large datasets. Unlike `find().skip().take()` which becomes slower with larger offsets, `findPage` uses database-native cursors for consistent performance regardless of page depth.

The `FindPageOptions` parameter includes:

- `limit: number` - Maximum number of items per page (required)
- `cursor?: string` - Cursor from previous page's `nextCursor` (optional)
- `orderBy?: Record<string, 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'>` - Sort order (dot notation supported)
- `onScopeBreach?: 'empty' | 'error'` - Handle scope breaches (default: 'empty')

Firestore notes:
- Path‑scoped collections are expected; scope is not added to read filters.
- When soft delete is enabled, Slire appends a server‑side filter to exclude soft‑deleted documents.
- Projection is applied server‑side for non‑`idKey` fields; `idKey` is derived from `doc.id`.
- If `orderBy` doesn’t include an id field, `__name__` is appended as a tiebreaker for deterministic ordering.
- Cursor format is the document id; invalid/unknown cursors result in an error.
- index requirements: `findPage` queries that combine filters and `orderBy` require composite indexes. Firestore returns an error with a direct link to create the needed index. Ensure the index includes the filtered fields and the ordered fields in the correct order.

MongoDB notes:
- Scope is merged into filters; soft‑deleted documents are excluded when enabled.
- Public `idKey` maps to `_id`; string ids are converted to `ObjectId` when using server‑generated ids.
- If `orderBy` doesn’t include `_id`, `_id` is appended as a stable tiebreaker.
- Cursor format is the document `_id` (as a string); invalid cursors result in an error.
- For performant custom `orderBy`, create a compound index on your sort fields with `_id` as the final field.

Returns `PageResult<T>` containing:

- `items: T[]` - The page of results (up to `limit` items)
- `nextCursor: string | undefined` - Cursor for next page (undefined when no more results)

Examples:

```typescript
const pageParams = {
  limit: 20,
  orderBy: { _createdAt: 'desc' },
  projection: { id: true, title: true },
 };

let page = await repo.findPage(
  { status: 'in_progress' },
  pageParams
);

do {
  doSmth(page.items);
  if (!page.nextCursor) break;
  page = await repo.findPage(
    { status: 'in_progress' },
    {
      ...pageParams,
      cursor: page.nextCursor,
    }
  );
} while (true);
```

**When to Use:**

- Use `findPage` for UI pagination, API endpoints with page tokens, or iterating through large datasets across multiple requests
- Use `find().skip().take()` for small result sets, client-side streaming, or when you need the full QueryStream interface

### findPageBySpec

`findPageBySpec<S extends Specification<T>>(spec: S, options: FindPageOptions): Promise<PageResult<T>>`

`findPageBySpec<S extends Specification<T>, P extends Projection<T>>(spec: S, options: FindPageOptions & { projection: P }): Promise<PageResult<Projected<T, P>>>`

Provides cursor-based pagination using specification objects for query criteria. Works identically to `findPage` but accepts a `Specification<T>` instead of a filter object, enabling reusable, composable query logic. See [Query Abstraction Patterns](#query-abstraction-patterns) for detailed examples of the specification pattern.

See database‑specific notes under [findPage](#findpage).

Examples:

```typescript
const inProgress: Specification<Task> = {
  toFilter: () => ({ status: 'in_progress' }),
  describe: 'in-progress tasks',
};

const pageParams = {
  limit: 20,
  orderBy: { _createdAt: 'desc' },
  projection: { id: true, title: true },
};

let page = await repo.findPageBySpec(inProgress, pageParams);

do {
  doSmth(page.items);
  if (!page.nextCursor) break;
  page = await repo.findPageBySpec(inProgress, {
    ...pageParams,
    cursor: page.nextCursor,
  });
} while (true);
```

### count

`count(filter: Partial<T>, options?: { onScopeBreach?: 'zero' | 'error' }): Promise<number>`

Returns the number of entities that match the filter (exact‑equality predicates). Applies scope rules and excludes soft‑deleted entities (when enabled). On scope‑breach, returns `0` by default (`onScopeBreach: 'zero'`) or throws when set to `'error'`. Returns `0` when no matches are found.

Firestore notes:
- Uses the server‑side count aggregation (`query.count().get()`); documents are not fetched.
- Path‑scoped collections are expected; scope is not added to read filters.
- When soft delete is enabled, Slire appends a server‑side filter to exclude soft‑deleted documents.
- Index requirements: the same composite indexes required for the equivalent `find` query also apply to `count`; Firestore fails with an index error if missing.

MongoDB notes:
- Uses `countDocuments` with repository constraints (scope and soft‑delete filter).
- Performs best with indexes on filter fields; missing/insufficient indexes may cause collection scans and higher load.

### countBySpec

`countBySpec<S extends Specification<T>>(spec: S, options?: { onScopeBreach?: 'zero' | 'error' }): Promise<number>`

Counts entities that match a specification (spec resolves to an exact‑equality filter via `toFilter()`). Applies scope rules and excludes soft‑deleted entities (when enabled). On scope‑breach, returns `0` by default (`onScopeBreach: 'zero'`) or throws when set to `'error'`. Returns `0` when no matches are found. Uses the same specification objects as `findBySpec`, ensuring consistent query logic across find and count.

See database‑specific notes under [count](#count).

## Configuration

This section documents every configuration option the repository understands. For brevity, all code samples below use `createMongoRepo`; semantics are identical for Firestore unless a Firestore note says otherwise.

- Scope: [scope](#scope)
- Identity: [generateId](#generateid), [idKey](#idkey), [mirrorId](#mirrorid)
- Consistency: [softDelete](#softdelete), [traceTimestamps](#tracetimestamps), [timestampKeys](#timestampkeys),
 [version](#version)
- Tracing: [traceContext](#tracecontext), [traceStrategy](#tracestrategy), [traceLimit](#tracelimit), [traceKey](#tracekey)

### scope

Defines the fixed filter used to enforce multi‑tenancy or other partitioning rules (for example, `{ tenantId: 'acme-123' }`). Scope can include multiple properties (for example, `{ tenantId: 'acme-123', regionId: 'eu', isActive: true }`). It expresses required field values and is part of the repository’s contract for all operations; see the DB‑specific notes below for how each implementation enforces it.

MongoDB notes:
- Scope is merged into reads, updates, and deletes.
- Create operations validate any explicit scope fields in the payload and always write the configured scope values.

Firestore notes:
- Slire assumes path‑scoped collections (for example, `tenants/{tenantId}/tasks`); scope is not added to read filters because the path enforces it.
- Pass `scope` at repository creation if you want write‑time validation; mismatches cause the operation to fail.
 
Limitation:
 - Nested scope objects are not supported; scope keys must reference top‑level primitive fields (for example, `tenantId`, not `tenant.id`). The repository enforces this at instantiation time.

Example:

```typescript
const repo = createMongoRepo({
  collection: client.db('app').collection<Task>('tasks'),
  mongoClient: client,
  scope: { tenantId: 'acme-123' },
});

// ✅ Create: no explicit scope -> repo sets configured scope
await repo.create({
  title: 'Onboard new customer',
  status: 'todo',
});

// ✅ Create: explicit scope allowed if matching repo scope
await repo.create({
  tenantId: 'acme-123', // matches scope ✓
  title: 'Onboard new customer',
  status: 'todo',
});

// ❌ Create: scope validation fails
await repo.create({
  tenantId: 'different', // doesn't match scope - throws error
  title: 'Wrong tenant',
  status: 'todo',
});

// ✅ Update: scope properties are excluded from updates (readonly)
await repo.update(taskId, {
  set: { title: 'Refine onboarding guide' }, // OK - non-scope property
});

// ❌ Update: scope properties cannot be updated
await repo.update(taskId, {
  set: { tenantId: 'new-tenant' }, // TypeScript error + runtime error
});
```

### generateId

Controls how the datastore identifier is created. Accepts `'server'` or a function `() => string`. With `'server'`, id allocation is delegated to the datastore’s native mechanism. With a function, the returned string is used as the datastore id. The custom generator must produce unique strings; collisions will fail the write (and may surface as partial‑failure errors in batched creates).

MongoDB notes:
- `'server'` allocates `ObjectId`s client‑side for creates and `createMany`.
- When a custom generator is used, its return value is stored directly in `_id` as a string (no `ObjectId` conversion). Avoid mixing id types within the same collection.
 - `ObjectId` embeds time information and is roughly ordered; switching to custom string ids removes this characteristic.

Firestore notes:
- `'server'` uses `collection.doc().id` to allocate ids client‑side before writes.
- A custom generator must return a string; that value becomes the document id (`doc.id`).
 - Uniqueness is enforced within the target collection path; with path‑scoped collections this effectively means uniqueness per scope (e.g., per tenant collection).

Example:
```ts
const repo = createMongoRepo({
  collection,
  mongoClient,
  options: { generateId: () => crypto.randomUUID() },
});
```

### idKey

Accepts a property name of your entity (default `'id'`). This property exposes the datastore id on read (regardless of whether ids are server‑generated or provided by a custom generator) and is readonly for updates. The value is not stored in the document unless you enable [mirrorId](#mirrorid).

MongoDB notes:
- Filters using `idKey` are translated to `_id`; when using `'server'` ids, strings are converted to `ObjectId` automatically.
- Projections using `idKey` are translated to `_id` internally and returned as `idKey` on the entity.
- Ordering using `orderBy` translates `idKey` to `_id` and always appends `_id` as a tiebreaker if needed.

Firestore notes:
- `idKey` reflects `doc.id` (the document path id).
- Filters using `idKey` are translated to `FieldPath.documentId() == ...`.
- Projections do not fetch a stored `idKey` (it isn’t stored by default); the value is derived from `doc.id` and included in the result when requested in the projection.

### mirrorId

Accepts `boolean` (default `false`). When `true`, the repository also persists the public id under `idKey` in addition to the datastore id. Reads are unaffected (entities always expose `idKey`); `idKey` remains readonly for updates regardless of this setting.

MongoDB notes:
- Persists a duplicate id field alongside `_id`. If you plan to query by `idKey`, consider adding an index on that field.

Firestore notes:
- Persists `idKey` as a normal document field; `doc.id` remains the primary identifier.
- Queries on `idKey` may require a composite index depending on other filters/sorts.

Example:
```ts
const repo = createMongoRepo({
  collection,
  mongoClient,
  options: { mirrorId: true },
});
const id = await repo.create(createTask());
const raw = await repo.collection.findOne({ _id: new ObjectId(id) });
// raw contains both _id and id (when idKey is the default 'id')
``` 

### softDelete

Accepts `boolean` (default `false`). When enabled, the repository manages a `_deleted` marker instead of physically removing documents. Read operations (`getById`, `find`, `findPage`, `count`) automatically exclude soft‑deleted documents. Update operations only affect active documents. Delete operations set the marker (and apply `deletedAt` and version increments when timestamping/versioning is configured). `getById` returns `undefined` for soft‑deleted documents.

MongoDB notes:
- "Active" means the `_deleted` field does not exist; delete operations set `_deleted: true`.
- Repository filters use "field does not exist" for activity checks; hard deletes are still possible via the native collection if you need to purge data.

Firestore notes:
- New documents are created with `_deleted: false`; queries append `where('_deleted', '==', false)` to exclude deleted documents.
- Rationale: Firestore does not support querying for "field does not exist"; a boolean marker enables server‑side filtering (and counting) without fetching documents or doing client‑side post‑processing.
- Delete operations set `_deleted: true`. In transactions, remember Firestore’s read‑before‑write rule for methods that perform an internal read.

### traceTimestamps
If set, enables managed timestamps. Accepts `true | 'server' | (() => Date)`. Default is no timestamps. Settinng only [`timestampKeys`](#timestampkeys) implies `traceTimestamps: true`.

What it does (when enabled):
- Sets `_createdAt` and `_updatedAt` on create (both to the same timestamp)
- Sets `_updatedAt` on every update
- Sets `_updatedAt` and `_deletedAt` on soft delete

These fields are repository‑managed (readonly) when timestamping is enabled.

Sources:
- `true` (application time): uses `new Date()` on the client
- `'server'`: uses the datastore’s server timestamp
- `() => Date`: calls your function to produce a `Date` (useful for tests/clock control)

MongoDB notes:
- `'server'` uses `$currentDate` to populate timestamp fields using server time (from the database).

Firestore notes:
- `'server'` uses `FieldValue.serverTimestamp()`.
- Reads always return JavaScript `Date` objects; Firestore `Timestamp`s are converted during hydration.

Example (custom clock):
```ts
let now = new Date('2025-01-01T00:00:00Z');
const clock = () => now;

const repo = createMongoRepo({
  collection,
  mongoClient,
  options: { softDelete: true, traceTimestamps: clock },
});

const id = await repo.create({ title: 'Draft' });    // _createdAt == _updatedAt == 00:00:00Z

now = new Date('2025-01-01T00:00:01Z');
await repo.update(id, { set: { title: 'Review' } }); // _updatedAt == 00:00:01Z

now = new Date('2025-01-01T00:00:02Z');
await repo.delete(id);                               // _updatedAt == _deletedAt == 00:00:02Z
```

### timestampKeys
Renames timestamp fields and accepts a partial object `{ createdAt?, updatedAt?, deletedAt? }`. Providing `timestampKeys` enables timestamping (equivalent to setting `traceTimestamps: true`). Any unspecified keys fall back to the defaults `_createdAt`, `_updatedAt`, and `_deletedAt`. The `deletedAt` key is only used when [softDelete](#softdelete) is enabled. These fields are repository‑managed and cannot be set, updated, or unset via updates. By default, underscore‑prefixed fields are hidden on reads, while custom names are returned as normal properties. Custom timestamp keys must refer to entity properties of type `Date`.

Example:
```ts
const repo = createMongoRepo({
  collection,
  mongoClient,
  options: {
    timestampKeys: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  },
});
```

### version
Maintains a monotonically increasing version field for each document. Set `version: true` to use the default `_version` field, or set `version: 'yourNumericField'` to use a custom numeric property from your entity. The repository initializes the version to `1` on create and increments it by `1` on every update and on soft delete; hard deletes remove the document and therefore do not write a new version. 

The version field is repository‑managed and cannot be set, updated, or unset by user updates; any value provided on create is ignored. When `true` is used, the default `_version` field is hidden on reads; when a custom key is used, that field is returned like any other property. Custom version keys must refer to entity properties of type `number`. 

MongoDB notes:
- Uses `$setOnInsert` to initialize the version to `1` on create and `$inc` to increment by `1` on update and on soft delete.

Firestore notes:
- Sets the version to `1` on create and uses `FieldValue.increment(1)` to increment by `1` on update and on soft delete.

Slire does not perform conditional writes based on expected version. While this would work trivially with MongoDB in a single round trip, Firestore requires a transactional read before write for the check. If you need optimistic concurrency checks, implement them in your application logic (for example, read and compare before writing within a transaction).

Example of an optimistic update function for MongoDB:
```ts
const repo = createMongoRepo({
  collection,
  mongoClient,
  options: { version: true },
});

const optimisticUpdate = async (
  id: string,
  update: Parameters<typeof repo.update>[1],
  options: { expectedVersion: number, mergeTrace?: any},
) => {
  const result = await repo.collection.updateOne(
    repo.applyConstraints({
      _id: new ObjectId(id),
      _version: options.expectedVersion,
    }),
    repo.buildUpdateOperation(update, options.mergeTrace),
  );
  if (result.matchedCount === 0) {
    throw new Error(
      `Version conflict for ${id} (expected ${options.expectedVersion})`,
    );
  }
};
```

A MongoDB-specific helper (for example, `optimisticUpdateFilter`) is under consideration for a future version to simplify this pattern.

### traceContext
Sets a base trace object that the repository writes on every write operation. The base context is merged with per‑operation context passed via `options.mergeTrace` on `create`, `createMany`, `update`, `updateMany`, and, if soft-delete is enabled, `delete` and `deleteMany`. The repository augments the trace with `_op` (the operation) and `_at` (a timestamp) automatically; `_at` follows the configured timestamp source from [traceTimestamps](#tracetimestamps) (application time, server time, or a custom clock). The shape of the context is entirely application‑defined (for example, `userId`, `requestId`, `service`).

Saving trace data with each write provides a lightweight, always‑available audit trail. It makes it easy to answer who changed what and when, correlate changes to requests or background jobs, debug incidents with precise context, and satisfy operational/compliance needs without a separate pipeline. Because the trace is stored with the document, downstream processors (for example, change streams) can reliably enrich centralized audit logs while reads still have immediate access to the latest context.

MongoDB notes:
- with server timestamps enabled, the repository uses `$currentDate` for the `_trace._at` field when needed
- for `bounded` and `unbounded` [traceStrategy](#tracestrategy) `_trace._at` falls back to application time to avoid read-before-write

Firestore notes:
- with server timestamps enabled, the repository uses `FieldValue.serverTimestamp()` for `_trace._at`
- the `bounded` trace strategy is not supported (see [traceStrategy](#tracestrategy))

Example:
```ts
const repo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId: 'user123', requestId: 'req-34' },
  options: { traceStrategy: 'latest', traceTimestamps: 'server' },
});
await repo.update(id, { set: { status: 'done' } }, { mergeTrace: { action: 'complete-task' } });
// resulting document includes:
// {
//   ...,
//   _trace: {
//     userId: 'user123',
//     requestId: 'req-34',
//     action: 'complete-task',
//     _op: 'update',
//     _at: new Date('2025-10-21T09:34:23:743Z')
//   }
// }
```

### traceStrategy

Controls how trace data is stored:
- `latest` (default): keep only the most recent trace object.
- `bounded`: append to an array capped by [traceLimit](#tracelimit).
- `unbounded`: append to an unbounded array.

Firestore: `bounded` is not supported and will throw at repository creation.

### traceLimit

The maximum number of trace entries to keep when `traceStrategy` is `bounded`. Ignored for other strategies.

### traceKey

Sets the field used to store trace data written on each write (default `_trace`). The default field is hidden on reads unless you explicitly model it in the entity type.






---
content below is temporary and needs restructure...

---

## MongoDB Implementation

 The MongoDB implementation provides a repository factory that returns a small set of helpers on top of the DB‑agnostic API. It covers sessions/transactions and native collection helpers for cases that require direct collection access while keeping scope, timestamps, versioning, and tracing consistent with the repository.

### createMongoRepo

`createMongoRepo({ collection, mongoClient, scope?, traceContext?, options?, session? })`

This factory returns a repository that implements the full Slire API and Mongo‑specific helpers. It requires a MongoDB `collection` and the `mongoClient`. You may pass a `session` to bind the instance to an existing transaction; otherwise, use the helpers below to work with sessions when needed. The remaining parameters are documented in [Configuration](#configuration): see [scope](#scope), [traceContext](#tracecontext), and options ([softDelete](#softdelete), [traceTimestamps](#tracetimestamps), [timestampKeys](#timestampkeys), [version](#version), [traceStrategy](#tracestrategy), [traceLimit](#tracelimit), [traceKey](#tracekey)).

What you get in addition to the DB‑agnostic API are direct `collection` access, `applyConstraints` for safe filters, `buildUpdateOperation` for update documents with timestamps/version/trace applied, and session/transaction helpers.

### Sessions and transactions

The repository function `withSession(session: ClientSession)` creates a session‑bound repository that participates in the given transaction for all subsequent operations. The returned instance preserves scope, timestamps, versioning, and trace settings. Calling it on an already session‑bound repo replaces the session; MongoDB does not support nested transactions. Use this to coordinate a single MongoDB session across multiple repositories operating on different collections.

Example (multiple repositories in one transaction):
```ts
const taskRepo = createMongoRepo({
  collection: client.db('app').collection<Task>('tasks'),
  mongoClient: client,
  scope: { tenantId },
});
const projectRepo = createMongoRepo({
  collection: client.db('app').collection<Project>('projects'),
  mongoClient: client,
  scope: { tenantId },
});

await client.withSession(async (session) => {
  await session.withTransaction(async () => {
    const tasks = taskRepo.withSession(session);
    const projects = projectRepo.withSession(session);

    const task = await tasks.getById(taskId);
    if (!task) throw new Error('Task not found');

    await tasks.update(
      taskId,
      { set: { status: 'done' } },
      { mergeTrace: { action: 'complete-task' } }
    );

    await projects.update(
      projectId,
      { set: { progress: 'in_progress' } },
      { mergeTrace: { reason: 'task-completed', taskId } }
    );
  });
});
```

`runTransaction(callback)` is a convenience wrapper that creates a session, starts a transaction, gives you a session‑aware repo inside the callback, and commits or rolls back automatically. Use it when a single‑collection transaction via the repository API is sufficient; use `withSession` if you need to mix repository calls with native driver operations within the same transaction.

### collection

`collection: Collection<any>`

This property gives direct access to the underlying MongoDB collection instance and allows you to perform advanced MongoDB operations that aren't covered by the Slire interface, such as aggregations, complex queries, bulk operations, or any other collection-level methods. When using the collection directly, you can still leverage the repository's helper methods (`applyConstraints`, `buildUpdateOperation`) to maintain consistency with the repository's configured scoping, timestamps, and versioning behavior.

### applyConstraints

`applyConstraints(input: any): any`

Helper method that applies the repository's scope filtering to a given filter object. Takes your custom filter criteria and merges it with the repository's configured scope. If soft-delete is enabled it enriches the filter to ensure operations only target entities within the repository's scope that haven't been soft-deleted. Essential for maintaining data isolation when performing direct queries, updates, deletes, aggregations, or bulk operations on the collection.

### buildUpdateOperation

`buildUpdateOperation(update: UpdateOperation<UpdateInput>, mergeTrace?: any): any`

Helper method that transforms a repository update operation into a MongoDB-compliant update document with all configured consistency features applied. Takes an `UpdateOperation<UpdateInput>` with `set` and/or `unset` fields and automatically adds timestamps (like `updatedAt`), version increments, trace context (if enabled), and any other configured repository features. The optional `mergeTrace` parameter allows adding operation-specific trace context that gets merged with the repository's base trace context. Modification of system-managed fields is both prevented at compile time (type-level) and at runtime. This ensures that direct collection operations maintain the same consistency behavior as the repository's built-in update methods. Essential when performing direct `updateOne`, `updateMany`, or `bulkWrite` operations on the collection.

```typescript
const updateOp = repo.buildUpdateOperation(
  { set: { status: 'processed' } },
  { operation: 'batch-process', jobId: 'job-123' }
);

await repo.collection.updateMany(
  repo.applyConstraints({ isActive: true }),
  updateOp
);
```

### When you need upsert

Slire does not include upsert operations to keep the core API simple and semantics clear. When you need upsert operations, use the MongoDB collection directly with these patterns while reusing repository helpers for consistency:

- merge-style upsert (preserve unspecified fields):

```ts
await repo.collection.updateOne(
  repo.applyConstraints({ _id: new ObjectId(id) }),
  repo.buildUpdateOperation({ set: partialEntity }),
  { upsert: true }
);
```

- replace-like upsert (clear unspecified fields):

```ts
const current = await repo.collection.findOne(
  repo.applyConstraints({ _id: new ObjectId(id) })
);

// build target input from your payload stripped off of managed fields
const target = /* stripManaged(input) -> any */;

// compute all keys that exist in `current` but not in `target`.
// important: include nested keys using MongoDB dot-notation (e.g., { a: { b: 1 } } -> ['a.b']).
// exclude datastore keys like '_id'.
// implement a deep diff to collect these paths.
const unsetKeys = /* computeUnsetKeys(current, target) -> string[] */;

// reuse repository logic for timestamps/versioning and validation
const update = repo.buildUpdateOperation({ set: target, unset: unsetKeys as any });
await repo.collection.updateOne(
  repo.applyConstraints({ _id: new ObjectId(id) }),
  update,
  { upsert: true }
);
```

You can still leverage `repo.applyConstraints` for scope/soft-delete filtering and `repo.buildUpdateOperation` for timestamp/version logic in merge-style scenarios. For replace-like behavior with server timestamps, prefer `updateOne` with update modifiers provided by `buildUpdateOperation` (as shown) rather than `replaceOne` as it doesn't support server timestamps.

Note: The replace-like pattern performs a pre-read to compute unset keys. To avoid race conditions and achieve all-or-nothing behavior, wrap this sequence in a transaction using `runTransaction`.

### Notes

When using the native collection directly, remember that the public `idKey` maps to `_id` and may be an `ObjectId` when `generateId: 'server'` is used; convert string ids accordingly. The repository ensures stable ordering by appending `_id` as a tiebreaker where needed; mirror this pattern in custom queries if you depend on deterministic ordering. Repository methods automatically chunk large batches to respect MongoDB limits (see `createMany`, `updateMany`, and `deleteMany`); when issuing large native operations yourself, apply appropriate batching as needed.

## Firestore Implementation

The Firestore implementation provides a repository factory and a small set of helpers on top of the DB‑agnostic API. It focuses on transaction‑aware repositories and native collection helpers that respect Firestore’s path‑scoped model and server‑side filtering for soft deletes.

### createFirestoreRepo

`createFirestoreRepo({ collection, firestore, scope?, traceContext?, options?, transaction? })`

This factory returns a repository that implements the full Slire API and Firestore‑specific helpers. It requires a Firestore `collection` (a `CollectionReference<T>`) and the `firestore` client. You may pass a `transaction` to bind the instance to an existing Firestore transaction; otherwise, use the helpers below to work with transactions when needed. The remaining parameters are documented in [Configuration](#configuration): see [scope](#scope), [traceContext](#tracecontext), and options ([softDelete](#softdelete), [traceTimestamps](#tracetimestamps), [timestampKeys](#timestampkeys), [version](#version), [traceStrategy](#tracestrategy), [traceLimit](#tracelimit), [traceKey](#tracekey)).

What you get in addition to the DB‑agnostic API are direct `collection` access, `applyConstraints` to add server‑side soft‑delete filtering to queries, `buildUpdateOperation` to generate Firestore update maps with timestamps/version/trace applied, and transaction helpers.

### Transactions

`withTransaction(tx: Transaction)` creates a transaction‑bound repository; all reads and writes happen through the provided `tx`. Firestore requires that all reads in a transaction occur before any writes. Repository methods like `update`, `updateMany`, and soft‑`delete` perform an internal read to select active documents (`_deleted == false`), so call them during the transaction’s read phase and perform your writes after the reads have completed.

`runTransaction(callback)` is a convenience wrapper that starts a Firestore transaction, provides a transaction‑bound repo to the callback, and commits or rolls back automatically. Use it when a single‑collection transaction via the repository API is sufficient; use `withTransaction` if you need to coordinate multiple repositories in the same transaction.

Example (read first, then write within one transaction):
```ts
// Assume Task and Project as defined above
await firestore.runTransaction(async (tx) => {
  const txTasks = taskRepo.withTransaction(tx);
  const txProjects = projectRepo.withTransaction(tx);

  // Read phase: collect necessary docs using transaction-backed methods
  const [tasks] = await txTasks.getByIds([taskId], { id: true });
  if (tasks.length === 0) throw new Error('Task not found');

  // Write phase: repository update methods will use the same transaction
  await txTasks.update(taskId, { set: { status: 'in_progress' } });
  await txProjects.update(projectId, { set: { progress: 'in_progress' } });
});
```

### collection

`collection: CollectionReference<T>`

This property gives direct access to the underlying Firestore collection and allows you to run native queries, batch writes, and transaction operations not covered by the Slire interface. When using the collection directly, prefer `applyConstraints` for queries that should exclude soft‑deleted documents and reuse `buildUpdateOperation` to ensure timestamps, versioning, and tracing are applied consistently.

### applyConstraints

`applyConstraints(query: Query): Query`

Adds the repository’s server‑side soft‑delete filter to a query. Firestore repositories do not add scope filters to reads because path‑scoped collections are expected; `scope` is validated at write time. Use this helper to append the `where('_deleted', '==', false)` predicate when `softDelete` is enabled.

Example:
```ts
const q = repo.applyConstraints(
  repo.collection.where('status', '==', 'in_progress')
);
const snap = await q.get();
```

### buildUpdateOperation

`buildUpdateOperation(update: UpdateOperation<UpdateInput>, mergeTrace?: any): Record<string, any>`

Builds a Firestore update map from `set`/`unset` instructions and automatically injects timestamps, version increments, and trace context (including `_op`/`_at`) according to your configuration. Pass the returned object to `transaction.update`, `batch.update`, or `docRef.update`.

Example:
```ts
const update = repo.buildUpdateOperation(
  { set: { status: 'done' }, unset: 'draft.notes' },
  { action: 'complete-task' }
);
await repo.collection.doc(taskId).update(update);
```

### When you need upsert (merge pattern)

The DB‑agnostic API does not include upsert. In Firestore, you can emulate merge‑style upsert using `set(..., { merge: true })` while still leveraging repository helpers to apply timestamps, versioning, and trace context. Build the update map and pass it to `set` with `merge: true`; `FieldValue.*` operations produced by the helper are preserved by Firestore.

```ts
const upsertData = repo.buildUpdateOperation(
  { set: { status: 'in_review', reviewerId } },
  { reason: 'auto-assign' }
);
await repo.collection.doc(taskId).set(upsertData, { merge: true });
```

### Notes

Path‑scoped collections are recommended (for example, `tenants/{tenantId}/tasks`); `idKey` maps to `doc.id`, and `mirrorId` stores it as a field if enabled. Soft delete uses a boolean `_deleted` field to enable server‑side filtering and counting. Queries that combine filters and sorting may require composite indexes; Firestore will throw an error with a link to create the required index when missing. The `bounded` trace strategy is not supported in Firestore; use `latest` or `unbounded` instead (see [traceStrategy](#tracestrategy)).

## Recommended Usage Patterns

Follow the recommendations in this section to maintain consistency and keep the code organized. Most of them apply to the current MongoDB implementation.

!!TODO - link to article (part 2 of this doc) for more detailed architectural guidance

### Repository Factories

Prefer creating dedicated factory functions over direct `createMongoRepo` calls to encapsulate configuration:

```typescript
// ✅ GOOD - encapsulated factory
export function createExpenseRepo(client: MongoClient, orgId: string) {
  return createMongoRepo({
    collection: client.db('expenseDb').collection<Expense>('expenses'),
    mongoClient: client,
    scope: { organizationId: orgId },
    options: {
      generateId: generateExpenseId,
      timestampKeys: {
        createdAt: 'createdAt'
        updatedAt: 'updatedAt'
      },
      version: true
    }
  });
}

// ❌ ACCEPTABLE but less maintainable - direct usage everywhere
const repo = createMongoRepo({ ... });
```

Repository factories are also ideal for enforcing trace context to ensure gapless audit history:

```typescript
// factory that enforces trace context for audit compliance
export function createExpenseRepo(
  client: MongoClient,
  orgId: string,
  traceContext: { userId: string; requestId: string; service: string }
) {
  return createMongoRepo({
    collection: client.db('expenseDb').collection<Expense>('expenses'),
    mongoClient: client,
    scope: { organizationId: orgId },
    traceContext, // Always required - no repository without audit context
    options: {
      generateId: generateExpenseId,
      timestampKeys: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
      version: true,
      traceStrategy: 'latest', // Configure for change stream processing
    },
  });
}

// Usage - trace context is mandatory, preventing accidental gaps
const repo = createExpenseRepo(client, orgId, {
  userId: 'john.doe',
  requestId: req.id,
  service: 'expense-api',
});
```

This pattern ensures every operation is automatically traced, making audit log gaps impossible through design rather than discipline.

### Export Repository Types

Alongside your repository factories, always export a corresponding type that captures the exact return type:

```typescript
// expense-repo.ts

// ✅ GOOD - export both factory and type
export function createExpenseRepo(client: MongoClient, orgId: string) {
  return createMongoRepo({ ... });
}

export type ExpenseRepo = ReturnType<typeof createExpenseRepo>;

// business-logic.ts

// ❌ BAD - manual generic parameters, can get out of sync & tight coupling
function processExpenses(deps: { repo: Repo<Expense, any, any> }, params: { ... }) {
  // ...
}

// ❌ BAD - while guaranteed to match exact repo type, it leads to tight coupling (full repo injected)
function processExpenses(deps: { repo: ExpenseRepo }, params: { ... }) {
  // ...
}

// ✅ GOOD - explicit, properly typed dependencies (see decoupling section below)
function processExpenses(deps: { getById: ExpenseRepo['getById'], update: ExpenseRepo['update'] }, params: { ... }) {
  // ...
}
```

Reasons to derive repository types from factory functions:

- Captures the precise generic parameters from your factory configuration
- Type automatically updates when you modify the factory function
- Avoid manually reconstructing `Repo<Expense, { organizationId: string }, ExpenseEntity>`
- Single source of thruth: Factory function defines both implementation and type

### Always Use Helper Methods for Direct Collection Operations

When performing operations directly on `repo.collection`, always use the provided helper methods to maintain repository behavior:

```typescript
// ✅ GOOD - uses helper methods (excludes soft-deleted)
await repo.collection.updateMany(
  repo.applyConstraints({ status: 'active' }),
  repo.buildUpdateOperation({ set: { processed: true } })
);

// ❌ BAD - bypasses repository consistency
await repo.collection.updateMany(
  { status: 'active' },
  { $set: { processed: true } }
);
```

### Audit Trail Strategies with Tracing

Slire's built-in tracing functionality is specifically designed for two primary audit strategies: **change stream processing** (using the "latest" trace strategy) and **embedded audit trails** (using either "bounded" or "unbounded" trace strategies). The tracing feature automatically embeds trace context into documents during write operations, making it ideal for these approaches.

This section first covers these Slire-native strategies, followed by alternative approaches that implement audit logging without relying on Slire's tracing feature - giving you flexibility to choose based on your specific requirements and infrastructure.

#### Change Stream Processing (Recommended)

**Approach:** Use MongoDB change streams to monitor document changes and build audit logs asynchronously from the embedded trace context.

```typescript
// Change stream processor
const changeStream = db
  .collection('expenses')
  .watch([{ $match: { 'fullDocument._trace': { $exists: true } } }]);

changeStream.on('change', async (event) => {
  const auditEntry = {
    entityId: event.fullDocument.id,
    entityType: 'expense',
    operation: event.operationType,
    trace: event.fullDocument._trace,
    timestamp: event.clusterTime,
    before: event.updateDescription ? await reconstructBefore(event) : null,
    after: event.fullDocument,
    changes: event.updateDescription?.updatedFields || null,
  };

  await auditCollection.insertOne(auditEntry);
});
```

**Pros:**

- Non-blocking write operations - audit processing doesn't slow down business operations
- Reliable event delivery with resume tokens for fault tolerance
- Natural separation of concerns - audit logic is completely separate from business logic
- Can reconstruct detailed before/after diffs from change stream data
- Scales well - change streams are MongoDB's recommended pattern for event processing

**Cons:**

- Eventual consistency - audit logs appear slightly after the actual operations
- Requires replica set deployment (not available in standalone MongoDB)
- Additional complexity in managing change stream processors
- Lost events if change stream processing fails (though can be resumed)

#### Embedded Audit Trails

**Approach:** Use Slire's "bounded" or "unbounded" trace strategies to maintain operation history directly within each document.

```typescript
// Bounded strategy - limited history with size control
const boundedRepo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId, requestId, service: 'expense-api' },
  options: {
    traceStrategy: 'bounded',
    traceLimit: 100, // Keep last 100 operations per document
    traceKey: '_history',
  },
});

// Unbounded strategy - complete history without limits
const unboundedRepo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId, requestId, service: 'expense-api' },
  options: {
    traceStrategy: 'unbounded', // No traceLimit needed
    traceKey: '_history',
  },
});

// Normal operations automatically build audit history
await unboundedRepo.update(
  expenseId,
  { set: { status: 'approved', approver: 'john.doe' } },
  { mergeTrace: { operation: 'approve-expense', reason: 'manual-review' } }
);

// Document contains embedded audit trail
const expense = await repo.getById(expenseId);
console.log(expense._history);
// [
//   {
//     userId: 'john.doe',
//     requestId: 'req-123',
//     service: 'expense-api',
//     operation: 'approve-expense',
//     reason: 'manual-review',
//     _op: 'update',
//     _at: '2025-01-15T10:30:00Z'
//   },
//   // ... previous operations (up to traceLimit for bounded, unlimited for unbounded)
// ]

// Query documents by audit criteria using native MongoDB query
const recentApprovals = await repo.collection
  .find({
    _auditTrail: {
      $elemMatch: {
        operation: 'approve-expense',
        _at: { $gte: new Date('2025-01-01') },
      },
    },
  })
  .toArray();
```

**Database Support:**

- **MongoDB**: Both strategies supported
  - `bounded`: Uses `$push` with `$slice` for size limits
  - `unbounded`: Uses `$push` without size limits
- **Firestore**: `unbounded` only - `bounded` not supported due to lack of server-side array slicing
  - `unbounded`: Uses `FieldValue.arrayUnion()`

**Pros:**

- Zero external infrastructure - audit history travels with the document
- Immediate consistency - audit trail is always in sync with document state
- Simple querying - can filter documents by audit criteria directly
- No separate audit processing or storage concerns
- Complete history available (unbounded strategy)

**Cons:**

- Document size growth - larger documents impact performance and storage
- Limited history (bounded strategy only) - bounded by `traceLimit`
- Unbounded growth potential (unbounded strategy) - can lead to very large documents
- No global audit view - audit trail is scattered across individual documents
- Harder to implement complex audit analytics across multiple documents
- MongoDB 16MB document size limits apply to unbounded strategy

The following strategies implement audit logging without using Slire's built-in tracing feature, offering different trade-offs for specific use cases:

#### Alternative: Synchronous Audit Collection

**Approach:** Write audit entries directly to a separate collection within the same transaction as the main operation.

```typescript
// Enhanced repository with synchronous audit
function createAuditedExpenseRepo(client: MongoClient, orgId: string) {
  // Note: baseRepo doesn't need tracing configuration since we handle audit separately
  const baseRepo = createExpenseRepo(client, orgId);
  const auditCollection = client.db('auditDb').collection('audit_log');

  return {
    ...baseRepo,
    async update(
      id: string,
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
    ) {
      return client.withSession(async (session) => {
        return session.withTransaction(async () => {
          // Create session-aware repository instance
          const txRepo = baseRepo.withSession(session);

          const before = await txRepo.getById(id);
          await txRepo.update(id, update, options);
          const after = await txRepo.getById(id);

          if (before && after) {
            // Audit insert happens within the same transaction
            await auditCollection.insertOne(
              {
                entityId: id,
                operation: 'update',
                trace: options?.mergeTrace,
                before,
                after,
                timestamp: new Date(),
              },
              { session }
            );
          }
        });
      });
    },
  };
}
```

**Pros:**

- Immediate consistency - audit entries are guaranteed when operations succeed
- Transactional integrity - audit writes succeed or fail with the main operation
- Complete before/after state capture is straightforward

**Cons:**

- Slower write operations due to additional database roundtrips
- Higher risk of operation failure - audit write failures can fail business operations
- More complex implementation for bulk operations
- Increased database load during write operations

#### Alternative: Event-Driven Message Queue

**Approach:** Repository emits events to a message queue system for asynchronous audit processing.

```typescript
// Repository with event emission
function createEventEmittingRepo(
  client: MongoClient,
  orgId: string,
  messageQueue: MessageQueue
) {
  const baseRepo = createExpenseRepo(client, orgId);

  return {
    ...baseRepo,
    async create(entity: CreateInput, options?: { mergeTrace?: any }) {
      const id = await baseRepo.create(entity, options);

      // Emit audit event
      await messageQueue.publish('audit.expense.created', {
        entityId: id,
        trace: options?.mergeTrace || {},
        timestamp: new Date(),
        operation: 'create',
      });

      return id;
    },
    // Similar for update, delete...
  };
}

// Separate audit processor
messageQueue.subscribe('audit.*', async (event) => {
  // Fetch current document to get embedded trace
  const document = await collection.findOne({ id: event.entityId });

  await auditCollection.insertOne({
    ...event,
    fullTrace: document._trace,
    processed: new Date(),
  });
});
```

**Pros:**

- Completely decoupled - audit processing can't impact write operations
- High scalability - can handle high-volume operations with multiple consumers
- Flexible processing - different message types can have different audit handlers
- Reliable delivery with message queue guarantees

**Cons:**

- Additional infrastructure complexity (message queue, consumers)
- Potential message loss depending on queue configuration
- More moving parts to monitor and maintain
- Eventual consistency with possible gaps

#### Alternative: Simple Event Emitter

**Approach:** Repository extends Node.js EventEmitter for lightweight in-process event handling.

```typescript
import { EventEmitter } from 'events';

// Repository with built-in event emission
function createEventEmittingRepo(client: MongoClient, orgId: string) {
  const baseRepo = createExpenseRepo(client, orgId);
  const eventEmitter = new EventEmitter();

  const enhancedRepo = {
    ...baseRepo,
    on: eventEmitter.on.bind(eventEmitter),
    emit: eventEmitter.emit.bind(eventEmitter),

    async create(entity: CreateInput, options?: { mergeTrace?: any }) {
      const id = await baseRepo.create(entity, options);

      // Emit event - fire and forget
      process.nextTick(() => {
        eventEmitter.emit('audit', {
          operation: 'create',
          entityId: id,
          entity,
          trace: options?.mergeTrace,
          timestamp: new Date(),
        });
      });

      return id;
    },

    async update(
      id: string,
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
    ) {
      await baseRepo.update(id, update, options);

      // Emit event
      process.nextTick(() => {
        eventEmitter.emit('audit', {
          operation: 'update',
          entityId: id,
          update,
          trace: options?.mergeTrace,
          timestamp: new Date(),
        });
      });
    },
    // Similar for delete...
  };

  return enhancedRepo;
}

// Usage - users can attach any handlers they want
const repo = createEventEmittingRepo(client, orgId);

// Simple logging
repo.on('audit', (event) => {
  console.log('Audit event:', event);
});

// Write to audit collection
repo.on('audit', async (event) => {
  await auditCollection.insertOne(event);
});

// Send notifications for critical operations
repo.on('audit', async (event) => {
  if (event.operation === 'delete') {
    await notificationService.sendAlert({
      message: `Document ${event.entityId} was deleted`,
      context: event.trace,
    });
  }
});
```

**Pros:**

- Minimal overhead - no external dependencies
- Complete flexibility - users attach whatever handlers they want
- Zero configuration - works out of the box
- Synchronous or asynchronous handling as needed

**Cons:**

- In-process only - doesn't survive application restarts
- No built-in reliability or retry mechanisms
- Memory usage grows with number of listeners
- Events lost if no listeners are attached

#### Alternative: Application-Level Explicit Audit

**Approach:** Handle audit logic explicitly in business logic rather than automatically.

```typescript
// Business service with explicit audit
class ExpenseService {
  constructor(private repo: ExpenseRepo, private auditLog: AuditRepo) {}

  async approveExpense(id: string, approver: User): Promise<void> {
    const before = await this.repo.getById(id);
    if (!before) throw new Error('Expense not found');

    await this.repo.update(
      id,
      { set: { status: 'approved' } },
      {
        mergeTrace: {
          operation: 'approve-expense',
          approver: approver.id,
          reason: 'manual-approval',
        },
      }
    );

    const after = await this.repo.getById(id);

    await this.auditLog.create({
      entityId: id,
      entityType: 'expense',
      operation: 'approve',
      actor: approver.id,
      before: before,
      after: after,
      trace: after?._trace,
      businessContext: {
        approvalReason: 'manual-review-passed',
        workflow: 'standard-approval',
      },
    });
  }
}
```

**Pros:**

- Complete control over audit logic and data structure
- Rich business context can be captured beyond technical changes
- Explicit and visible - audit behavior is clear in the business logic
- Can implement different audit strategies for different operations

**Cons:**

- Easy to forget - no automatic audit trail generation
- Boilerplate code repeated across operations
- Tight coupling between business logic and audit requirements
- Higher risk of inconsistent audit practices across the codebase

## FAQ

Why implementations for MongoDB and Firestore?

remarks about other features...

contribution: how can I express that this is for now a solo project?

## Roadmap

PostgreSQL, DocumentDB

better merge into FAQ?

## License

todo