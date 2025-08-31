# SmartRepo

- [What the Heck is SmartRepo?](#what-the-heck-is-smartrepo)
- [A Quick Glimpse](#a-quick-glimpse)
- [API Reference Core CRUD Operations (SmartRepo interface)](#api-reference-core-crud-operations-smartrepo-interface)
  - [getById](#getbyid)
  - [getByIds](#getbyids)
  - [create](#create)
  - [createMany](#createmany)
  - [update](#update)
  - [updateMany](#updatemany)
  - [upsert](#upsert)
  - [upsertMany](#upsertmany)
  - [delete](#delete)
  - [deleteMany](#deletemany)
  - [find](#find)
  - [findBySpec](#findbyspec)
  - [count](#count)
  - [countBySpec](#countbyspec)
- [MongoDB Implementation](#mongodb-implementation)
  - [createSmartMongoRepo](#createsmartmongorepo)
  - [withSession](#withsession)
  - [runTransaction](#runtransaction)
  - [collection](#collection)
  - [applyScopeForRead](#applyscopeforread)
  - [applyScopeForWrite](#applyscopeforwrite)
  - [buildUpdateOperation](#buildupdateoperation)
- [Recommended Usage Patterns](#recommended-usage-patterns)
  - [Repository Factories](#repository-factories)
  - [Export Repository Types](#export-repository-types)
  - [Always Use Helper Methods for Direct Collection Operations](#always-use-helper-methods-for-direct-collection-operations)
- [Decoupling Business Logic from Data Access](#decoupling-business-logic-from-data-access)
  - [Explicit Dependencies](#explicit-dependencies)
  - [Sandwich Method](#sandwich-method)
  - [Specialized Data Access Functions](#specialized-data-access-functions)
  - [Data Access Adapters](#data-access-adapters)
  - [Business Logic with Transactions](#business-logic-with-transactions)
  - [Client-Side Stored Procedures](#client-side-stored-procedures)
  - [Query Abstraction Patterns](#query-abstraction-patterns)
  - [Putting It All Together](#putting-it-all-together)
    - [HTTP Request Handlers](#http-request-handlers)
    - [Background Jobs and Scripts](#background-jobs-and-scripts)

---

## What the Heck is SmartRepo?

`SmartRepo` is a DB-agnostic interface that provides simple DB operations. It comes with implementations for MongoDB and Firestore.

It started as an experiment trying to bridge the gap between the `DocumentService`'s insufficiencies and doing DB access via
native SDKs only.

Some history first.

Why we used `DocumentService` in the beginning:

- de-facto standard in Yokoy
- convenient for basic data access

Problems of `DocumentService`:

- poor transaction support
  - bound to a single document or `DocumentTransactionWithAdditionalGetService`
  - not possible to mix with DB operations that bypass `DocumentService`
- leaky abstraction (batch operation, `DocumentMultiSubCollection*`, `DocumentCollectionGroupService`)
- inflexible scope support
- no out-of-the-box support for timestamping, versioning, soft-delete, audit traces

Apart from that, we often see problems due to poor architectural choices or shortcuts
when using `DocumentService`:

- data access logic leaking into business logic, increasing coupling
  - often, the full document service instance gets injected where a single or just a few methods would suffice
  - arbitrary queries within business logic, leading to tests that check if queries work by emulating queries in memory (`FakeDocumentService`)
- using `DocumentService` even when direct DB access would have reduced roundtrips or increased performance

These points led us to use more and more native DB clients:

- access to all features: projections, transactions, streaming, complex querying, atomic updates (like increments, add to
  or remove from array properties, remove field), etc.
- performance: reduction of DB roundtrips
- improves decoupling between business logic and data access: since business logic must be unit-testable, we typically
  inject fine-grained data access methods into it

Problems/challenges of native data access:

- requires integration tests
- redundant code for basic CRUD ops
- no out-of-the-box support for scoping, timestamping, versioning, soft-delete, audit traces
- consistent injection of fine-grained data access methods requires discipline and slightly increases boilerplate

`SmartRepo` aims to bring the best of these two worlds together by embracing a hybrid
way to access data:

- common CRUD operations out of the box, serving the majority of use cases
- configurable consistency rules (timestamps, versioning, soft-delete) that get applied automatically
- steps aside when you need more control (native clients) while helping maintain consistency rules

## A Quick Glimpse

Creating a repository instance:

```typescript
const expenseRepo = createSmartMongoRepo({
  collection: mongoClient.db('expenseDb').collection<Expense>('expenses'),
  mongoClient,
  scope: { organizationId: 'acme-123' }, // applied to all reads and writes
  options: { generateId: generateExpenseId }, // all options are optional and come with sensible defaults
});

// better to have a factory enforcing constraints and encapsulating db/collection names
function createExpenseRepo(client: MongoClient, organizationId: string) {
  return createSmartMongoRepo({
    collection: client.db('expenseDb').collection<Expense>('expenses'),
    mongoClient: client,
    scope: { organizationId },
    options: { generateId: generateExpenseId },
  });
}
```

A `SmartRepo` instance implements a set of basic, DB-agnostic CRUD operations:

```typescript
const repo = createExpenseRepo(mongoClient, 'acme-123');

const id = await repo.create(expenseFromImport());

await repo.update(id, { set: { totalClaim: 42 }, unset: ['attachments'] });

await repo.delete(id);

await repo.getById(id); // null
```

The full list is documented in the [API Reference](#api-reference-core-crud-operations-smartrepo-interface) section.

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

Finally, for the end of this quick tour, let's look at how `SmartRepo` steps aside
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
        repo.applyScopeForWrite({ currency, [TOP_MARKER]: true }), // -> applyScopeForWrite ensures org scope
        repo.buildUpdateOperation({ unset: { [TOP_MARKER]: 1 } }), // -> applies timestamps etc. if configured
        { session }
      );

      // determine new top expenses
      const topExpenses = await repo.collection
        .aggregate<{ expenseId: string }>(
          [
            { $match: repo.applyScopeForRead({ currency }) }, // -> applyScopeForRead ensures org scope
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
            filter: repo.applyScopeForWrite({ _id: e.expenseId }), // -> again, ensure org scope
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

Due to their DB-specific nature, the repository functions supporting native operations are not part of the DB-agnostic `SmartRepo`
interface. A future Firestore implementation may provide such helpers in a different fashion.
Hiding scope filters may seem trivial and not worth the effort of encapsulating them in the repository instance. The value
of this encapsulation will hopefully become more apparent when we look at [consistency features](#options) that no one really likes to reimplement
again and again.

You may have noticed that SmartRepo's CRUD operations borrow a lot from MongoDB's client API (for example,
updates with set/unset, variants with bulk support, filter syntax).
This is no coincidence as the MongoDB API is considered very clean in that regard, and should also work well with other DB implementations.

Finally, if you've been using `DocumentService` for most of your data access, you might wonder what a migration path to `SmartRepo` would look like. You're probably thinking it's quite an effort since you've injected `DocumentService` instances all over the place and the interfaces aren't compatible. That's correct, and the "Recommended Usage Patterns" section explains why we think that injecting repository instances everywhere isn't a good idea in the first place.

## API Reference Core CRUD Operations (SmartRepo interface)

The operations listed here resemble the full set of DB-agnostic functions in a SmartRepo. At time of writing only the MongoDB implementation existed. So some descriptions might mention some characteristics specific to MongoDB. However, the interface is designed to
be as simple as possible to allow being implemented for other DBs, particularly Firestore.

- TODO: section to explain API design decisions

**Note 1**: In the function signatures below, `T` represents the entity type.

**Note 2**: All read functions support projections. A projection is given in the form `{ propA: true, propB: true }` where `propA` and `propB` are valid properties in `T`. A projection is properly reflected in the return type.

**Note 3**: Scope filtering and other consistence features are not part of this interface as they are basically repository options that get only mentioned during instantiation. However, they might be mentioned in the function descriptions describing the intended behavior as part of the interface contract any implemention must adhere to.

### getById

`getById(id: string): Promise<T | null>`

`getById<P extends Projection<T>>(id: string, projection: P): Promise<Projected<T, P> | null>`

Retrieves a single entity by its ID, automatically applying the repository's scope filter. Returns `null` if no entity is found with the given ID or if the entity exists but doesn't match the scope (e.g., wrong organization). When using the projection variant, only the specified fields are returned and the result is properly typed to reflect the projection.

### getByIds

`getByIds(ids: string[]): Promise<[T[], string[]]>`

`getByIds<P extends Projection<T>>(ids: string[], projection: P): Promise<[Projected<T, P>[], string[]]>`

Bulk version of `getById` that retrieves multiple entities by their IDs. Returns a tuple containing two arrays: the first contains all found entities, the second contains the IDs that were not found (either because they don't exist or don't match the scope). The order of found entities is not guaranteed to match the input order. When using the projection variant, only the specified fields are returned for each entity.

### create

`create(entity: Entity): Promise<string>`

Creates a new entity in the repository. Returns the generated ID for the created entity. The repository automatically generates a unique ID unless a custom ID generator is configured. Scope fields are automatically applied during creation, and any configured timestamps (like `createdAt`) or versioning fields are added. The `Entity` type excludes the `id` field and any scope-related fields since these are managed by the repository.

### createMany

`createMany(entities: Entity[]): Promise<string[]>`

Bulk version of `create` that creates multiple entities in a single operation. Returns an array of generated IDs corresponding to the created entities. The order of returned IDs matches the order of input entities. All entities are subject to the same automatic ID generation, scope application, and consistency feature handling as the single `create` function.

### update

`update(id: string, update: UpdateOperation<Entity>): Promise<void>`

Updates a single entity identified by its ID. The update operation supports both `set` (to update fields) and `unset` (to remove optional fields) operations, which can be used individually or combined. The repository automatically applies scope filtering to ensure only entities within the current scope can be updated. Any configured timestamps (like `updatedAt`) or versioning increments are applied automatically. No error is thrown if the entity doesn't exist or doesn't match the scope.

### updateMany

`updateMany(ids: string[], update: UpdateOperation<Entity>): Promise<void>`

Bulk version of `update` that applies the same update operation to multiple entities identified by their IDs. All entities are subject to the same scope filtering, timestamp updates, and versioning as the single `update` function. The operation succeeds even if some of the provided IDs don't exist or don't match the scope - only the valid, in-scope entities will be updated.

### upsert

`upsert(entity: Entity & { id: string }): Promise<void>`

Inserts a new entity if it doesn't exist, or updates an existing entity if it does exist, based on the provided ID. Unlike `create`, the entity must include an `id` field. The repository applies scope filtering during both the existence check and the actual operation. For inserts, automatic timestamps (like `createdAt`) and initial versioning are applied. For updates, only update-related timestamps (like `updatedAt`) and version increments are applied. If an entity exists but is out of scope, it will be treated as non-existent and a new entity will be created. Note that when the repository is configured with a custom ID generator, the user is responsible for providing correct IDs that conform to the generator's format.

### upsertMany

`upsertMany(entities: (Entity & { id: string })[]): Promise<void>`

Bulk version of `upsert` that performs insert-or-update operations on multiple entities in a single call. Each entity is processed independently with the same logic as the single `upsert` function. This provides better performance than multiple individual upsert calls while maintaining the same consistency guarantees and scope filtering behavior.

### delete

`delete(id: string): Promise<void>`

Deletes a single entity identified by its ID. The repository applies scope filtering to ensure only entities within the current scope can be deleted. If the repository is configured with soft delete, the entity is marked with a deletion flag (default is `_deleted`) rather than being physically removed. If timestamping is also enabled, a `deletedAt` timestamp is added as well. If hard delete is configured, the entity is permanently removed from the database. No error is thrown if the entity doesn't exist or doesn't match the scope.

### deleteMany

`deleteMany(ids: string[]): Promise<void>`

Bulk version of `delete` that removes multiple entities identified by their IDs. All entities are subject to the same scope filtering and soft/hard delete behavior as the single `delete` function. The operation succeeds even if some of the provided IDs don't exist or don't match the scope - only the valid, in-scope entities will be deleted.

### find

`find(filter: Partial<T>): Promise<T[]>`

`find<P extends Projection<T>>(filter: Partial<T>, projection: P): Promise<Projected<T, P>[]>`

Queries entities based on the provided filter criteria. The filter uses a subset of the entity properties to match against. The repository automatically applies scope filtering in addition to the user-provided filter. If soft delete is enabled, soft-deleted entities are automatically excluded from results. Returns an empty array if no matching entities are found. When using the projection variant, only the specified fields are returned and the result is properly typed to reflect the projection.

Note that the signature may change in the future to include parameters for limits and sort order, and a streaming version is also being considered.

### findBySpec

`findBySpec<S extends Specification<T>>(spec: S): Promise<T[]>`

`findBySpec<S extends Specification<T>, P extends Projection<T>>(spec: S, projection: P): Promise<Projected<T, P>[]>`

Queries entities using a specification object that encapsulates filter criteria and business rules. The repository automatically applies scope filtering and soft delete exclusion just like `find`. Specifications provide composable, reusable query logic that can be combined using `combineSpecs`. When using the projection variant, only the specified fields are returned and the result is properly typed. See [Query Abstraction Patterns](#query-abstraction-patterns) for detailed examples and patterns.

### count

`count(filter: Partial<T>): Promise<number>`

Returns the number of entities that match the provided filter criteria. Like `find`, the repository automatically applies scope filtering in addition to the user-provided filter, and soft-deleted entities are automatically excluded from the count if soft delete is enabled. Returns 0 if no matching entities are found.

### countBySpec

`countBySpec<S extends Specification<T>>(spec: S): Promise<number>`

Returns the number of entities that match the provided specification. Like `count`, the repository automatically applies scope filtering and soft delete exclusion. This method works with the same specification objects used by `findBySpec`, enabling consistent query logic across find and count operations. Returns 0 if no matching entities are found.

## MongoDB Implementation

The MongoDB implementation provides additional functionality beyond the core SmartRepo interface. This includes the factory function for creating repositories, transaction support methods, and helper functions that enable direct MongoDB operations while maintaining the repository's consistency rules and scoping behavior. These MongoDB-specific features are essential for advanced use cases where the generic interface isn't sufficient, but you still want the benefits of automatic scope filtering, timestamps, and other repository features.

### createSmartMongoRepo

`createSmartMongoRepo({ collection, mongoClient, scope?, options? }): MongoRepo<T, Scope, Entity>`

Factory function that creates a MongoDB repository instance implementing the SmartRepo interface. Takes a MongoDB collection, client, optional scope for filtering, and configuration options for consistency features like timestamps, versioning, and soft delete. The function uses TypeScript generics to ensure type safety across all repository operations. The returned repository instance provides both the DB-agnostic SmartRepo interface and additional MongoDB-specific helpers (described in the following sections) for advanced operations.

#### Scope

The `scope` parameter defines filtering criteria that are automatically applied to all repository operations. For example, passing `{ organizationId: 'acme-123' }` ensures that all reads, writes, updates, and deletes only affect entities belonging to that organization. The scope is merged with user-provided filters and becomes part of every database operation, providing automatic multi-tenancy or data partitioning without requiring explicit filtering in each method call.

#### Options

The `options` parameter configures consistency features and repository behavior:

**`generateId?: () => string`** - Custom ID generation function. By default, the repository uses UUID v4 for generating entity IDs. Provide a custom function to use different ID formats (e.g., sequential numbers, custom prefixes, or other UUID versions). This function is called automatically during `create` and `createMany` operations.

**`softDelete?: boolean`** - Enables soft delete functionality. When `true`, delete operations mark entities with a `_deleted` flag instead of physically removing them from the database. Soft-deleted entities are automatically excluded from all read operations (`find`, `getById`, `count`). Defaults to `false` (hard delete).

**`traceTimestamps?: true | 'mongo' | (() => Date)`** - Configures automatic timestamping behavior. When `true`, uses JavaScript `Date.now()` for timestamps. When `'mongo'`, uses MongoDB server timestamps. When a function is provided, that function is called to generate timestamps (this can come in handy for integration tests). The timestamps are applied as follows: `createdAt` is set during `create`, `createMany` operations and when `upsert`/`upsertMany` creates new entities; `updatedAt` is set on all write operations (`create`, `createMany`, `update`, `updateMany`, `upsert`, `upsertMany`, `delete`, `deleteMany`); `deletedAt` is set during soft delete operations when `softDelete` is enabled.

**`timestampKeys?: TimestampConfig<T>`** - Customizes timestamp field names. By default, uses `_createdAt`, `_updatedAt`, and `_deletedAt`. Provide an object like `{ createdAt: 'dateCreated', updatedAt: 'dateModified' }` to use custom field names that match your entity schema. You don't need to specify all keys - any unspecified keys will fall back to their default names. Note that the `deletedAt` key is only used when soft delete is enabled. When this option is provided, `traceTimestamps` is implicitly set to `true`, so there's no need to specify both options.

**`version?: VersionConfig`** - Enables optimistic versioning. When `true`, uses the default `_version` field that increments on each update. Alternatively, provide a custom numeric field name from your entity type. Version increments happen automatically on all update operations, helping detect concurrent modifications.

**`session?: ClientSession`** - MongoDB session for transaction support. When provided, all repository operations will use this session, making them part of an existing transaction. Typically used internally by `withSession()` and `runTransaction()` methods rather than passed directly by users.

### withSession

`withSession(session: ClientSession): MongoRepo<T, Scope, Entity>`

Creates a new repository instance that uses the provided MongoDB session for all operations. The returned repository has identical functionality to the original repository but ensures all database operations participate in the session's transaction context. This method is essential for multi-operation transactions where you need consistency across multiple repository calls. The session-aware repository maintains all configured options (scope, timestamps, versioning, etc.) from the original repository.

Calling this method on a repository instance that already has a session will simply replace the existing session with the new one, as MongoDB does not support nested transactions. This means you can safely call `withSession` multiple times to switch between different transaction contexts (though this should be an edge case anyway as you could always call `withSession` from the base repository).

### runTransaction

`runTransaction<R>(operation: (txRepo: SmartRepo<T, Scope, Entity>) => Promise<R>): Promise<R>`

Convenience method that executes a function within a MongoDB transaction. Creates a new session, starts a transaction, and provides a session-aware repository instance to the operation function. The transaction is automatically committed if the operation succeeds or rolled back if an error is thrown. This is the recommended approach for most transaction scenarios as it handles all the session management automatically. The operation function receives a repository instance that maintains all the same configuration (scope, timestamps, etc.) as the original repository but operates within the transaction context.

This method is best suited for simple scenarios where the provided transaction-aware repository sufficiently covers all required functionality. The transaction is naturally limited to operations on the collection the repository operates on - for cross-collection transactions or mixing repository operations with direct MongoDB operations, use `withSession` instead.

### collection

`collection: Collection<any>`

Direct access to the underlying MongoDB collection instance. This property allows you to perform advanced MongoDB operations that aren't covered by the SmartRepo interface, such as aggregations, complex queries, bulk operations, or any other collection-level methods. When using the collection directly, you can still leverage the repository's helper methods (`applyScopeForRead`, `applyScopeForWrite`, `buildUpdateOperation`) to maintain consistency with the repository's configured scoping, timestamps, and versioning behavior.

### applyScopeForRead

`applyScopeForRead(input: any): any`

Helper method that applies the repository's scope filtering to a given filter object for read operations. Takes your custom filter criteria and merges it with the repository's configured scope (e.g., organizationId filter) and any additional read-specific filters (like soft delete exclusion). This ensures that direct collection operations maintain the same data isolation and filtering behavior as the repository's built-in methods. Essential when performing custom queries, aggregations, or other read operations directly on the collection.

### applyScopeForWrite

`applyScopeForWrite(input: any): any`

Helper method that applies the repository's scope filtering to a given filter object for write operations. Takes your custom filter criteria and merges it with the repository's configured scope (e.g., organizationId filter) to ensure write operations only affect entities within the repository's scope. Unlike `applyScopeForRead`, this method does not apply soft delete exclusion, allowing write operations to target soft-deleted entities when needed. Essential for maintaining data isolation when performing direct updates, deletes, or bulk operations on the collection.

Note that the behavioral difference between `applyScopeForRead` and `applyScopeForWrite` regarding soft delete filtering is currently under investigation and may change in the future. `applyScopeForWrite` might be updated to also include the soft delete filter for consistency or both functions will be consolidated into one.

### buildUpdateOperation

`buildUpdateOperation(update: UpdateOperation<any>): any`

Helper method that transforms a repository update operation into a MongoDB-compliant update document with all configured consistency features applied. Takes an `UpdateOperation` with `set` and/or `unset` fields and automatically adds timestamps (like `updatedAt`), version increments, and any other configured repository features. This ensures that direct collection operations maintain the same consistency behavior as the repository's built-in update methods. Essential when performing direct `updateOne`, `updateMany`, or `bulkWrite` operations on the collection.

## Recommended Usage Patterns

Follow the recommendations in this section to maintain consistency and keep the code organized. Most of them apply to the current MongoDB implementation.

### Repository Factories

Prefer creating dedicated factory functions over direct `createSmartMongoRepo` calls to encapsulate configuration:

```typescript
// ✅ GOOD - encapsulated factory
export function createExpenseRepo(client: MongoClient, orgId: string) {
  return createSmartMongoRepo({
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
const repo = createSmartMongoRepo({ ... });
```

### Export Repository Types

Alongside your repository factories, always export a corresponding type that captures the exact return type:

```typescript
// expense-repo.ts

// ✅ GOOD - export both factory and type
export function createExpenseRepo(client: MongoClient, orgId: string) {
  return createSmartMongoRepo({ ... });
}

export type ExpenseRepo = ReturnType<typeof createExpenseRepo>;

// business-logic.ts

// ❌ BAD - manual generic parameters, can get out of sync & tight coupling
function processExpenses(deps: { repo: SmartRepo<Expense, any, any> }, params: { ... }) {
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
- Avoid manually reconstructing `SmartRepo<Expense, { organizationId: string }, ExpenseEntity>`
- Single source of thruth: Factory function defines both implementation and type

### Always Use Helper Methods for Direct Collection Operations

When performing operations directly on `repo.collection`, always use the provided helper methods to maintain repository behavior:

```typescript
// ✅ GOOD - uses helper methods
await repo.collection.updateMany(
  repo.applyScopeForWrite({ status: 'active' }),
  repo.buildUpdateOperation({ set: { processed: true } })
);

// ❌ BAD - bypasses repository consistency
await repo.collection.updateMany(
  { status: 'active' },
  { $set: { processed: true } }
);
```

## Decoupling Business Logic from Data Access

A fundamental principle of maintainable software design is keeping business logic independent from data access implementation. Injecting entire repository instances into business logic components creates tight coupling and obscures the actual data dependencies.

A common counterargument is that "unit testing is easy when you can just mock the entire repository with a fake implementation that works in memory." This practice is indeed widespread with `DocumentService`, where developers create `FakeDocumentService` instances for testing. However, this apparent convenience is actually a design smell that encourages poor architecture. The ease of mocking entire repositories tempts developers to inject whole repository instances in the first place, because changes to business logic data access patterns don't require signature changes - the same repository interface accommodates any new data operations. This practice also encourages passing repositories down through call chains and intermixing data access with business logic, since the repository is always readily available wherever it's needed. While this seems convenient, it actually hides evolving dependencies and makes the true data access patterns invisible at the interface level. This directly leads to over-privileged access (since the full repository is always available), unclear dependencies (since the interface doesn't reveal actual usage), and tight coupling (since business logic becomes dependent on the complete repository contract rather than specific operations).

This section presents principles for reducing coupling between data access and business logic. These are guidelines rather than rigid rules - design decisions depend on context, and the complexity of your specific problems will vary. Apply what makes sense for your situation without being overly dogmatic about it.

Note that all examples below use functional approaches rather than classes, which better matches the stateless nature of typical data processing tasks (HTTP request handlers, scripts, etc.). Classes are designed to encapsulate operations over mutable state - something we rarely need for data processing functions. Following the convention where a function's first parameter is `deps` (dependencies) and subsequent parameters are processing inputs enables easy partial application and passing such functions around:

```typescript
// FUNCTIONAL APPROACH USED HERE

async function processExpense(
  deps: { getByIds: ExpenseRepo['getByIds']; updateMany: ExpenseRepo['updateMany'] },
  input: ProcessRequest
) {
  // ...
}

// direct application
await processExpense(createDeps(), processInput());

// ...or wrapping in a lambda for injection
await handler({ process: input => processExpense(createDeps(), input), otherDep: ...}, input());

// ...or partial application (using lodash's partial)
await handler({ process: partial(processExpense, createDeps()), otherDep: ...}, input());

// CLASS-BASED EQUIVALENT (which we're not using here)

class ExpenseProcessor {
  constructor(private deps: { getByIds: ExpenseRepo['getByIds']; updateMany: ExpenseRepo['updateMany'] }) {}

  async processExpense(input: ProcessRequest) {
    // ...
  }
}

// direct application
await new ExpenseProcessor(createDeps()).processExpense(processInput());

// ... or partial application for injection
const processor = new ExpenseProcessor(createDeps());
await handler({ process: processor.processExpense.bind(processor), otherDep: ...}, input());
```

TODOs:

- big factory as alternative for purpose-built adapters

### Explicit Dependencies

As mentioned in the repository type section above, injecting whole repository instances creates coupling and hides actual dependencies. Instead, business logic should explicitly declare the specific data operations it needs.

```typescript
// ❌ BAD - whole repository injected, unclear dependencies
async function processExpense(
  deps: { expenseRepo: ExpenseRepo },
  expenseId: string
) {
  const expense = await deps.expenseRepo.getById(expenseId);
  if (!expense || expense.status !== 'pending') return;

  const result = doSomething(expense);

  await deps.expenseRepo.update(expenseId, { set: result });
}
```

Problems with this approach:

- **Over-privileged access**: Function gets entire repository interface but only needs 2 methods
- **Hidden dependencies**: Signature doesn't reveal which data operations are actually used
- **Opaque testing**: Even comprehensive mocks don't clearly show which operations the function relies on

Moreover, unit tests for business logic shouldn't need comprehensive, realistic repository mocks at all. The goal is to test the _business logic_, not data access patterns. Simple data mocks that provide exactly the input data needed for each test scenario are sufficient and often preferable - they're easier to set up and understand.

This doesn't mean we shouldn't test data access at all. On the contrary, data access is ideally tested against the database (TODO link to test section) separately.

```typescript
// ✅ GOOD - explicit dependencies, clear interface
async function processExpense(
  deps: {
    getById: ExpenseRepo['getById'];
    update: ExpenseRepo['update'];
  },
  expenseId: string
) {
  const expense = await deps.getById(expenseId);
  if (!expense || expense.status !== 'pending') return;

  const result = doSomething(expense);

  await deps.update(expenseId, { set: result });
}
```

Benefits of explicit dependencies:

- **Minimal interface**: Function only depends on the 2 methods it actually uses
- **Clear dependencies**: Signature immediately reveals all data operations required
- **Simple testing**: Pass lightweight mocks returning test data, verify calls with spies

You might also consider exposing aliases for heavily used functions:

```typescript
// expense-repo.ts

// ...
export type ExpenseRepo = ReturnType<typeof createExpenseRepository>;

export type GetExpenseById = ExpenseRepo['getById'];
export type UpdateExpense = ExpenseRepo['update'];
export type FindExpenses = ExpenseRepo['find'];
// etc.
```

For the sake of brevity, the examples below will assume we have such utility types defined somewhere.

### Sandwich Method

The sandwich method is an established pattern that promotes clean separation between data access and business logic by organizing operations into three distinct phases:

1. **Read**: Gather all required data upfront
2. **Process**: Execute pure business logic on the collected data
3. **Write**: Persist any changes back to storage

This approach creates a clear processing pipeline where business logic operates on plain data structures without knowledge of persistence mechanisms.
Let's have a look at a contrived example:

```typescript
async function processExpenseReimbursement(
  deps: {
    getExpenseById: GetExpenseById;
    getUserById: GetUserById;
    updateExpense: UpdateExpense;
    createReimbursement: CreateReimbursement;
  },
  expenseId: string
) {
  // 1. READ - gather all data needed
  const expense = await deps.getExpenseById(expenseId);
  if (!expense || expense.status !== 'approved') return null;

  const user = await deps.getUserById(expense.userId);
  if (!user) throw new Error('User not found');

  // 2. PROCESS - pure business logic
  const reimbursementAmount = calculateReimbursement(
    expense,
    user.reimbursementRate
  );
  const taxDeduction = calculateTaxes(reimbursementAmount, user.taxBracket);
  const finalAmount = reimbursementAmount - taxDeduction;

  const reimbursementData = {
    expenseId,
    userId: expense.userId,
    amount: finalAmount,
    taxDeducted: taxDeduction,
    processedAt: new Date(),
  };

  // 3. WRITE - persist changes
  await deps.updateExpense(expenseId, {
    status: 'reimbursed',
    reimbursedAt: new Date(),
  });

  const reimbursementId = await deps.createReimbursement(reimbursementData);

  return { reimbursementId, amount: finalAmount };
}
```

Benefits:

- **Clear separation**: Business logic is isolated from data access concerns
- **Easy testing**: Pure business logic can be unit tested independently
- **Explicit dependencies**: All data requirements are visible upfront
- **Transactional clarity**: Clear boundaries for transaction management

The sandwich method works well for many scenarios, but has limitations:

- **Interactive workflows**: When business logic decisions determine what additional data to fetch
- **Large datasets**: Reading everything upfront may cause memory or performance issues
- **Streaming processing**: When data arrives incrementally and must be processed as it comes
- **Complex state machines**: Where reads and writes are heavily interleaved based on intermediate states

For such cases, consider breaking the workflow into smaller sandwich operations, or accept some interleaving of data access and business logic while keeping it minimal and well-structured.

**As a universal advice, avoid passing data access dependencies down the call chain**: When business logic becomes complex and spans multiple functions, resist the temptation to pass repository instances or data access functions to deeper levels of your call stack, otherwise several problems arise:

- it becomes difficult to distinguish between pure business logic and data access concerns
- functions that should be testable with simple data become dependent on database mocks
- functions gain both business logic and data access responsibilities
- changes to data access patterns ripple through multiple business logic layers

Instead, keep data access at the orchestration level and pass computed values or domain objects to business logic functions.

### Specialized Data Access Functions

Instead of exposing raw repository methods, create purpose-built data access functions that encapsulate domain logic and validation. Building on our reimbursement example:

```typescript
async function processExpenseReimbursement(
  deps: {
    getReimbursementData: GetReimbursementData;
    finalizeReimbursement: FinalizeReimbursement;
  },
  expenseId: string
) {
  // 1. READ - single specialized function handles complex data gathering
  const data = await deps.getReimbursementData(expenseId);
  if (!data) return null;

  const { expense, user } = data;

  // 2. PROCESS - pure business logic
  const reimbursementAmount = calculateReimbursement(
    expense,
    user.reimbursementRate
  );
  const taxDeduction = calculateTaxes(reimbursementAmount, user.taxBracket);
  const finalAmount = reimbursementAmount - taxDeduction;

  const reimbursementData = {
    expenseId,
    userId: expense.userId,
    amount: finalAmount,
    taxDeducted: taxDeduction,
    processedAt: new Date(),
  };

  // 3. WRITE - single specialized function handles complex persistence
  const reimbursementId = await deps.finalizeReimbursement({
    expenseId,
    reimbursementData,
  });

  return { reimbursementId, amount: finalAmount };
}
```

Notice how the specialized functions hide complexity:

- `getReimbursementData` validates status, fetches related user data, and returns a structured result
- `finalizeReimbursement` handles both expense status updates and reimbursement creation as an atomic operation

**Testing complex data operations**: While the business logic (`calculateReimbursement`, `calculateTaxes`) should be unit tested with simple data mocks, the specialized data access functions themselves are excellent candidates for integration tests that run against a test database.

### Data Access Adapters

Create adapter functions that implement the specialized data access functions using your repositories:

```typescript
// Data access adapter that manages its own repository dependencies
function createReimbursementDataAccess(mongoClient: MongoClient, organizationId: string, session?: ClientSession) {
  let expenseRepo = createExpenseRepo(mongoClient, organizationId);
  let userRepo = createUserRepo(mongoClient, organizationId);
  let reimbursementRepo = createReimbursementRepo(mongoClient, organizationId);

  if (session) {
    expenseRepo = expenseRepo.withSession(session);
    userRepo = userRepo.withSession(session);
    reimbursementRepo = reimbursementRepo.withSession(session);
  }

  return {
    getReimbursementData: async (id: string) => {
      const expense = await expenseRepo.getById(id);
      if (!expense || expense.status !== 'approved') return null;

      const user = await userRepo.getById(expense.userId);
      if (!user) return null;

      return { expense, user };
    },

    finalizeReimbursement: async ({ expenseId, reimbursementData }) => {
        await expenseRepo.update(expenseId, {
          set: { status: 'reimbursed', reimbursedAt: new Date() }
        });
        return await reimbursementRepo.create(reimbursementData);
      }
    }
  };
}

// Usage without transaction
const dataAccess = createReimbursementDataAccess(mongoClient, organizationId);
await processExpenseReimbursement(dataAccess, expenseId);
```

Data access adapters are valuable when you need:

- **Multi-repository operations**: Coordinating data from multiple sources (`getReimbursementData` fetches from both expense and user repos)
- **Domain-specific validation**: Encapsulating business rules (`expense.status !== 'approved'` check)
- **Complex error handling**: Standardizing error responses across different failure scenarios
- **Transaction coordination**: Managing atomic operations across multiple repositories
- **Data transformation**: Converting repository results into domain-specific shapes
- **Consistent patterns**: Ensuring uniform approach to similar operations across your codebase

Skip adapters for:

- **Simple CRUD operations**: Direct repository calls like `repo.getById(id)` don't need wrapping
- **Single-repository operations**: When business logic only touches one repository
- **1:1 mappings**: When repository methods already match your domain needs perfectly
- **Read-only operations**: Simple data fetching that doesn't require transformation or validation

The key principle: **add adapters when they provide real value** through coordination, validation, transformation, or domain-specific logic. Avoid them for simple pass-through operations where they just add indirection without benefit.

**Finding the right boundary**: Deciding what belongs in business logic versus what belongs in the adapter can be challenging. Consider `expense.status !== 'approved'` - is this a data access concern (filtering) or business logic (validation)? There's no universal answer. Generally:

- **Put in adapters**: Data fetching patterns, cross-repository coordination, technical constraints (`status !== 'approved'` as a data filter)
- **Put in business logic**: Domain rules, calculations, business decisions (`canBeReimbursed(expense, user)` as a business rule)
- **Gray areas**: Use your judgment based on team conventions and whether the logic is more about "how to get data" vs "what to do with data"

Don't over-optimize these boundaries initially. Start with what feels natural, and refactor when patterns emerge or testing becomes difficult.

**Note on adapter signatures**: The above example shows adapters that accept `mongoClient`, `organizationId`, and optional `session` parameters, managing repository creation internally.

- **Pros**: Self-contained, simplified transaction handling, consistent interface
- **Cons**: Less flexible for testing (harder to inject mock repositories), couples adapter to specific repository factories

For maximum testability, you might prefer injecting repositories directly and handling session management at the caller level, trading some convenience for flexibility.

### Business Logic with Transactions

When transactions are required, we can reuse our specialized data access functions from the previous section. The key is to let the caller manage the transaction boundary by passing the session to the adapter:

```typescript
// Keep the business logic function unchanged from the specialized functions section
async function processExpenseReimbursement(
  deps: {
    getReimbursementData: GetReimbursementData;
    finalizeReimbursement: FinalizeReimbursement;
  },
  expenseId: string
) {
  // ... hidden for sake of brevity
}
```

Now, to run this within a transaction, the caller simply passes the session to the adapter:

```typescript
// Transaction-aware orchestrator
async function processExpenseReimbursementWithTransaction(
  mongoClient: MongoClient,
  organizationId: string,
  expenseId: string
) {
  return await mongoClient.withSession(async (session) => {
    return await session.withTransaction(async () => {
      // Create transaction-aware data access functions - session passed directly
      const transactionDataAccess = createReimbursementDataAccess(
        mongoClient,
        organizationId,
        session
      );

      // Call the unchanged business logic function
      return await processExpenseReimbursement(
        transactionDataAccess,
        expenseId
      );
    });
  });
}
```

Key benefits of this approach:

- Clean separation - business logic function remains unchanged and transaction-agnostic
- Self-contained adapters - adapters manage their own repository dependencies internally
- Simplified session handling - just pass the session to the adapter, no manual repository creation
- Consistent interface - same adapter function works with or without transactions
- Easy testing - business logic can be tested independently of transaction concerns

Usage:

```typescript
// With transaction
const result = await processExpenseReimbursementWithTransaction(
  mongoClient,
  organizationId,
  expenseId
);

// Without transaction (using the original function)
const dataAccess = createReimbursementDataAccess(mongoClient, organizationId);
const result2 = await processExpenseReimbursement(dataAccess, expenseId);
```

This pattern keeps the business logic clean while giving callers full control over transaction boundaries.

### Client-Side Stored Procedures

Client-side stored procedures are self-contained, parameterizable functions that encapsulate complete data processing workflows. Unlike traditional stored procedures that run on the database server, these functions execute on the client side while leveraging the repository's consistency features and native database capabilities.

The key characteristics that distinguish client-side stored procedures from [specialized data access functions](#specialized-data-access-functions):

- **End-to-end processing**: Handle complete use cases from data gathering through final persistence
- **Self-contained**: Operate independently rather than as building blocks for other workflows
- **Data-focused**: Primarily concerned with data transformation, aggregation, and maintenance operations
- **Transactional by nature**: Often require atomicity across multiple operations
- **Batch-oriented**: Typically process multiple records or perform complex data maintenance

The `markTopExpenses` function from the [Quick Glimpse](#a-quick-glimpse) section is a perfect example:

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
      // Remove marker from all current top expenses
      await repo.collection.updateMany(
        repo.applyScopeForWrite({ currency, [TOP_MARKER]: true }),
        repo.buildUpdateOperation({ unset: { [TOP_MARKER]: 1 } }),
        { session }
      );

      // Determine new top expenses via aggregation
      const topExpenses = await repo.collection
        .aggregate<{ expenseId: string }>(
          [
            { $match: repo.applyScopeForRead({ currency }) },
            { $sort: { category: 1, totalClaim: -1 } },
            { $group: { _id: '$categoryId', expenseId: { $first: '$_id' } } },
          ],
          { session }
        )
        .toArray();

      // Apply marker to new top expenses
      await repo.collection.bulkWrite(
        topExpenses.map((e) => ({
          updateOne: {
            filter: repo.applyScopeForWrite({ _id: e.expenseId }),
            update: repo.buildUpdateOperation({ set: { [TOP_MARKER]: true } }),
          },
        })),
        { session }
      );
    });
  });
}
```

When to use client-side stored procedures:

- Data maintenance operations - batch updates, cleanup routines, or data migrations
- Complex calculations - operations requiring aggregations, transformations, or multi-step computations
- Reporting workflows - generating summary data or computed fields
- Batch processing - operations that work on large sets of data
- Administrative functions - system maintenance or configuration updates

Design principles:

- Parameterize inputs - accept specific parameters rather than hardcoding values
- Maintain scoping - always use repository helper methods for scope consistency
- Handle transactions - most procedures should be atomic operations
- Document side effects - clearly document what data changes occur
- Consider idempotency - design procedures to be safely re-runnable when possible

Testing client-side stored procedures:

These functions are excellent candidates for integration tests that run against a test database, as they combine business logic with complex data operations that are difficult to mock effectively. Focus your testing on:

- Correct data transformations - verify the procedure produces expected results
- Transaction behavior - ensure atomicity and proper rollback on errors
- Scope enforcement - confirm operations respect organizational boundaries
- Edge cases - test with empty datasets, boundary conditions, and error scenarios

Client-side stored procedures occupy a unique space in your data access architecture - they're more substantial than specialized data access functions but remain client-side rather than moving complex logic to the database server. This approach maintains the benefits of TypeScript typing, application-level testing, and repository consistency features while handling complex data processing requirements.

### Query Abstraction Patterns

One of the ongoing tensions in data access design is how to handle arbitrary queries. SmartRepo provides generic query capabilities through `find` and `count` methods. However, injecting these methods directly into business logic can couple your domain logic to query implementation details, even though the queries remain DB-agnostic.

The fundamental question becomes: **when should you wrap queries in specialized functions versus injecting generic query capabilities directly?**

As with most architectural decisions, there's no universal answer - the choice depends on your specific context, complexity, and trade-offs. Let's explore the patterns and decision criteria.

#### Direct Query Injection

The simplest approach is injecting `find` and `count` methods directly into business logic:

```typescript
async function generateExpenseReport(
  deps: {
    find: ExpenseRepo['find'];
    count: ExpenseRepo['count'];
  },
  params: { daysOverdue: number; userId: string }
) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - params.daysOverdue);

  // Business logic directly specifies different queries
  const overdueExpenses = await deps.find({
    status: 'pending',
    submittedAt: { $lt: cutoffDate },
  });

  const totalUserExpenses = await deps.count({
    userId: params.userId,
  });

  return {
    overdueExpenses,
    totalUserExpenses,
    reportDate: new Date(),
  };
}
```

Benefits:

- Simple and direct - no additional abstraction layer
- Flexible - business logic can specify exactly what it needs
- Rapid development - quick to implement and modify
- DB-agnostic - still maintains portability across database implementations

Drawbacks:

- Query coupling - business logic knows about data structure and query patterns
- Repetition - similar queries may be duplicated across functions
- Testing complexity - tests must understand query structure
- Change impact - database schema changes ripple into business logic

The next sections explore several patterns that can abstract queries behind more semantic interfaces.

#### Named Query Functions

Create purpose-built functions that encapsulate specific query logic:

```typescript
// expense-queries.ts
export function createExpenseQueries(repo: ExpenseRepo) {
  return {
    findOverdueExpenses: async (daysOverdue: number) => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOverdue);

      return await repo.find({
        status: 'pending',
        submittedAt: { $lt: cutoffDate },
      });
    },

    findHighValueExpenses: async (minAmount: number) => {
      return await repo.find({
        status: 'approved',
        totalClaim: { $gte: minAmount },
      });
    },

    findExpensesByCategory: async (categoryId: string) => {
      return await repo.find({ categoryId });
    },
  };
}

// ...export frequently used signature types
type ExpenseQueries = ReturnType<typeof createExpenseQueries>;
export type FindOverdueExpenses = ExpenseQueries['findOverdueExpenses'];
export type FindHighValueExpenses = ExpenseQueries['findHighValueExpenses'];

// Usage
async function generateExpenseAnalysis(
  deps: {
    findOverdueExpenses: FindOverdueExpenses;
    findHighValueExpenses: FindHighValueExpenses;
  },
  params: { daysOverdue: number; minAmount: number }
) {
  const overdueExpenses = await deps.findOverdueExpenses(params.daysOverdue);
  const highValueExpenses = await deps.findHighValueExpenses(params.minAmount);

  // Business logic focused on domain concepts, not queries
  return analyzeExpensePatterns(overdueExpenses, highValueExpenses);
}
```

Note: These query functions can be made more flexible by accepting optional projection parameters, allowing callers to specify which fields they need. For example, `findOverdueExpenses(daysOverdue, { id: true, totalClaim: true })` could return only the essential fields for performance-sensitive operations.

#### Query Specifications

For more complex scenarios, consider the specification pattern. This pattern is particularly useful when you need both `find` and `count` operations with identical filter logic, avoiding the duplication you might see with named query functions.

The core idea behind specifications is to encapsulate business rules and query criteria as composable, first-class objects. Rather than scattering filter logic throughout your codebase, specifications let you define reusable criteria that can be combined, tested in isolation, and applied consistently across different operations. These specifications can be used both within repository contexts and, depending on the native client SDK, directly with database operations - in MongoDB's case, the filter objects work seamlessly with native collection methods.

In the following example, each specification represents a single business concept - "overdue expenses", "high-value transactions", "user-accessible data" - making your query logic more readable and maintainable. The real power emerges when you compose specifications together, building complex queries from simple, well-tested building blocks.

```typescript
// Generic specification pattern
type Specification<T> = {
  toFilter(): Partial<T>; // fn over constant because sometimes filters need dynamic evaluation
  describe: string;
};

// Generic functional composition
function combineSpecs<T>(...specs: Specification<T>[]): Specification<T> {
  return {
    toFilter: () =>
      specs.reduce(
        (filter, spec) => ({ ...filter, ...spec.toFilter() }),
        {} as Partial<T>
      ),
    describe: specs.map((spec) => spec.describe).join(' AND '),
  };
}

// Expense-specific implementations
type ExpenseSpecification = Specification<Expense>;

function overdueExpenseSpec(daysOverdue: number): ExpenseSpecification {
  return {
    toFilter: () => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOverdue);

      return {
        status: 'pending',
        submittedAt: { $lt: cutoffDate },
      };
    },
    describe: `expenses overdue by ${daysOverdue} days`,
  };
}

function categoryExpenseSpec(categoryId: string): ExpenseSpecification {
  const filter = { categoryId };
  return {
    toFilter: () => filter,
    describe: `expenses in category ${categoryId}`,
  };
}

function highValueExpenseSpec(minAmount: number): ExpenseSpecification {
  const filter = { totalClaim: { $gte: minAmount } };
  return {
    toFilter: () => filter,
    describe: `expenses above ${minAmount}`,
  };
}

// Usage functions
async function findExpensesBySpec(
  deps: { find: FindExpenses },
  spec: ExpenseSpecification
) {
  return await deps.find(spec.toFilter());
}

async function countExpensesBySpec(
  deps: { count: CountExpenses },
  spec: ExpenseSpecification
) {
  return await deps.count(spec.toFilter());
}

// Example usage showing functional composition power
function createOverdueTravelExpensesAboveSpec(minAmount: number) {
  return combineSpecs(
    overdueExpenseSpec(30),
    categoryExpenseSpec('travel'),
    highValueExpenseSpec(minAmount)
  );
}

const expensiveTravel = await findExpensesBySpec(
  deps,
  createOverdueTravelExpensesAboveSpec(500)
);
const veryExpensiveTravel = await findExpensesBySpec(
  deps,
  createOverdueTravelExpensesAboveSpec(1000)
);
```

**Advanced specification complexity:** Specification factories can become arbitrarily complex when business requirements demand it. They might reach out to external systems asynchronously to collect all necessary data for building the specification - feature flags, A/B testing configurations, current user permissions, or dynamic business rules. For example, a specification might query a configuration service to determine which fields are accessible to the current user's role, or check experiment settings to decide between different filtering strategies.

Specifications can also maintain internal state that evolves with each `toFilter()` invocation. Examples include rate-limiting counters that progressively tighten filters as system load increases, statistical sampling that rotates through different subsets of data, or query performance tracking that adapts filtering strategies based on execution metrics. However, this stateful approach should be used sparingly as it makes specifications less predictable and harder to test.

The key principle is to contain complexity and include only logic that is truly immanent to the query specification itself. External concerns like user authentication, system configuration, or performance monitoring often belong in separate layers rather than being embedded within specification factories. Keep specifications focused on expressing business query logic rather than orchestrating complex system interactions.

**Abstraction considerations:** Injecting functions like `findExpensesBySpec` into business logic doesn't provide much more abstraction than injecting the raw `find` function directly. Business logic can still construct arbitrary specifications on-the-fly, meaning it remains tightly coupled to query implementation details - just through the specification interface rather than raw filters. This creates an illusion of abstraction without the actual benefits.

To achieve true decoupling, consider wrapping specific specification usage in named query functions: `findOverdueExpenses()`, `findHighValueExpenses()`, etc. Alternatively, provide registries or factories with semantic names rather than exposing specification construction directly.

**Restricting specification access and the bypass problem:** However, these approaches have a fundamental flaw. Even with registries, factories, and interface segregation to limit access to sensitive specifications, business logic can still construct ad-hoc specifications and pass them to `findExpensesBySpec`, completely undermining any access control:

```typescript
// Business logic can still bypass all restrictions:
const rogueSpec: ExpenseSpecification = {
  toFilter: () => ({ status: 'pending', secretField: true }),
  describe: 'unauthorized query',
};
const result = await findExpensesBySpec(deps, rogueSpec); // Works!
```

The key insight is that we need to make it impossible (not just inconvenient) for business logic to create arbitrary specifications. TypeScript's branded types provide exactly this capability - we can mark approved specifications with a unique symbol that only controlled factory functions can add. This prevents business logic from constructing specification objects directly while maintaining full parameterization flexibility.

```typescript
// Create a unique symbol for marking approved specs
const APPROVED_SPEC = Symbol('approved-specification');

type ApprovedSpecification<T> = Specification<T> & {
  readonly [APPROVED_SPEC]: true;
};

// Internal factory - NOT exported to business logic
function createApprovedSpec<T>(
  spec: Specification<T>
): ApprovedSpecification<T> {
  return { ...spec, [APPROVED_SPEC]: true as const };
}

// Only accept approved specs
async function findExpensesByApprovedSpec(
  deps: { find: FindExpenses },
  spec: ApprovedSpecification<Expense>
) {
  return await deps.find(spec.toFilter());
}

// Controlled factory that business logic CAN access
export const approvedExpenseSpecs = {
  overdue: (days: number) => createApprovedSpec(overdueExpenseSpec(days)),
  category: (categoryId: string) =>
    createApprovedSpec(categoryExpenseSpec(categoryId)),
} as const;

// Business logic cannot create approved specs directly
const rogueSpec = { toFilter: () => ({}), describe: 'hack' }; // ❌ Missing brand
const rogueApproved = createApprovedSpec(rogueSpec); // ❌ createApprovedSpec not exported!
const validSpec = approvedExpenseSpecs.overdue(30); // ✅ Only way to get approved spec
```

**Consider the trade-offs:** While branded specifications provide bulletproof access control, this level of complexity might not always be justified. Clear code review practices and team conventions can often ensure proper abstraction boundaries without TypeScript ceremony. A simpler alternative is avoiding `findBySpec` exposure altogether - wrap specification usage in named query functions like `findOverdueExpenses()` instead. This adds another layer of indirection but achieves similar abstraction benefits with conventional patterns most teams already understand.

#### Repository Extension

Another approach is extending your repository with domain-specific methods:

```typescript
function createExtendedExpenseRepo(baseRepo: ExpenseRepo) {
  return {
    ...baseRepo,

    async findOverdueExpenses(daysOverdue: number) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOverdue);

      return await baseRepo.find({
        status: 'pending',
        submittedAt: { $lt: cutoffDate },
      });
    },

    async findExpensesByDateRange(startDate: Date, endDate: Date) {
      return await baseRepo.find({
        submittedAt: { $gte: startDate, $lte: endDate },
      });
    },

    async findPendingExpensesAboveAmount(amount: number) {
      return await baseRepo.find({
        status: 'pending',
        totalClaim: { $gte: amount },
      });
    },
  };
}
```

#### Choosing Your Approach

Choose direct query injection when:

- Simple queries - basic filters that are unlikely to change
- One-off operations - queries used in only one place
- Rapid prototyping - speed of development is more important than abstraction
- Exploratory work - you're still discovering the right query patterns
- Small teams - less coordination overhead for query changes

Choose query wrapping when:

- Complex query logic - multi-step filters, date calculations, or business rules
- Reused patterns - the same query appears in multiple places
- Business-critical queries - operations that need careful testing and validation
- Evolving requirements - queries likely to change as business rules evolve
- Large teams - multiple developers need to use the same query patterns
- Testing isolation - you want to test business logic independently of query structure

Don't feel constrained to choose one pattern universally. Consider mixing approaches based on the complexity and usage patterns of different queries - use direct injection for simple lookups and choose the more advanced patterns for complex, reusable operations within the same application.

If you start with direct query injection and later need more abstraction, identify patterns in your codebase and extract incrementally, starting with the most complex or frequently used queries. Maintain backwards compatibility and migrate gradually. The key insight is that abstraction should earn its keep - wrap queries when they provide real value through reusability, testability, or reduced complexity, not just because you can. Premature abstraction can be just as problematic as inadequate abstraction, so start simple, identify patterns, and abstract when the value is clear.

## Putting It All Together

The patterns discussed so far - repository factories, specialized data access functions, client-side stored procedures, and query abstractions - work best when integrated into a cohesive data access architecture. Most business applications follow predictable patterns that create natural integration points for data access.

### HTTP Request Handlers

HTTP request handlers follow a consistent structure, but the approach evolves based on complexity.

**Simple case** - no authorization, direct business logic:

```typescript
async function handleSimpleExpenseUpdate(req: Request, res: Response) {
  // 1. Validate payload and extract context
  const { organizationId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const logger = createLogger(req);

  // 2. Instantiate data access and call business logic
  const dataAccess = createDataAccess({ organizationId, logger });
  const result = await updateExpenseWorkflow(expenseData, {
    updateExpense: dataAccess.expenses.repo.update,
    recalculateTrip: dataAccess.trips.recalculateTotals,
  });

  res.json(result);
}
```

**With authorization** - reveals data access duplication issues:

```typescript
async function handleExpenseUpdateWithAuth(req: Request, res: Response) {
  const { organizationId, userId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const logger = createLogger(req);
  const dataAccess = createDataAccess({ organizationId, logger });

  // Problem: Authorization needs expense data
  await checkCanWriteExpense(userId, expenseData.expenseId, {
    getExpenseById: dataAccess.expenses.getExpenseById, // Fetch #1
  });

  // Problem: Business logic may also need the same expense data
  const result = await updateExpenseWorkflow(expenseData, {
    getExpenseById: dataAccess.expenses.getExpenseById, // Potential fetch #2
    updateExpense: dataAccess.expenses.repo.update,
    recalculateTrip: dataAccess.trips.recalculateTotals,
  });

  res.json(result);
}
```

Furthermore, the approach shown in the example reveals a **leaky abstraction problem**: the function `checkCanWriteExpense` receives both the data identifier (`expenseId`) and the method to fetch that data (`getExpenseById`), creating awkward coupling. The authorization function shouldn't need to know how to fetch expenses - it should work with the data directly.

**Refined approach** - strategic prefetching and mixed injection:

```typescript
async function handleExpenseUpdate(req: Request, res: Response) {
  const { organizationId, userId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const logger = createLogger(req);
  const dataAccess = createDataAccess({ organizationId, logger });

  // Strategic prefetch: Get data needed by multiple operations
  const expense =
    (await dataAccess.expenses.getExpenseById(expenseData.expenseId)) ??
    throwNotFound();

  // Clean authorization: Pass actual data, not data access
  await checkCanWriteExpense(userId, expense);

  // Business logic: Mix prefetched data with data access methods
  const result = await updateExpenseWorkflow(expenseData, expense, {
    updateExpense: dataAccess.expenses.repo.update,
    recalculateTrip: dataAccess.trips.recalculateTotals,
    getUserPreferences: dataAccess.users.getPreferences, // Only when needed
  });

  res.json(result);
}
```

The evolution shows key trade-offs: **pure dependency injection** (middle example) keeps functions testable but can cause data duplication, while **strategic prefetching** (final example) optimizes performance but couples the handler to specific data needs. Apply what makes sense - prefetch data at the handler level when multiple operations need the same entities, and inject data access methods for operations that need fresh or different data.

Alternative approaches like **internal caching** in the data access factory can solve duplication transparently, but introduce implicit behavior and potential side-effects that may not be obvious to all developers. The explicit prefetching approach trades some handler complexity for predictable, transparent behavior.

### Background Jobs and Scripts

Background jobs, scripts, and other operational tasks typically have simpler authorization requirements but often need more complex data coordination:

**Simple batch processing:**

```typescript
async function runMigrationJob(organizationId: string) {
  const logger = createJobLogger();
  const dataAccess = createDataAccess({ organizationId, logger });

  // Client-side stored procedure handles complex workflow
  await dataAccess.bulk.migrateExpenseCategories({
    batchSize: 1000,
    dryRun: false,
  });
}
```

**Transaction-heavy operations** require coordinated data access:

```typescript
async function processComplexUpdate(updateData: any) {
  const dataAccess = createDataAccess(baseContext);

  await dataAccess.expenses.repo.runTransaction(async (session) => {
    const txDataAccess = createDataAccess({ ...baseContext, session });

    // Multiple operations coordinated within transaction
    await coordinatedBusinessLogic(updateData, txDataAccess);
  });
}
```

**Mixed approach** for complex operational workflows:

```typescript
async function reconcileExpenseData(organizationId: string) {
  const logger = createJobLogger();
  const dataAccess = createDataAccess({ organizationId, logger });

  // Prefetch organizational configuration
  const orgConfig = await dataAccess.organizations.getConfiguration();

  // Process in transaction-aware batches
  await dataAccess.expenses.repo.runTransaction(async (session) => {
    const txDataAccess = createDataAccess({ organizationId, logger, session });

    await reconcileExpenseWorkflow(orgConfig, {
      findInconsistentExpenses: txDataAccess.expenses.findInconsistent,
      updateExpenseStatus: txDataAccess.expenses.repo.update,
      createAuditLog: txDataAccess.audit.logReconciliation,
    });
  });
}
```

This consistent pattern - _instantiate data access, inject specific methods into business logic_ - creates a natural place to organize all the patterns we've discussed.

The question becomes: how do we structure that data access instantiation to scale across multiple domains, teams, and usage contexts?

### Architectural Approaches

Two main approaches emerge for organizing data access at scale:

#### The Unified Data Access Factory

For applications where consistency and convenience are priorities, a single comprehensive factory provides all data access capabilities through one interface:

```typescript
// data-access.ts - unified interface
export type GetDataAccess = (context: DataAccessContext) => DataAccess;

export type DataAccessContext = {
  organizationId: string;
  userId?: string;
  logger: Logger;
  session?: ClientSession;
};

export type DataAccess = {
  expenses: {
    // Repository access
    repo: ExpenseRepo;

    // Named query functions (specialized data access)
    getExpensesById: (
      ids: string[]
    ) => Promise<{ expenses: Expense[]; notFoundIds: string[] }>;
    getByTripId: (tripId: string) => Promise<Expense[]>;
    queryExpenses: QueryExpenses;

    // Client-side stored procedures
    processReceiptDigitization: ProcessReceiptDigitization;
    markTopExpensesByCategory: MarkTopExpensesByCategory;
    finalizeExpenseReimbursement: FinalizeExpenseReimbursement;

    // Sub-domain organization
    tags: {
      repo: TagRepo;
      getActiveTagsByDimension: GetActiveTagsByDimension;
      createLocationTagsFromExpenses: CreateLocationTagsFromExpenses;
    };

    perDiem: {
      repo: PerDiemRepo;
      computeHistoricRates: ComputeHistoricRates;
      updateTaxabilityFromRateChanges: UpdateTaxabilityFromRateChanges;
    };
  };

  trips: {
    repo: TripRepo;
    getTripWithExpenseSummary: GetTripWithExpenseSummary;
    linkExpensesToTrip: LinkExpensesToTrip;
    generateAutomaticExpenses: GenerateAutomaticExpenses;
  };

  users: {
    repo: UserRepo;
    getUserRecentPreferences: GetUserRecentPreferences;
    updateUserExpenseSettings: UpdateUserExpenseSettings;
  };

  // Cross-cutting operations using multiple repositories
  bulk: {
    deleteAllOrganizationData: DeleteAllOrganizationData;
    migrateExpenseCategories: MigrateExpenseCategories;
  };
};
```

The factory implementation organizes all repositories and functions:

```typescript
// data-access-factory.ts
export function createDataAccess(context: DataAccessContext): DataAccess {
  const { organizationId, userId, logger, session } = context;

  // Create base repositories with shared configuration
  const mongoClient = getMongoClient();
  const scope = { organizationId };
  const options = {
    traceTimestamps: true,
    softDelete: true,
    version: true,
    session,
  };

  // Repository factories
  const expenseRepo = createExpenseRepo(mongoClient, scope, options);
  const tripRepo = createTripRepo(mongoClient, scope, options);
  const userRepo = createUserRepo(mongoClient, scope, options);
  const tagRepo = createTagRepo(mongoClient, scope, options);
  const perDiemRepo = createPerDiemRepo(mongoClient, scope, options);

  return {
    expenses: {
      repo: expenseRepo,

      // Named queries using specifications and projections
      getExpensesById: createGetExpensesById(expenseRepo),
      getByTripId: createGetByTripId(expenseRepo),
      queryExpenses: createQueryExpenses(expenseRepo, userRepo),

      // Client-side stored procedures
      processReceiptDigitization: createProcessReceiptDigitization({
        expenseRepo,
        tagRepo,
        logger,
      }),
      markTopExpensesByCategory: createMarkTopExpensesByCategory({
        expenseRepo,
        logger,
      }),
      finalizeExpenseReimbursement: createFinalizeExpenseReimbursement({
        expenseRepo,
        userRepo,
        logger,
      }),

      tags: {
        repo: tagRepo,
        getActiveTagsByDimension: createGetActiveTagsByDimension(tagRepo),
        createLocationTagsFromExpenses: createLocationTagsFromExpenses({
          tagRepo,
          expenseRepo,
          logger,
        }),
      },

      perDiem: {
        repo: perDiemRepo,
        computeHistoricRates: createComputeHistoricRates(
          perDiemRepo,
          expenseRepo
        ),
        updateTaxabilityFromRateChanges: createUpdateTaxabilityFromRateChanges({
          perDiemRepo,
          expenseRepo,
          logger,
        }),
      },
    },

    trips: {
      repo: tripRepo,
      getTripWithExpenseSummary: createGetTripWithExpenseSummary(
        tripRepo,
        expenseRepo
      ),
      linkExpensesToTrip: createLinkExpensesToTrip(tripRepo, expenseRepo),
      generateAutomaticExpenses: createGenerateAutomaticExpenses({
        tripRepo,
        expenseRepo,
        perDiemRepo,
        logger,
      }),
    },

    users: {
      repo: userRepo,
      getUserRecentPreferences: createGetUserRecentPreferences(
        userRepo,
        expenseRepo
      ),
      updateUserExpenseSettings: createUpdateUserExpenseSettings(
        userRepo,
        logger
      ),
    },

    bulk: {
      deleteAllOrganizationData: createDeleteAllOrganizationData({
        expenseRepo,
        tripRepo,
        tagRepo,
        logger,
      }),
      migrateExpenseCategories: createMigrateExpenseCategories({
        expenseRepo,
        tagRepo,
        logger,
      }),
    },
  };
}

// Convenience factory-factory for common usage patterns
export function createDataAccessForRequest(
  organizationId: string,
  logger: Logger
): GetDataAccess {
  return (context) =>
    createDataAccess({
      ...context,
      organizationId,
      logger,
    });
}
```

### Modular Theme-Oriented Factories

For larger applications or teams, breaking the monolithic factory into focused, domain-specific modules can improve maintainability and team ownership:

```typescript
// expense-data-access.ts
export type ExpenseDataAccess = {
  repo: ExpenseRepo;
  getExpensesById: GetExpensesById;
  queryExpenses: QueryExpenses;
  processReceiptDigitization: ProcessReceiptDigitization;
  finalizeReimbursement: FinalizeReimbursement;
  tags: TagDataAccess;
  perDiem: PerDiemDataAccess;
};

export function createExpenseDataAccess(
  context: DataAccessContext
): ExpenseDataAccess {
  // Implementation similar to the unified factory but focused on expenses
}

// trip-data-access.ts
export type TripDataAccess = {
  repo: TripRepo;
  getTripWithSummary: GetTripWithSummary;
  linkExpensesToTrip: LinkExpensesToTrip;
  generateAutomaticExpenses: GenerateAutomaticExpenses;
};

export function createTripDataAccess(
  context: DataAccessContext
): TripDataAccess {
  // Implementation focused on trips
}

// Composite factory for applications that need everything
export type ComprehensiveDataAccess = {
  expenses: ExpenseDataAccess;
  trips: TripDataAccess;
  users: UserDataAccess;
  cross: CrossDomainDataAccess;
};

export function createComprehensiveDataAccess(
  context: DataAccessContext
): ComprehensiveDataAccess {
  return {
    expenses: createExpenseDataAccess(context),
    trips: createTripDataAccess(context),
    users: createUserDataAccess(context),
    cross: createCrossDomainDataAccess(context),
  };
}
```

### Practical Usage Patterns

Both approaches support common application patterns:

```typescript
// HTTP request handler
async function handleExpenseCreation(req: Request, res: Response) {
  const { organizationId, userId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const logger = createLogger(req);

  // Unified approach
  const dataAccess = createDataAccess({ organizationId, userId, logger });

  // Business logic gets clean, focused interface
  const result = await processExpenseCreation(expenseData, {
    createExpense: dataAccess.expenses.repo.create,
    linkToTrip: dataAccess.trips.linkExpensesToTrip,
    updateUserPreferences: dataAccess.users.updateUserExpenseSettings,
  });

  res.json(result);
}

// Background job / script
async function runExpenseReprocessingJob(organizationId: string) {
  const logger = createJobLogger();
  const dataAccess = createDataAccess({ organizationId, logger });

  // Client-side stored procedure handles the complex workflow
  await dataAccess.expenses.processReceiptDigitization({
    batchSize: 100,
    retryFailures: true,
  });
}

// Transaction-aware operations
async function handleComplexExpenseUpdate(expenseId: string, updateData: any) {
  const logger = createLogger();
  const baseDataAccess = createDataAccess({ organizationId, logger });

  await baseDataAccess.expenses.repo.runTransaction(async (session) => {
    // Create transaction-aware data access
    const txDataAccess = createDataAccess({ organizationId, logger, session });

    // All operations participate in the transaction
    await updateExpenseWithValidation(expenseId, updateData, {
      updateExpense: txDataAccess.expenses.repo.update,
      recalculateTrip: txDataAccess.trips.recalculateTripTotals,
      updateUserStats: txDataAccess.users.updateExpenseStatistics,
    });
  });
}
```

### Choosing Your Data Access Architecture

**Choose the unified factory when**:

- Working in a request-response pattern (HTTP handlers, serverless functions)
- Need consistent configuration across all data access operations
- Want a single point of dependency injection and testing
- Team size is manageable and domains are closely related
- Cross-domain operations are common

**Choose modular factories when**:

- Large teams with clear domain ownership
- Independent deployment or development of different domains
- Different configuration needs per domain (different databases, external services)
- Want to limit dependency scope and reduce coupling
- Building towards a microservices architecture

**Handling the "God Class" Problem**:

Even with a unified factory, avoid the god class antipattern by:

- **Extract implementation modules**: Keep the interface unified but implement each domain in separate files
- **Use composition**: Build the factory by composing smaller, focused factory functions
- **Lazy initialization**: Only create repositories and functions when first accessed
- **Clear boundaries**: Use TypeScript interfaces to enforce separation between domains
- **Separate concerns**: Keep external service access (APIs, file systems) in separate modules from database access

**External Services Consideration**:

The question of whether external services (like mapping APIs, email services) belong in data access factories depends on your architecture goals. Consider separating them into distinct "service access" factories if they have different lifecycle, configuration, or error handling requirements than database operations.

Both architectures benefit from the same core principles: dependency injection, explicit contracts, composable functions, and clear separation of concerns. Choose the approach that matches your team structure, application complexity, and long-term architectural goals, and don't hesitate to evolve from one approach to another as your needs change.
