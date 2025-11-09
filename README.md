# Slire

- [Install](#install)
- [Quickstart](#quickstart)
- [API Overview](#api-overview)
- [Configuration](#configuration)
- [Database Differences](#database-differences)
  - [MongoDB](#mongodb)
  - [Firestore](#firestore)
- [Transactions](#transactions)
- [Pagination](#pagination)
- [Tracing and Audit Overview](#tracing-and-audit-overview)
- [Recommended Usage Patterns](#recommended-usage-patterns)
- [Limitations and Caveats](#limitations-and-caveats)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [License](#license)
- [Why Slire?](docs/WHY.md)

---

Slire is a minimal, database‑agnostic repository layer that adds the consistency features most teams rewrite over and over — scope, timestamps, versioning, soft delete, and tracing — while keeping native drivers front and center. Use Slire when you want less boilerplate and safer CRUD, and keep using native drivers for anything advanced.

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

A Slire repository is instantiated with a configuration that defines which fields are managed automatically (id, timestamps, version, trace) and which scope to apply. Scope is a fixed filter that enforces tenancy/data partitioning across all operations. For MongoDB, scope is merged into reads and writes; for Firestore, scope is validated on writes and typically enforced by path‑scoped collections. Managed fields are read‑only for updates and validated or ignored on create.

MongoDB

```typescript
import { MongoClient } from 'mongodb';
import { createMongoRepo } from 'slire';

type Expense = { id: string; organizationId: string; total: number; _createdAt?: Date };

const client = new MongoClient(process.env.MONGO_URI!);
const expenses = client.db('app').collection<Expense>('expenses');

const repo = createMongoRepo<Expense>({
  collection: expenses,
  mongoClient: client,
  scope: { organizationId: 'acme-123' },
  options: { softDelete: true, traceTimestamps: true, version: true },
});
```

Firestore

```typescript
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreRepo } from 'slire';

type User = { id: string; organizationId: string; name: string; _createdAt?: Date };

const db = new Firestore();
const collection = db.collection('organizations/acme-123/users') as any;

const repo = createFirestoreRepo<User>({
  collection,
  firestore: db,
  scope: { organizationId: 'acme-123' }, // validated on writes only
  options: { softDelete: true, traceTimestamps: 'server', version: true },
});
```

Reads support projections (`{ field: true }`) and return a single‑use `QueryStream` you can iterate or convert with `.toArray()`.

```typescript
// Create
const id = await repo.create({ total: 10 } as any);

// Read single with projection
const justId = await repo.getById(id, { id: true }); // -> { id: string } | undefined

// Stream reads (single-use)
for await (const e of repo.find({})) {
  // process entity
}
const list = await repo.find({}).skip(5).take(10).toArray();

// Update and delete
await repo.update(id, { set: { total: 42 } });
await repo.delete(id);
```

## API Overview

- **CRUD**: `getById`, `getByIds`, `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`
- **Query**: `find`, `findBySpec`, `findPage`, `findPageBySpec`, `count`, `countBySpec`
- **Transactions**:
  - MongoDB: `withSession(session)`, `runTransaction(cb)`
  - Firestore: `withTransaction(tx)`, `runTransaction(cb)`
- **Helpers** (advanced/native use):
  - `collection` (native handle)
  - `applyConstraints(...)` (adds scope, soft-delete filtering)
  - `buildUpdateOperation(update, mergeTrace?)` (applies timestamps/version/trace; protects readonly fields)

For in-depth details, see the sections below (MongoDB/Firestore implementations and the full API reference).

## Configuration

Key options (shared unless noted):

- **Identity**
  - `generateId?: 'server' | (() => string)` — default `'server'` (Mongo ObjectId / Firestore doc id)
  - `idKey?: keyof T` — default `'id'`
  - `mirrorId?: boolean` — persist public id in documents (off by default)
- **Consistency**
  - `softDelete?: boolean` — enable soft delete
  - `traceTimestamps?: true | 'server' | (() => Date)` — timestamp source
  - `timestampKeys?: { createdAt?; updatedAt?; deletedAt? }` — custom keys imply timestamping
  - `version?: true | keyof T` — versioning field (default `_version`)
- **Tracing**
  - `traceKey?: keyof T` — default `_trace`
  - `traceStrategy?: 'latest' | 'bounded' | 'unbounded'`
    - Firestore: `'bounded'` not supported (throws)
  - `traceLimit?: number` — required for `'bounded'`

## Database Differences

### MongoDB

- **Soft delete**: filters on “marker does not exist”; deletes set the marker.
- **Pagination**: cursor is `_id` (ObjectId string) and `_id` is always a tiebreaker; compound sorts supported with a cursor filter.
- **Updates**: query-based (`updateMany`); large inputs chunked to respect driver limits.
- **Tracing**: all strategies supported; server timestamps via `$currentDate` when configured.

### Firestore

- **Soft delete**: documents created with `_deleted: false`, reads filter `_deleted == false`.
- **Pagination**: cursor is document id; sort requires `__name__` tiebreaker.
- **Updates**: batched writes; multi-document updates chunked (`IN` limits).
- **Tracing**: supports `'latest'` and `'unbounded'` (throws on `'bounded'`).
- **Transactions**: reads must occur before writes; repository methods that read inside must be called in the read phase.

## Transactions

MongoDB

```typescript
await repo.runTransaction(async (tx) => {
  const items = await tx.find({ status: 'active' }, { id: true }).toArray();
  await tx.updateMany(items.map(i => i.id), { set: { processed: true } });
});
```

Firestore

```typescript
await repo.runTransaction(async (tx) => {
  const page = await tx.findPage({ status: 'active' }, { limit: 20 });
  await tx.updateMany(page.items.map(i => i.id), { set: { processed: true } });
});
```

## Pagination

- Use `findPage` for cursor-based pagination (stable regardless of depth).
- MongoDB: ensure compound indexes when using custom `orderBy` (append `_id`).
- Firestore: always includes `__name__` tiebreaker; cursor must reference an existing doc.

## Tracing and Audit Overview

- Per-repo `traceContext` and per-operation `{ mergeTrace }` are merged; `_op` and `_at` added automatically.
- Strategies:
  - `'latest'` — single object
  - `'bounded'` — array with max size (MongoDB only)
  - `'unbounded'` — append-only array (MongoDB and Firestore)
- Patterns:
  - Change streams (MongoDB) for asynchronous audit pipelines
  - Embedded audit trails for immediate, self-contained history

## What the Heck is Slire?

Slire is a lightweight, database-agnostic interface that provides common CRUD operations with built-in consistency features, designed to work seamlessly alongside native database access. It currently supports MongoDB and Firestore implementations.

**Consistency features** are patterns that most applications need but typically implement inconsistently: automatic timestamps (createdAt, updatedAt), versioning for optimistic locking, soft-delete functionality, and audit trails. Rather than manually adding these to every operation, Slire applies them automatically while still allowing native database access for complex queries and operations.

Slire emerged from practical production needs moving between ODM‑style convenience and pure native database access across Firestore and MongoDB. Both approaches have pros and cons: ODMs provide convenience but limit functionality, while native access offers full power but requires repetitive boilerplate. Slire occupies a middle ground: more convenience than pure native drivers, but significantly less abstraction than traditional ORMs. It's designed for teams who understand their database technology and want to use it effectively without losing access to advanced features.

For a deeper understanding of the problems this approach solves, see [docs/WHY.md](docs/WHY.md).

## A Quick Glimpse

Slire implements the repository pattern: a collection-like interface for accessing and manipulating domain objects. Each repository is bound to a specific database collection and organizational scope, providing type-safe CRUD operations that reduce boilerplate while working seamlessly alongside native database access for complex operations.

Creating a repository instance:

```typescript
const expenseRepo = createMongoRepo({
  collection: mongoClient.db('expenseDb').collection<Expense>('expenses'),
  mongoClient,
  scope: { organizationId: 'acme-123' }, // applied to all reads and writes
});

// better to have a factory enforcing constraints and encapsulating db/collection names
function createExpenseRepo(client: MongoClient, organizationId: string) {
  return createMongoRepo({
    collection: client.db('expenseDb').collection<Expense>('expenses'),
    mongoClient: client,
    scope: { organizationId },
  });
}
```

A Slire repository implements a set of basic, DB-agnostic CRUD operations:

```typescript
const repo = createExpenseRepo(mongoClient, 'acme-123');

const id = await repo.create(expenseFromImport());

await repo.update(id, { set: { totalClaim: 42 }, unset: 'attachments' });

await repo.delete(id);

await repo.getById(id); // undefined
```

The full list is documented in the [API Reference](#api-reference-core-crud-operations-slire-interface) section.

Here's how [transactions](#runtransaction) work:

```typescript
await repo.runTransaction(async (tx) => {
  // tx is a transaction-session-aware repository instance
  // providing exactly the same functionality as the outer repo
  // except that all its operations happen in a transaction

  // a simple query with projection
  const johns = await tx.find({ userId: 'john-doe' }, { id: true }); // result is of type { id: string }[]

  // update based on what we just read
  await tx.updateMany(
    johns.map((j) => j.id),
    { set: { country: someCondition(johns) ? 'US' : 'UK' } }
  );
});
```

This can be written more verbosely like this (revealing how `runTransaction` is implemented):

```typescript
await mongoClient.withSession(async (session) => {
  await session.withTransaction(async () => {
    const tx = repo.withSession(session); // a new transaction-aware repo instance

    const johns = await tx.find({ userId: 'john-doe' }, { id: true });

    await tx.updateMany(
      johns.map((j) => j.id),
      { set: { country: someCondition(johns) ? 'US' : 'UK' } }
    );
  });
});
```

This approach obviously also allows you to have transactions that span multiple repositories - just create session-aware instances from different MongoDB repositories using the same session and all their operations will participate in the same transaction.

Finally, for the end of this quick tour, let's look at how Slire steps aside
when we have to deal with more advanced operations that we cannot reasonably represent in
a DB-agnostic interface. For demonstration purposes let's imagine a fictional "client-side stored procedure"
that determines the top expenses per category given an organization and currency:

```typescript
export async function markTopExpenses({
  mongoClient,
  organizationId,
  currency,
}: {
  mongoClient: MongoClient;
  organizationId: string;
  currency: string;
}): Promise<void> {
  const TOP_MARKER = 'customInformation.top';
  const repo = createExpenseRepo(mongoClient, organizationId);

  await mongoClient.withSession(async (session) => {
    await session.withTransaction(async () => {
      // remove marker from all current top expenses
      await repo.collection.updateMany(
        // -> a repo instance exposes the underlying collection
        repo.applyConstraints({ currency, [TOP_MARKER]: true }), // -> applyConstraints ensures org scope
        repo.buildUpdateOperation({ unset: { [TOP_MARKER]: 1 } }), // -> applies timestamps etc. if configured
        { session }
      );

      // determine new top expenses
      const topExpenses = await repo.collection
        .aggregate<{ expenseId: string }>(
          [
            { $match: repo.applyConstraints({ currency }) }, // -> applyConstraints ensures org scope and excludes soft-deleted
            { $sort: { category: 1, totalClaim: -1 } },
            { $group: { _id: '$categoryId', expenseId: { $first: '$_id' } } },
          ],
          { session }
        )
        .toArray();

      // set the marker for the new top expenses
      await repo.collection.bulkWrite(
        topExpenses.map((e) => ({
          updateOne: {
            filter: repo.applyConstraints({ _id: e.expenseId }), // -> again, ensure org scope
            update: repo.buildUpdateOperation({ set: { [TOP_MARKER]: true } }), // -> applies timestamps etc. if configured
          },
        })),
        { session }
      );
    });
  });
}
```

Noteworthy here is that for this kind of custom data access, DB and collection names stay hidden as well as how a scope
translates to a filter for reads and writes.

Due to their DB-specific nature, the repository functions supporting native operations are not part of the DB-agnostic Slire
interface. A future Firestore implementation may provide such helpers in a different fashion.
Hiding scope filters may seem trivial and not worth the effort of encapsulating them in the repository instance. The value
of this encapsulation will hopefully become more apparent when we look at [consistency features](#options) that no one really likes to reimplement
again and again.

You may have noticed that Slire's CRUD operations borrow a lot from MongoDB's client API (for example,
updates with set/unset, variants with bulk support, filter syntax).
This is no coincidence as the MongoDB API is considered very clean in that regard, and should also work well with other DB implementations.

!! consider moving somewhere else
Finally, if you've been using `DocumentService` for most of your data access, you might wonder what a migration path to Slire would look like. You're probably thinking it's quite an effort since you've injected `DocumentService` instances all over the place and the interfaces aren't compatible. That's correct, and the "Recommended Usage Patterns" section explains why we think that injecting repository instances everywhere isn't a good idea in the first place.

## API Reference Core CRUD Operations (Slire interface)

The operations listed here resemble the full set of DB-agnostic functions in Slire. At time of writing only the MongoDB implementation existed. So some descriptions might mention some characteristics specific to MongoDB. However, the interface is designed to
be as simple as possible to allow being implemented for other DBs, particularly Firestore.

**Note 1**: In the function signatures below, `T` represents the entity type, `UpdateInput` represents the subset of `T` that can be modified via updates (excluding managed fields), and `CreateInput` represents the input shape for creating entities (includes optional managed fields). Managed fields include system fields (id, timestamps, version, soft-delete markers) and scope fields.

**Note 2**: All read functions support projections. A projection is given in the form `{ propA: true, propB: true }` where `propA` and `propB` are valid properties in `T`. A projection is properly reflected in the return type.

!! TODO - rephrase / clarify
**Note 3**: Scope filtering and other consistence features are not part of this interface as they are basically repository options that get only mentioned during instantiation. However, they might be mentioned in the function descriptions describing the intended behavior as part of the interface contract any implemention must adhere to.

#### Input Type Distinction

Slire uses distinct input types for different operations to provide compile-time safety:

- **`UpdateInput`**: Used for update operations - excludes all managed fields (system fields like timestamps/version/id, plus scope fields). This prevents accidental modification of fields that should be repository-controlled.
- **`CreateInput`**: Used for create/upsert operations - includes all `UpdateInput` fields plus optional managed fields. The managed fields are allowed purely as a convenience feature so you don't have to manually strip them from objects. System fields (timestamps, version, id) are ignored internally and auto-generated. Scope fields are validated to match the repository's configured scope values - mismatches cause the operation to fail.

The relationship: `CreateInput = UpdateInput & Partial<ManagedFields>`. This design ensures updates are strict while creation validates managed fields for correctness (scope fields must match, system fields are ignored) for developer convenience.

**Example:**

```typescript
type User = {
  id: string;
  organizationId: string; // scope field
  name: string;
  email: string;
  _createdAt?: Date;
  _updatedAt?: Date;
};

// With scope { organizationId: 'acme-123' } and timestamps enabled:
// UpdateInput = { name: string; email: string }
// CreateInput = { name: string; email: string; id?: string; organizationId?: string; _createdAt?: Date; _updatedAt?: Date }

// ✅ Valid update - only user data
await repo.update(id, { set: { name: 'John' } });

// ❌ Compile error - can't update managed fields (timestamps)
await repo.update(id, { set: { _createdAt: new Date() } });

// ❌ Compile error - can't update managed fields (scope)
await repo.update(id, { set: { organizationId: 'other-org' } });

// ✅ Valid create - managed fields optional
await repo.create({ name: 'John', email: 'john@example.com' });

// ✅ Valid create - matching scope field ignored, others auto-generated
await repo.create({
  id: 'will-be-ignored',
  organizationId: 'acme-123', // matches repo scope - allowed but ignored
  name: 'John',
  email: 'john@example.com',
  _createdAt: new Date(), // ignored - repo generates its own
});

// ❌ Runtime error - scope field doesn't match repository configuration
await repo.create({
  name: 'John',
  email: 'john@example.com',
  organizationId: 'other-org', // doesn't match scope 'acme-123' - operation fails
});
```

### getById

`getById(id: string): Promise<T | undefined>`

`getById<P extends Projection<T>>(id: string, projection: P): Promise<Projected<T, P> | undefined>`

Retrieves a single entity by its ID, automatically applying the repository's scope filter. Returns `undefined` if no entity is found with the given ID or if the entity exists but doesn't match the scope (e.g., wrong organization). When using the projection variant, only the specified fields are returned and the result is properly typed to reflect the projection.

### getByIds

`getByIds(ids: string[]): Promise<[T[], string[]]>`

`getByIds<P extends Projection<T>>(ids: string[], projection: P): Promise<[Projected<T, P>[], string[]]>`

Bulk version of `getById` that retrieves multiple entities by their IDs. Returns a tuple containing two arrays: the first contains all found entities, the second contains the IDs that were not found (either because they don't exist or don't match the scope). The order of found entities is not guaranteed to match the input order. When using the projection variant, only the specified fields are returned for each entity.

### create

`create(entity: CreateInput, options?: { mergeTrace?: any }): Promise<string>`

Creates a new entity in the repository. Returns the generated ID for the created entity. The repository automatically generates a unique ID, applies configured scope values, and generates all system-managed fields (timestamps, version, trace context if enabled). While `CreateInput` allows managed fields to be present in the input for convenience, system fields are ignored and scope fields are validated - the operation fails if provided scope values don't match the repository's configured scope. The optional `mergeTrace` parameter allows adding operation-specific trace context that gets merged with the repository's base trace context.

Note: This method delegates to `createMany` internally and can therefore throw `CreateManyPartialFailure` under the same conditions (for a single-entity batch, see below).

### createMany

`createMany(entities: CreateInput[], options?: { mergeTrace?: any }): Promise<string[]>`

Bulk version of `create` that creates multiple entities in a single operation. Returns an array of generated IDs corresponding to the created entities. The order of returned IDs matches the order of input entities. All entities are subject to the same automatic ID generation, scope validation, and consistency feature handling (including trace context if enabled) as the single `create` function. The optional `mergeTrace` parameter allows adding operation-specific trace context that gets merged with the repository's base trace context and applied to all entities in the batch.

Error handling and partial writes: The function performs a bulk upsert using `$setOnInsert` so existing documents are never silently updated. It generates IDs up front and, on success, returns them in the same order as the input entities. For large inputs, the operation runs in chunks to respect MongoDB limits. If a chunk cannot be fully inserted (for example, due to a duplicate key), the function throws `CreateManyPartialFailure`. This error reports the public IDs that were inserted up to the failure point (including prior chunks and the inserted subset of the failing chunk) and the public IDs that were not inserted (the non-inserted subset of the failing chunk plus all subsequent chunks that are skipped). This makes partial results explicit and allows callers to reconcile state or retry as needed. If you need atomicity, wrap the call in a transaction with `runTransaction`.

### update

`update(id: string, update: UpdateOperation<UpdateInput>, options?: { mergeTrace?: any }): Promise<void>`

Updates a single entity identified by its ID. The update operation supports both `set` (to update fields) and `unset` (to remove optional fields) operations, which can be used individually or combined. The `unset` field accepts either a single optional property path (as a string) or an array of paths. You can also specify nested fields via dot notation (e.g., `address.street`). The repository excludes soft-deleted entities by default to ensure only active entities are updated. Note that managed fields (scope properties, system fields like timestamps/version/id/trace) cannot be modified through updates - the `UpdateOperation<UpdateInput>` type excludes these fields, ensuring type safety at compile time. Implementations should also perform runtime checks to ensure that managed fields are not tampered with. Any configured timestamps (like `updatedAt`), versioning increments, and trace context are applied automatically. The optional `mergeTrace` parameter allows adding operation-specific trace context. No error is thrown if the entity doesn't exist or doesn't match the scope.

Example with nested unsets (dot paths):

```ts
// Single string unset
await repo.update(id, {
  set: { status: 'processed' },
  unset: 'optionalTopLevelField',
});

// Array unset (multiple properties)
await repo.update(id, {
  set: { status: 'processed' },
  unset: ['optionalTopLevelField', 'address.street', 'metadata.tags'],
});
```

### updateMany

`updateMany(ids: string[], update: UpdateOperation<UpdateInput>, options?: { mergeTrace?: any }): Promise<void>`

Bulk version of `update` that applies the same update operation to multiple entities identified by their IDs. All entities are subject to soft-delete exclusion by default. Timestamp updates and versioning behavior are identical to the single `update` function. The operation succeeds even if some of the provided IDs don't exist - only valid, active entities will be updated.

For large inputs, the operation may run in chunks to respect MongoDB limits and is not atomic across chunks. If you need all-or-nothing behavior across many IDs, wrap the call in a transaction using `runTransaction`.

This method is not all-or-nothing. Some entities may be updated, and others may fail due to unique constraints or scope rules. For atomicity across entities, wrap the call in a transaction using `runTransaction`.

Note that `upsert` and `upsertMany` are intentionally not provided to keep the API simple.

### delete

`delete(id: string): Promise<void>`

Deletes a single entity identified by its ID. The repository applies scope filtering to ensure only entities within the current scope can be deleted. If the repository is configured with soft delete, the entity is marked with a deletion flag (default is `_deleted`) rather than being physically removed. If timestamping is also enabled, a `deletedAt` timestamp is added as well. If hard delete is configured, the entity is permanently removed from the database. No error is thrown if the entity doesn't exist or doesn't match the scope.

### deleteMany

`deleteMany(ids: string[]): Promise<void>`

Bulk version of `delete` that removes multiple entities identified by their IDs. All entities are subject to the same scope filtering and soft/hard delete behavior as the single `delete` function. The operation succeeds even if some of the provided IDs don't exist or don't match the scope - only the valid, in-scope entities will be deleted.

For large inputs, the operation may run in chunks and is not atomic across chunks. If you need all-or-nothing behavior, run the deletion inside a transaction with `runTransaction`.

### find

`find(filter: Partial<T>, options?: FindOptions): QueryStream<T>`

`find<P extends Projection<T>>(filter: Partial<T>, options: FindOptions & { projection: P }): QueryStream<Projected<T, P>>`

Queries entities and returns a streaming result that provides both array and iterator access. The filter uses a subset of the entity properties to match against. The repository automatically applies scope filtering in addition to the user-provided filter. If the filter breaches the configured scope, behavior is controlled by `onScopeBreach` (default `'empty'` → return empty stream; `'error'` → throw). If soft delete is enabled, soft-deleted entities are automatically excluded from results.

The `FindOptions` parameter supports:

- `onScopeBreach?: 'empty' | 'error'` - Handle scope breaches
- `orderBy?: Record<string, 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'>` - Sort results (dot notation supported for nested properties)

**Usage Examples:**

```typescript
// Stream processing
for await (const user of repo.find({ status: 'active' })) {
  console.log(user.name);
}

// Convert to array
const users = await repo.find({ status: 'active' }).toArray();

// Chain operations
const result = await repo.find({ status: 'active' }).skip(10).take(5).toArray();

// With ordering (supports dot notation for nested fields)
const orderedUsers = await repo
  .find({}, { orderBy: { name: 'asc', 'profile.age': 'desc' } })
  .toArray();
```

**Important: QueryStream is single-use**

QueryStream instances are designed for single consumption. Once you start iterating (via `toArray()`, `for await`, or directly accessing the iterator), the stream is marked as consumed and cannot be reused:

```typescript
const stream = repo.find({ status: 'active' });

// First consumption - works fine
const results1 = await stream.toArray();

// Second consumption - throws error
const results2 = await stream.toArray(); // Error: QueryStream has already been consumed

// Chaining after consumption - also throws error
const limited = stream.take(10); // Error: Cannot chain operations on already-consumed QueryStream
```

To use the same query multiple times, call `find()` again to get a fresh stream. Chaining operations (like `take()`, `skip()`, `paged()`) is allowed before consumption starts, and each derived stream is independent:

```typescript
// Valid: chain before consumption
const stream = repo.find({ status: 'active' });
const result = await stream.skip(10).take(5).toArray(); // Works fine

// Valid: multiple derived streams from same base (before base is consumed)
const base = repo.find({});
const first10 = base.take(10);
const after10 = base.skip(10);
await first10.toArray(); // Works
await after10.toArray(); // Also works
```

### findBySpec

`findBySpec<S extends Specification<T>>(spec: S, options?: FindOptions): QueryStream<T>`

`findBySpec<S extends Specification<T>, P extends Projection<T>>(spec: S, options: FindOptions & { projection: P }): QueryStream<Projected<T, P>>`

Queries entities using a specification object that encapsulates filter criteria and business rules. The repository automatically applies scope filtering and soft delete exclusion just like `find`. Specifications provide composable, reusable query logic that can be combined using `combineSpecs`. The `FindOptions` parameter supports the same options as `find` including `orderBy` for sorting. See [Query Abstraction Patterns](#query-abstraction-patterns) for detailed examples and patterns.

### findPage

`findPage(filter: Partial<T>, options: FindPageOptions): Promise<PageResult<T>>`

`findPage<P extends Projection<T>>(filter: Partial<T>, options: FindPageOptions & { projection: P }): Promise<PageResult<Projected<T, P>>>`

Provides efficient cursor-based pagination for large datasets. Unlike `find().skip().take()` which becomes slower with larger offsets, `findPage` uses database-native cursors for consistent performance regardless of page depth.

The `FindPageOptions` parameter includes:

- `limit: number` - Maximum number of items per page (required)
- `cursor?: string` - Cursor from previous page's `nextCursor` (optional)
- `orderBy?: Record<string, 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'>` - Sort order (dot notation supported)
- `onScopeBreach?: 'empty' | 'error'` - Handle scope breaches (default: 'empty')

Returns `PageResult<T>` containing:

- `items: T[]` - The page of results (up to `limit` items)
- `nextCursor: string | undefined` - Cursor for next page (undefined when no more results)

**Usage Examples:**

```typescript
// First page
const page1 = await repo.findPage(
  { status: 'active' },
  { limit: 20, orderBy: { createdAt: 'desc' } }
);

// Subsequent pages using cursor
let currentPage = page1;
while (currentPage.nextCursor) {
  currentPage = await repo.findPage(
    { status: 'active' },
    {
      limit: 20,
      orderBy: { createdAt: 'desc' },
      cursor: currentPage.nextCursor,
    }
  );
  // Process currentPage.items
}

// With projection
const page = await repo.findPage(
  { isActive: true },
  {
    limit: 10,
    projection: { id: true, name: true },
    orderBy: { name: 'asc' },
  }
);
```

**Performance Considerations:**

- **Cursor-based pagination** avoids the performance penalty of `skip()` for large offsets, providing consistent O(1) navigation performance
- **Cursor format**: For MongoDB it's the document `_id` (ObjectId string), for Firestore it's the document ID
- **Cursor validity**: Cursors remain valid as long as the referenced document exists. If deleted, `findPage` throws an error
- **Custom ordering with cursors**: When using custom `orderBy`, the implementation builds a compound filter that respects both the sort fields and the cursor position, ensuring correct pagination even with non-unique sort values
- **Index requirements for MongoDB**: For optimal performance with custom `orderBy`, create a compound index on your sort fields plus `_id` as the final field:

  ```javascript
  // Example: Sorting by { age: 'desc', name: 'asc' }
  db.collection.createIndex({ age: -1, name: 1, _id: 1 });

  // Multi-field sort with filters
  db.collection.createIndex({ status: 1, createdAt: -1, _id: 1 });
  ```

- **Null handling**: MongoDB sorts null/undefined values before other values in ascending order, after other values in descending order. The cursor implementation correctly handles these edge cases
- **Default ordering**: If no `orderBy` is specified, results are sorted by `_id` (MongoDB) or `__name__` (Firestore) ascending for deterministic pagination
- **Always use \_id as tiebreaker**: The implementation automatically adds `_id` to the sort order if not present, ensuring unique, stable ordering even when sort field values are not unique

**When to Use:**

- **Use `findPage`** for UI pagination, API endpoints with page tokens, or iterating through large datasets across multiple requests
- **Use `find().skip().take()`** for small result sets, client-side streaming, or when you need the full QueryStream interface

### findPageBySpec

`findPageBySpec<S extends Specification<T>>(spec: S, options: FindPageOptions): Promise<PageResult<T>>`

`findPageBySpec<S extends Specification<T>, P extends Projection<T>>(spec: S, options: FindPageOptions & { projection: P }): Promise<PageResult<Projected<T, P>>>`

Provides cursor-based pagination using specification objects for query criteria. Works identically to `findPage` but accepts a `Specification<T>` instead of a filter object, enabling reusable, composable query logic. See [Query Abstraction Patterns](#query-abstraction-patterns) for detailed examples of the specification pattern.

**Usage Example:**

```typescript
const activeUsersSpec: Specification<User> = {
  toFilter: () => ({ isActive: true }),
  describe: 'active users',
};

// First page
const page1 = await repo.findPageBySpec(activeUsersSpec, {
  limit: 20,
  orderBy: { createdAt: 'desc' },
});

// Subsequent pages
const page2 = await repo.findPageBySpec(activeUsersSpec, {
  limit: 20,
  orderBy: { createdAt: 'desc' },
  cursor: page1.nextCursor,
});
```

### count

`count(filter: Partial<T>, options?: { onScopeBreach?: 'zero' | 'error' }): Promise<number>`

Returns the number of entities that match the provided filter criteria. Like `find`, the repository automatically applies scope filtering in addition to the user-provided filter, and soft-deleted entities are automatically excluded from the count if soft delete is enabled. Returns 0 if no matching entities are found.

### countBySpec

`countBySpec<S extends Specification<T>>(spec: S, options?: { onScopeBreach?: 'zero' | 'error' }): Promise<number>`

Returns the number of entities that match the provided specification. Like `count`, the repository automatically applies scope filtering and soft delete exclusion. This method works with the same specification objects used by `findBySpec`, enabling consistent query logic across find and count operations. Returns 0 if no matching entities are found.

## MongoDB Implementation

The MongoDB implementation provides additional functionality beyond the core Slire interface. This includes the factory function for creating repositories, transaction support methods, and helper functions that enable direct MongoDB operations while maintaining the repository's consistency rules and scoping behavior. These MongoDB-specific features are essential for advanced use cases where the generic interface isn't sufficient, but you still want the benefits of automatic scope filtering, timestamps, and other repository features.

### createMongoRepo

`createMongoRepo({ collection, mongoClient, scope?, traceContext?, options? }): MongoRepo<T, Scope, Entity>`

Factory function that creates a MongoDB repository instance implementing the Slire interface. Takes a MongoDB collection, client, optional scope for filtering, optional trace context for audit logging, and configuration options for consistency features like timestamps, versioning, soft delete, and tracing. The function uses TypeScript generics to ensure type safety across all repository operations. The returned repository instance provides both the DB-agnostic Slire interface and additional MongoDB-specific helpers (described in the following sections) for advanced operations.

#### Scope

The `scope` parameter defines filtering criteria that are automatically applied to all repository operations. For example, passing `{ organizationId: 'acme-123' }` ensures that all reads and deletes only affect entities belonging to that organization. The scope is merged with user-provided filters and becomes part of every database operation, providing automatic multi-tenancy or data partitioning without requiring explicit filtering in each method call.

**Scope Property Handling by Operation:**

Scope fields are treated as managed fields and are automatically controlled by the repository:

- **Create/Upsert**: Scope properties can be included in entities for convenience but are validated - the operation fails if provided scope values don't match the repository's configured scope. The repository always applies its own configured scope values regardless of input.
- **Updates**: Scope properties are excluded from `UpdateInput` type and cannot be modified (compile-time and runtime protection)
- **Reads/Deletes**: Automatically filtered by scope values

```typescript
const repo = createMongoRepo({
  collection: userCollection,
  mongoClient,
  scope: { organizationId: 'acme-123', isActive: true },
});

// ✅ Create: scope properties allowed and validated
await repo.create({
  name: 'John Doe',
  organizationId: 'acme-123', // matches scope ✓
  isActive: true, // matches scope ✓
});

// ❌ Create: scope validation fails
await repo.create({
  name: 'Jane Doe',
  organizationId: 'different', // doesn't match scope - throws error
  isActive: true,
});

// ✅ Update: scope properties excluded from updates
await repo.update(userId, {
  set: { name: 'Updated Name' }, // OK - non-scope property
});

// ❌ Update: scope properties cannot be updated (compile-time error)
await repo.update(userId, {
  set: { organizationId: 'new-org' }, // TypeScript error + runtime error
});
```

#### Trace Context

The `traceContext` parameter enables automatic audit trail functionality by attaching trace information to all write operations. When provided, the repository automatically embeds this context into documents during create, update, and soft delete operations, providing a foundation for operational debugging and audit logs.

The trace context is completely flexible - define whatever fields are meaningful for your debugging and audit needs:

```typescript
// Basic trace context
const repo = createMongoRepo({
  collection: expenseCollection,
  mongoClient,
  traceContext: { userId: 'john-doe', requestId: 'req-abc-123' },
});

await repo.create(expense);
// Document includes: { ..., _trace: { userId: 'john-doe', requestId: 'req-abc-123', _op: 'create', _at: Date } }
```

**Operation-Level Trace Merging:**

All write operations support merging additional trace context via the `mergeTrace` option. Per-operation tracing works even if no base `traceContext` was provided at repository creation time. In that case, the operation’s `mergeTrace` alone enables tracing for that write.

```typescript
await repo.update(
  expenseId,
  { set: { status: 'approved' } },
  { mergeTrace: { operation: 'approve-expense', approver: 'jane-doe' } }
);
// Results in (with base traceContext):
// { userId: 'john-doe', requestId: 'req-abc-123', operation: 'approve-expense', approver: 'jane-doe', _op: 'update', _at: Date }

// Works without base traceContext as well:
const repoNoBase = createMongoRepo({ collection, mongoClient });
await repoNoBase.create(expense, { mergeTrace: { operation: 'import-csv' } });
// Document includes: { ..., _trace: { operation: 'import-csv', _op: 'create', _at: Date } }
```

**Automatic Metadata:**

The repository automatically adds operation metadata:

- `_op`: The operation type ('create', 'update', 'delete')
- `_at`: Timestamp when the trace was written

See [Audit Trail Strategies with Tracing](#audit-trail-strategies-with-tracing) for comprehensive examples of building audit systems using trace context.

#### Options

The `options` parameter configures consistency features and repository behavior:

**`generateId?: 'server' | (() => string)`** - Controls how datastore IDs are generated.

- `'server'` (default): use MongoDB-native ObjectIds. IDs are allocated client-side (new ObjectId()) for stability during `createMany` and returned as strings by the repo.
- `() => string`: provide a custom generator (e.g., uuid, domain-specific). The generated string is used as the datastore `_id`.

**`idKey?: StringKeys<T>`** - Public entity property name that exposes the ID, default `'id'`. The repo always returns entities with this property populated from the datastore `_id` (converted to string). This key is treated as readonly for updates.

**`mirrorId?: boolean`** - Default `false`. When `true`, the repo also persists the ID as a normal field in the document under `idKey`. When `false`, `idKey` is computed on reads but not stored in the document.

**`softDelete?: boolean`** - Enables soft delete functionality. When `true`, delete operations mark entities with a `_deleted` flag instead of physically removing them from the database. Soft-deleted entities are automatically excluded from all read operations (`find`, `getById`, `count`). Defaults to `false` (hard delete).

**`traceTimestamps?: true | 'server' | (() => Date)`** - Configures automatic timestamping behavior. When `true`, uses application time (JavaScript `Date`). When `'server'`, uses the datastore/server timestamp. When a function is provided, that function is called to generate timestamps (this can come in handy for integration tests). The timestamps are applied as follows: `createdAt` is set during `create`, `createMany` operations and when `upsert`/`upsertMany` creates new entities; `updatedAt` is set on all write operations (`create`, `createMany`, `update`, `updateMany`, `upsert`, `upsertMany`, `delete`, `deleteMany`); `deletedAt` is set during soft delete operations when `softDelete` is enabled.

**`timestampKeys?: TimestampConfig<T>`** - Customizes timestamp field names. By default, uses `_createdAt`, `_updatedAt`, and `_deletedAt`. Provide an object like `{ createdAt: 'dateCreated', updatedAt: 'dateModified' }` to use custom field names that match your entity schema. You don't need to specify all keys - any unspecified keys will fall back to their default names. Note that the `deletedAt` key is only used when soft delete is enabled. When this option is provided, `traceTimestamps` is implicitly set to `true`, so there's no need to specify both options.

**`version?: VersionConfig`** - Enables optimistic versioning. When `true`, uses the default `_version` field that increments on each update. Alternatively, provide a custom numeric field name from your entity type. Version increments happen automatically on all update operations, helping detect concurrent modifications.

**`traceKey?: string`** - Customizes the field name used to store trace context in documents. Defaults to `_trace`. Use this to match your entity schema or avoid conflicts with existing fields. When using the default field name, it's automatically hidden from read results unless explicitly configured as an entity property.

**`traceStrategy?: 'latest' | 'bounded' | 'unbounded'`** - Controls how trace information is stored. Defaults to `'latest'`.

- **latest (default)**: Stores only the most recent trace context, overwriting previous traces with each operation
- **bounded**: Maintains an array of recent traces with size limits, useful for tracking operation sequences on the same document
- **unbounded**: Maintains an unlimited array of all traces, providing complete operation history (use with caution due to potential document size growth)

**`traceLimit?: number`** - Maximum number of traces to retain when using `'bounded'` strategy. Required when `traceStrategy` is `'bounded'`. Not used with `'latest'` or `'unbounded'` strategies. The repository automatically manages the array size, keeping only the most recent traces.

```typescript
// Latest strategy (default)
const repo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId: 'john' },
  // Document: { ..., _trace: { userId: 'john', _op: 'update', _at: Date } }
});

// Bounded strategy with history
const auditRepo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId: 'john' },
  options: {
    traceStrategy: 'bounded',
    traceLimit: 5,
  },
  // Document: { ..., _trace: [{ userId: 'john', _op: 'create', _at: Date1 }, { userId: 'jane', _op: 'update', _at: Date2 }] }
});

// Unbounded strategy with complete history
const fullHistoryRepo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId: 'john' },
  options: {
    traceStrategy: 'unbounded', // No traceLimit needed
  },
  // Document: { ..., _trace: [{ /* unlimited array of all operations */ }] }
});
```

**`session?: ClientSession`** - MongoDB session for transaction support. When provided, all repository operations will use this session, making them part of an existing transaction. Typically used internally by `withSession()` and `runTransaction()` methods rather than passed directly by users.

### withSession

`withSession(session: ClientSession): MongoRepo<T, Scope, Entity>`

Creates a new repository instance that uses the provided MongoDB session for all operations. The returned repository has identical functionality to the original repository but ensures all database operations participate in the session's transaction context. This method is essential for multi-operation transactions where you need consistency across multiple repository calls. The session-aware repository maintains all configured options (scope, timestamps, versioning, etc.) from the original repository.

Calling this method on a repository instance that already has a session will simply replace the existing session with the new one, as MongoDB does not support nested transactions. This means you can safely call `withSession` multiple times to switch between different transaction contexts (though this should be an edge case anyway as you could always call `withSession` from the base repository).

### runTransaction

`runTransaction<R>(operation: (txRepo: Repo<T, Scope, Entity>) => Promise<R>): Promise<R>`

Convenience method that executes a function within a MongoDB transaction. Creates a new session, starts a transaction, and provides a session-aware repository instance to the operation function. The transaction is automatically committed if the operation succeeds or rolled back if an error is thrown. This is the recommended approach for most transaction scenarios as it handles all the session management automatically. The operation function receives a repository instance that maintains all the same configuration (scope, timestamps, etc.) as the original repository but operates within the transaction context.

This method is best suited for simple scenarios where the provided transaction-aware repository sufficiently covers all required functionality. The transaction is naturally limited to operations on the collection the repository operates on - for cross-collection transactions or mixing repository operations with direct MongoDB operations, use `withSession` instead.

### collection

`collection: Collection<any>`

Direct access to the underlying MongoDB collection instance. This property allows you to perform advanced MongoDB operations that aren't covered by the Slire interface, such as aggregations, complex queries, bulk operations, or any other collection-level methods. When using the collection directly, you can still leverage the repository's helper methods (`applyConstraints`, `buildUpdateOperation`) to maintain consistency with the repository's configured scoping, timestamps, and versioning behavior.

### applyConstraints

`applyConstraints(input: any): any`

Helper method that applies the repository's scope filtering to a given filter object. Takes your custom filter criteria and merges it with the repository's configured scope. If soft-delete is enabled it enriches the filter to ensure operations only target entities within the repository's scope that haven't been soft-deleted. Essential for maintaining data isolation when performing direct queries, updates, deletes, aggregations, or bulk operations on the collection.

### buildUpdateOperation

`buildUpdateOperation(update: UpdateOperation<UpdateInput>, mergeTrace?: any): any`

Helper method that transforms a repository update operation into a MongoDB-compliant update document with all configured consistency features applied. Takes an `UpdateOperation<UpdateInput>` with `set` and/or `unset` fields and automatically adds timestamps (like `updatedAt`), version increments, trace context (if enabled), and any other configured repository features. The optional `mergeTrace` parameter allows adding operation-specific trace context that gets merged with the repository's base trace context. Modification of system-managed fields is both prevented at compile time (type-level) and at runtime. This ensures that direct collection operations maintain the same consistency behavior as the repository's built-in update methods. Essential when performing direct `updateOne`, `updateMany`, or `bulkWrite` operations on the collection.

```typescript
// Using buildUpdateOperation with trace context
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

## Firestore Implementation

The Firestore implementation follows a more opinionated approach to play to Firestore’s strengths and avoid costly client-side work and index sprawl.

### Design assumptions

- Path‑scoped collections (recommended): Model multi‑tenancy/scope hierarchically in the document path, e.g. `organizations/{orgId}/users`. Instantiate the repository with the already scoped `collection`. Passing a `scope` is optional and is used for write‑time validation only (and to mark scope fields as readonly for updates). Reads never add scope filters – the path enforces scope. If you use a non‑scoped collection, reads will include any matching documents regardless of scope.
- Soft delete uses a boolean flag: Documents are created with `_deleted: false`. Soft deletes set `_deleted: true`. Reads/counts filter by `_deleted == false`.
- Identity: `id` maps to `doc.id` (string). The `idKey`/`mirrorId` options behave as in the Mongo section (id exposed via `idKey`, optionally mirrored in the document).

These assumptions reduce composite index requirements (no scope fields in filters) and eliminate most client‑side filtering.

### Repository instantiation (scoped collection)

```ts
function createUserRepo(db: Firestore, orgId: string) {
  return createFirestoreRepo<User>({
    collection: db.collection(`organizations/${orgId}/users`) as any,
    firestore: db,
    scope: { organizationId: orgId }, // optional; validated on writes only (not applied to reads)
    options: { softDelete: true }, // writes _deleted: false and filters on _deleted == false
  });
}
```

### Operation semantics

- getById / getByIds

  - Access documents by path (no scope filters at read time, regardless of configured `scope`). If soft delete is enabled and the document has `_deleted: true`, return `null` / exclude from results.

- create / createMany

  - Insert documents with `_deleted: false` when soft delete is enabled; apply timestamps/version/trace as configured.

- update / updateMany

  - Only update active documents (`_deleted: false`). Use batched writes; for multi‑document updates that must be atomic, provide a transaction handle.

- delete / deleteMany

  - With soft delete: set `_deleted: true` (and timestamp/version/trace). Without soft delete: physically delete.

- find / findBySpec

  - Build queries from the caller’s filter (no scope filters, even if a `scope` was configured). When soft delete is enabled, add a server‑side `where('_deleted', '==', false)` to exclude soft‑deleted documents.

- count / countBySpec
  - Use Firestore’s count aggregation on the same filter as `find`, including `_deleted == false` when soft delete is enabled (no need to fetch documents). As with reads, `scope` is not applied at count time.

### Indexing notes

- With path‑scoped collections, most compound filters will not include scope fields, greatly reducing the number of composite indexes you need.

### Differences vs. MongoDB

- Multi‑document updates are batched (not query‑based); wrap in a transaction for atomicity.
- Document ids are strings (`doc.id`), and query capabilities differ (no “field‑does‑not‑exist”). The `_deleted` boolean pattern enables server‑side filtering instead of client‑side post‑processing.

### Transactions (Firestore specifics)

- reads must happen before writes: Firestore requires a transaction to execute all reads before any writes. Avoid read‑after‑write in the same transaction callback
- internal reads: some repository methods perform an internal read (e.g., `updateMany` selects docs to update inside the transaction). Use them only after your explicit read phase, not after writes
- recommended patterns:
  - prepare data outside the transaction when possible; do only writes inside the transaction
  - or inside the transaction: perform a single read phase first (collect ids, verify state), then perform writes; do not add more reads afterwards
- write limits: Firestore enforces limits per transaction/batch (SDKs commonly cap to 500 writes; this repo uses conservative constants like `FIRESTORE_MAX_WRITES_PER_BATCH = 300` and `FIRESTORE_IN_LIMIT = 10`). Large operations are chunked accordingly

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
