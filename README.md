# SmartRepo

- [What the Heck is SmartRepo?](#what-the-heck-is-smartrepo)
- [A Quick Glimpse](#a-quick-glimpse)
- [Why SmartRepo?](#why-smartrepo)
  - [The Problem with Traditional ORMs](#the-problem-with-traditional-orms)
  - [SmartRepo's Philosophy and Approach](#smartrepos-philosophy-and-approach)
- [API Reference Core CRUD Operations (SmartRepo interface)](#api-reference-core-crud-operations-smartrepo-interface)
  - [getById](#getbyid) - [getByIds](#getbyids)
  - [create](#create) - [createMany](#createmany)
  - [update](#update) - [updateMany](#updatemany)
  - [delete](#delete) - [deleteMany](#deletemany)
  - [find](#find) - [findBySpec](#findbyspec)
  - [count](#count) - [countBySpec](#countbyspec)
- [MongoDB Implementation](#mongodb-implementation)
  - [createSmartMongoRepo](#createsmartmongorepo)
  - [withSession](#withsession)
  - [runTransaction](#runtransaction)
  - [collection](#collection)
  - [applyConstraints](#applyconstraints)
  - [buildUpdateOperation](#buildupdateoperation)
  - [When you need upsert](#when-you-need-upsert)
- [Firestore Implementation](#firestore-implementation)
  - [Design assumptions](#design-assumptions)
  - [Repository instantiation (scoped collection)](#repository-instantiation-scoped-collection)
  - [Operation semantics](#operation-semantics)
  - [Indexing notes](#indexing-notes)
  - [Differences vs. MongoDB](#differences-vs-mongodb)
- [Recommended Usage Patterns](#recommended-usage-patterns)
  - [Repository Factories](#repository-factories)
  - [Export Repository Types](#export-repository-types)
  - [Always Use Helper Methods for Direct Collection Operations](#always-use-helper-methods-for-direct-collection-operations)
  - [Audit Trail Strategies with Tracing](#audit-trail-strategies-with-tracing)
- [Decoupling Business Logic from Data Access](#decoupling-business-logic-from-data-access)
  - [Scope: Database Operations and Beyond](#scope-database-operations-and-beyond)
  - [Explicit Dependencies](#explicit-dependencies)
  - [Sandwich Method](#sandwich-method)
  - [Specialized Data Access Functions](#specialized-data-access-functions)
  - [Data Access Adapters](#data-access-adapters)
  - [Business Logic with Transactions](#business-logic-with-transactions)
  - [Client-Side Stored Procedures](#client-side-stored-procedures)
  - [Query Abstraction Patterns](#query-abstraction-patterns)
- [A Factory to Rule Them All?](#a-factory-to-rule-them-all)
  - [What Belongs in a Data Access Factory?](#what-belongs-in-a-data-access-factory)
  - [The Unified Data Access Factory](#the-unified-data-access-factory)
  - [Modular Theme-Oriented Factories](#modular-theme-oriented-factories)
  - [Choosing a Factory Approach](#choosing-a-factory-approach)
  - [Data Access Adapters in Factories](#data-access-adapters-in-factories)
- [Application-Level Integration](#application-level-integration)
  - [HTTP Request Handlers](#http-request-handlers)
  - [Background Jobs and Scripts](#background-jobs-and-scripts)

---

## What the Heck is SmartRepo?

SmartRepo is a lightweight, database-agnostic interface that provides common CRUD operations with built-in consistency features, designed to work seamlessly alongside native database access. It currently supports MongoDB and Firestore implementations.

**Consistency features** are patterns that most applications need but typically implement inconsistently: automatic timestamps (createdAt, updatedAt), versioning for optimistic locking, soft-delete functionality, and audit trails. Rather than manually adding these to every operation, SmartRepo applies them automatically while still allowing native database access for complex queries and operations.

SmartRepo emerged from experience with DocumentService (Yokoy's internal ODM for Firestore and later MongoDB) and then moving to pure native database access. Both approaches have their pros and cons: ODMs provide convenience but limit functionality, while native access offers full power but requires repetitive boilerplate. SmartRepo occupies a middle ground: more convenience than pure native drivers, but significantly less abstraction than traditional ORMs. It's designed for teams who understand their database technology and want to use it effectively without losing access to advanced features.

For a deeper understanding of the problems this approach solves, see the [Why SmartRepo?](#why-smartrepo) section.

## A Quick Glimpse

SmartRepo implements the repository pattern: a collection-like interface for accessing and manipulating domain objects. Each repository is bound to a specific database collection and organizational scope, providing type-safe CRUD operations that reduce boilerplate while working seamlessly alongside native database access for complex operations.

Creating a repository instance:

```typescript
const expenseRepo = createSmartMongoRepo({
  collection: mongoClient.db('expenseDb').collection<Expense>('expenses'),
  mongoClient,
  scope: { organizationId: 'acme-123' }, // applied to all reads and writes
});

// better to have a factory enforcing constraints and encapsulating db/collection names
function createExpenseRepo(client: MongoClient, organizationId: string) {
  return createSmartMongoRepo({
    collection: client.db('expenseDb').collection<Expense>('expenses'),
    mongoClient: client,
    scope: { organizationId },
  });
}
```

A `SmartRepo` instance implements a set of basic, DB-agnostic CRUD operations:

```typescript
const repo = createExpenseRepo(mongoClient, 'acme-123');

const id = await repo.create(expenseFromImport());

await repo.update(id, { set: { totalClaim: 42 }, unset: 'attachments' });

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

Due to their DB-specific nature, the repository functions supporting native operations are not part of the DB-agnostic `SmartRepo`
interface. A future Firestore implementation may provide such helpers in a different fashion.
Hiding scope filters may seem trivial and not worth the effort of encapsulating them in the repository instance. The value
of this encapsulation will hopefully become more apparent when we look at [consistency features](#options) that no one really likes to reimplement
again and again.

You may have noticed that SmartRepo's CRUD operations borrow a lot from MongoDB's client API (for example,
updates with set/unset, variants with bulk support, filter syntax).
This is no coincidence as the MongoDB API is considered very clean in that regard, and should also work well with other DB implementations.

!! consider moving somewhere else
Finally, if you've been using `DocumentService` for most of your data access, you might wonder what a migration path to `SmartRepo` would look like. You're probably thinking it's quite an effort since you've injected `DocumentService` instances all over the place and the interfaces aren't compatible. That's correct, and the "Recommended Usage Patterns" section explains why we think that injecting repository instances everywhere isn't a good idea in the first place.

## Why SmartRepo?

It's fair to ask: "Why create another database abstraction library when so many already exist?" This question deserves a thoughtful response, especially given the abundance of ORMs (Object-Relational Mappers) and ODMs (Object-Document Mappers - we'll use "ORM" to refer to both throughout this section) in the Node.js ecosystem.

### The Problem with Traditional ORMs

Most existing database abstraction libraries follow the traditional ORM approach: comprehensive abstractions that aim to hide database complexity entirely while providing extensive convenience features. Popular solutions like [Mongoose](https://mongoosejs.com/), [Prisma](https://www.prisma.io/orm), [TypeORM](https://typeorm.io/), and [MikroORM](https://mikro-orm.io/) each offer rich feature sets including schema validation, relationship mapping, query builders, and code generation.

The ORM value proposition is compelling: translate "complex" database operations into familiar object-oriented patterns while providing developer-friendly conveniences like type safety, schema validation, and query builders. The goal is to make data access concerns blend seamlessly with application code.

However, this approach introduces several fundamental challenges:

- **Impedance mismatch**: Structural and conceptual differences between relational/document databases and object-oriented programming models create ongoing friction
- **Feature coverage gaps**: Not every database feature is supported, forcing compromises that are often overlooked by developers without deep database knowledge
- **Performance bottlenecks**: The N+1 problem, inefficient query generation, and excessive roundtrips frequently require bypassing the ORM for performance-critical operations
- **Additional complexity**: Another abstraction layer to learn and debug, especially problematic when native database features are eventually needed anyway

These challenges are well-documented in the development community. Ted Neward famously called the ["Object-Relational Impedance Mismatch"](https://blog.codinghorror.com/object-relational-mapping-is-the-vietnam-of-computer-science/) the "Vietnam War of Computer Science" (original article [here](https://www.odbms.org/wp-content/uploads/2013/11/031.01-Neward-The-Vietnam-of-Computer-Science-June-2006.pdf)). The [N+1 query problem](https://stackoverflow.com/questions/97197/what-is-the-n1-selects-problem-in-orm-object-relational-mapping) remains a persistent issue across all major ORMs, and developers frequently discuss [when to bypass ORM abstractions](https://www.google.com/search?q=when+to+bypass+ORMs+and+ODMs) for performance-critical operations.

This raises a fundamental question: Why add another abstraction layer when native database clients and query languages are already excellent, well-designed APIs? Modern database drivers provide clean interfaces, comprehensive feature coverage, excellent documentation, and active maintenance. For experienced developers who understand their database technology, ORM abstractions often become unnecessary overhead rather than genuine value - another layer to learn, debug, and work around.

### SmartRepo's Philosophy and Approach

SmartRepo emerged from a fundamentally different perspective: start with native database access, then identify and solve only the repetitive patterns that naturally arise. Rather than hiding database complexity, SmartRepo embraces it while addressing genuine pain points developers face with pure native access.

**Core principles:**

- **Native Access First**: Direct database operations are the primary interface, not an "escape hatch." SmartRepo provides helpers that enhance native access rather than replacing it
- **Minimal, Focused Abstraction**: Only the most common operations (basic CRUD) get convenience methods. Complex operations use native database features with optional consistency helpers
- **Automatic Multi-tenancy**: Built-in scoping eliminates the repetitive, error-prone task of manually adding tenant filters to every query
- **Optional Consistency**: Instead of forcing rigid schemas, SmartRepo provides optional consistency guarantees (timestamps, versioning, soft-delete, audit trails) that work with native operations

SmartRepo follows the tradition of MicroORMs like [Dapper](https://github.com/DapperLib/Dapper), [Massive](https://github.com/robconery/massive-js/), and [PetaPoco](https://github.com/CollaboratingPlatypus/PetaPoco). These tools emerged as a response to full ORM complexity, providing just enough abstraction to eliminate boilerplate while working seamlessly alongside direct database access. SmartRepo is exactly such a tool for document databases.

**What SmartRepo deliberately avoids:**

SmartRepo doesn't try to replace your database knowledge with abstractions. Instead of hiding MongoDB's aggregation framework behind query builders, it encourages direct usage while providing consistency helpers. It doesn't attempt database-agnostic complex operations (which either reduce functionality to the lowest common denominator or leak database-specific features anyway). And it doesn't manage schemas or relationships - document databases excel at flexible schemas and embedded data, so SmartRepo works with this paradigm rather than forcing relational patterns.

**Bottom-up design from real patterns:**

This approach emerged organically from observing teams repeatedly writing the same basic CRUD operations, inconsistently applying timestamps and audit trails, and struggling with tightly coupled business logic. SmartRepo codifies these proven patterns while working alongside direct database access. The extensive architectural guidance in the second part of this document then shows how to integrate tools like SmartRepo effectively into application architecture and business logic - patterns that evolved from practical necessity, not theoretical design.

## API Reference Core CRUD Operations (SmartRepo interface)

The operations listed here resemble the full set of DB-agnostic functions in a SmartRepo. At time of writing only the MongoDB implementation existed. So some descriptions might mention some characteristics specific to MongoDB. However, the interface is designed to
be as simple as possible to allow being implemented for other DBs, particularly Firestore.

**Note 1**: In the function signatures below, `T` represents the entity type, `UpdateInput` represents the subset of `T` that can be modified via updates (excluding managed fields), and `CreateInput` represents the input shape for creating entities (includes optional managed fields). Managed fields include system fields (id, timestamps, version, soft-delete markers) and scope fields.

**Note 2**: All read functions support projections. A projection is given in the form `{ propA: true, propB: true }` where `propA` and `propB` are valid properties in `T`. A projection is properly reflected in the return type.

!! TODO - rephrase / clarify
**Note 3**: Scope filtering and other consistence features are not part of this interface as they are basically repository options that get only mentioned during instantiation. However, they might be mentioned in the function descriptions describing the intended behavior as part of the interface contract any implemention must adhere to.

#### Input Type Distinction

SmartRepo uses distinct input types for different operations to provide compile-time safety:

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

This method is not all-or-nothing. Some entities may be inserted, some updated, and others may fail due to unique constraints or scope rules. For atomicity across entities, wrap the call in a transaction using `runTransaction`.

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
- `orderBy?: Record<string, 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'>` - Sort results

**Usage Examples:**

```typescript
// Stream processing
for await (const user of repo.find({ status: 'active' })) {
  console.log(user.name);
}

// Convert to array
const users = await repo.find({ status: 'active' }).toArray();

// Chain operations
const result = await repo.find({ status: 'active' })
  .skip(10)
  .take(5)
  .toArray();

// With ordering
const orderedUsers = await repo.find({}, { orderBy: { name: 'asc' } }).toArray();
```

### findBySpec

`findBySpec<S extends Specification<T>>(spec: S, options?: { onScopeBreach?: 'empty' | 'error' }): Promise<T[]>`

`findBySpec<S extends Specification<T>, P extends Projection<T>>(spec: S, options: { projection: P; onScopeBreach?: 'empty' | 'error' }): Promise<Projected<T, P>[]>`

Queries entities using a specification object that encapsulates filter criteria and business rules. The repository automatically applies scope filtering and soft delete exclusion just like `find`. Specifications provide composable, reusable query logic that can be combined using `combineSpecs`. When using the projection variant, only the specified fields are returned and the result is properly typed. See [Query Abstraction Patterns](#query-abstraction-patterns) for detailed examples and patterns.

### count

`count(filter: Partial<T>, options?: { onScopeBreach?: 'zero' | 'error' }): Promise<number>`

Returns the number of entities that match the provided filter criteria. Like `find`, the repository automatically applies scope filtering in addition to the user-provided filter, and soft-deleted entities are automatically excluded from the count if soft delete is enabled. Returns 0 if no matching entities are found.

### countBySpec

`countBySpec<S extends Specification<T>>(spec: S, options?: { onScopeBreach?: 'zero' | 'error' }): Promise<number>`

Returns the number of entities that match the provided specification. Like `count`, the repository automatically applies scope filtering and soft delete exclusion. This method works with the same specification objects used by `findBySpec`, enabling consistent query logic across find and count operations. Returns 0 if no matching entities are found.

## MongoDB Implementation

The MongoDB implementation provides additional functionality beyond the core SmartRepo interface. This includes the factory function for creating repositories, transaction support methods, and helper functions that enable direct MongoDB operations while maintaining the repository's consistency rules and scoping behavior. These MongoDB-specific features are essential for advanced use cases where the generic interface isn't sufficient, but you still want the benefits of automatic scope filtering, timestamps, and other repository features.

### createSmartMongoRepo

`createSmartMongoRepo({ collection, mongoClient, scope?, traceContext?, options? }): MongoRepo<T, Scope, Entity>`

Factory function that creates a MongoDB repository instance implementing the SmartRepo interface. Takes a MongoDB collection, client, optional scope for filtering, optional trace context for audit logging, and configuration options for consistency features like timestamps, versioning, soft delete, and tracing. The function uses TypeScript generics to ensure type safety across all repository operations. The returned repository instance provides both the DB-agnostic SmartRepo interface and additional MongoDB-specific helpers (described in the following sections) for advanced operations.

#### Scope

The `scope` parameter defines filtering criteria that are automatically applied to all repository operations. For example, passing `{ organizationId: 'acme-123' }` ensures that all reads and deletes only affect entities belonging to that organization. The scope is merged with user-provided filters and becomes part of every database operation, providing automatic multi-tenancy or data partitioning without requiring explicit filtering in each method call.

**Scope Property Handling by Operation:**

Scope fields are treated as managed fields and are automatically controlled by the repository:

- **Create/Upsert**: Scope properties can be included in entities for convenience but are validated - the operation fails if provided scope values don't match the repository's configured scope. The repository always applies its own configured scope values regardless of input.
- **Updates**: Scope properties are excluded from `UpdateInput` type and cannot be modified (compile-time and runtime protection)
- **Reads/Deletes**: Automatically filtered by scope values

```typescript
const repo = createSmartMongoRepo({
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
const repo = createSmartMongoRepo({
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
const repoNoBase = createSmartMongoRepo({ collection, mongoClient });
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
const repo = createSmartMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId: 'john' },
  // Document: { ..., _trace: { userId: 'john', _op: 'update', _at: Date } }
});

// Bounded strategy with history
const auditRepo = createSmartMongoRepo({
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
const fullHistoryRepo = createSmartMongoRepo({
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

`runTransaction<R>(operation: (txRepo: SmartRepo<T, Scope, Entity>) => Promise<R>): Promise<R>`

Convenience method that executes a function within a MongoDB transaction. Creates a new session, starts a transaction, and provides a session-aware repository instance to the operation function. The transaction is automatically committed if the operation succeeds or rolled back if an error is thrown. This is the recommended approach for most transaction scenarios as it handles all the session management automatically. The operation function receives a repository instance that maintains all the same configuration (scope, timestamps, etc.) as the original repository but operates within the transaction context.

This method is best suited for simple scenarios where the provided transaction-aware repository sufficiently covers all required functionality. The transaction is naturally limited to operations on the collection the repository operates on - for cross-collection transactions or mixing repository operations with direct MongoDB operations, use `withSession` instead.

### collection

`collection: Collection<any>`

Direct access to the underlying MongoDB collection instance. This property allows you to perform advanced MongoDB operations that aren't covered by the SmartRepo interface, such as aggregations, complex queries, bulk operations, or any other collection-level methods. When using the collection directly, you can still leverage the repository's helper methods (`applyConstraints`, `buildUpdateOperation`) to maintain consistency with the repository's configured scoping, timestamps, and versioning behavior.

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

SmartRepo does not include upsert operations to keep the core API simple and semantics clear. When you need upsert operations, use the MongoDB collection directly with these patterns while reusing repository helpers for consistency:

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
  return createSmartFirestoreRepo<User>({
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

Repository factories are also ideal for enforcing trace context to ensure gapless audit history:

```typescript
// factory that enforces trace context for audit compliance
export function createExpenseRepo(
  client: MongoClient,
  orgId: string,
  traceContext: { userId: string; requestId: string; service: string }
) {
  return createSmartMongoRepo({
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

SmartRepo's built-in tracing functionality is specifically designed for two primary audit strategies: **change stream processing** (using the "latest" trace strategy) and **embedded audit trails** (using either "bounded" or "unbounded" trace strategies). The tracing feature automatically embeds trace context into documents during write operations, making it ideal for these approaches.

This section first covers these SmartRepo-native strategies, followed by alternative approaches that implement audit logging without relying on SmartRepo's tracing feature - giving you flexibility to choose based on your specific requirements and infrastructure.

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

**Approach:** Use SmartRepo's "bounded" or "unbounded" trace strategies to maintain operation history directly within each document.

```typescript
// Bounded strategy - limited history with size control
const boundedRepo = createSmartMongoRepo({
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
const unboundedRepo = createSmartMongoRepo({
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

The following strategies implement audit logging without using SmartRepo's built-in tracing feature, offering different trade-offs for specific use cases:

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

## Decoupling Business Logic from Data Access

A fundamental principle of maintainable software design is keeping business logic independent from data access implementation. Injecting entire repository instances into business logic components creates tight coupling and obscures the actual data dependencies.

A common counterargument is that "unit testing is easy when you can just mock the entire repository with a fake implementation that works in memory." This practice is indeed widespread with `DocumentService`, where developers create `FakeDocumentService` instances for testing. However, this apparent convenience is actually a design smell that encourages poor architecture. The ease of mocking entire repositories tempts developers to inject whole repository instances in the first place, because changes to business logic data access patterns don't require signature changes - the same repository interface accommodates any new data operations. This practice also encourages passing repositories down through call chains and intermixing data access with business logic, since the repository is always readily available wherever it's needed. While this seems convenient, it actually hides evolving dependencies and makes the true data access patterns invisible at the interface level. This directly leads to over-privileged access (since the full repository is always available), unclear dependencies (since the interface doesn't reveal actual usage), and tight coupling (since business logic becomes dependent on the complete repository contract rather than specific operations).

This section presents principles for reducing coupling between data access and business logic. These are guidelines rather than rigid rules - design decisions depend on context, and the complexity of your specific problems will vary. Apply what makes sense for your situation without being overly dogmatic about it.

### Scope: Database Operations and Beyond

The architectural patterns and design principles discussed here focus primarily on **database operations** - repositories, queries, and data persistence patterns. Throughout this guide, "data access" means specifically database operations, and you could consider replacing all `DataAccess` types in the examples with `DbAccess` to make this distinction clearer. However, most of these same principles are readily transferrable to other data-providing facilities like external APIs, file systems, caching layers, etc.

When working with external services, consider organizing them into separate "service access" modules alongside your data access components. This separation maintains clear boundaries while allowing you to apply the same compositional patterns, and dependency injection approaches to both database operations and external service integrations.

Note that this guide doesn't cover caching concerns, though you might consider baking caching into some read functions to hide those implementation details from consumers. Whether to include caching at the repository level, as a separate concern, or within specific operations depends heavily on your application's specific performance requirements, cache invalidation needs, and consistency guarantees - the same contextual considerations apply to caching external service responses.

Also note that this guide doesn't explicitly reference common architectural patterns, and pattern knowledge is not necessary to follow the guidance presented. However, readers familiar with architectural patterns will recognize similarities throughout: data access adapters resemble ports in hexagonal architecture, factories align with various creational patterns, dependency injection principles are used throughout, etc. These connections emerge naturally from practical necessity rather than theoretical design.

Finally, note that all examples below use functional approaches rather than classes. Functions naturally match the statelessness of typical data processing tasks (HTTP request handlers, scripts, etc.), while classes are designed to encapsulate operations over mutable state - something rarely needed in data processing implementations. Following the convention where a function's first parameter is `deps` (dependencies) and subsequent parameters are processing inputs enables easy partial application and passing such functions around:

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

### Explicit Dependencies

As mentioned in the previous chapter's [repository type section](#export-repository-types), injecting whole repository instances creates coupling and hides actual dependencies. Instead, business logic should explicitly declare the specific data operations it needs.

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

- Over-privileged access: Function gets entire repository interface but only needs 2 methods
- Hidden dependencies: Signature doesn't reveal which data operations are actually used
- Opaque testing: Even comprehensive mocks don't clearly show which operations the function relies on

Moreover, unit tests for business logic shouldn't need comprehensive, realistic repository mocks at all. The goal is to test the _business logic_, not data access patterns. Simple data mocks that provide exactly the input data needed for each test scenario are sufficient and often preferable - they're easier to set up and understand.

This doesn't mean data access shouldn't be tested at all. On the contrary, data access is ideally tested against the database (TODO link to test section) separately.

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

For the sake of brevity, the examples below assume such utility types are defined somewhere.

### Sandwich Method

The sandwich method is an established pattern that promotes clean separation between data access and business logic by organizing operations into three distinct phases:

1. **Read**: Gather all required data upfront
2. **Process**: Execute pure business logic on the collected data
3. **Write**: Persist any changes back to storage

This approach creates a clear processing pipeline where business logic operates on plain data structures without knowledge of persistence mechanisms.
Here's a contrived example:

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

- Multi-repository operations: Coordinating data from multiple sources (`getReimbursementData` fetches from both expense and user repos)
- Domain-specific validation: Encapsulating business rules (`expense.status !== 'approved'` check)
- Complex error handling: Standardizing error responses across different failure scenarios
- Transaction coordination: Managing atomic operations across multiple repositories
- Data transformation: Converting repository results into domain-specific shapes
- Consistent patterns: Ensuring uniform approach to similar operations across your codebase

Skip adapters for:

- Simple CRUD operations: Direct repository calls like `repo.getById(id)` don't need wrapping
- Single-repository operations: When business logic only touches one repository
- 1:1 mappings: When repository methods already match your domain needs perfectly
- Read-only operations: Simple data fetching that doesn't require transformation or validation

The key principle: add adapters when they provide real value through coordination, validation, transformation, or domain-specific logic. Avoid them for simple pass-through operations where they just add indirection without benefit.

**Finding the right boundary**: Deciding what belongs in business logic versus what belongs in the adapter can be challenging. Consider `expense.status !== 'approved'` - is this a data access concern (filtering) or business logic (validation)? There's no universal answer. Generally:

- Put in adapters: Data fetching patterns, cross-repository coordination, technical constraints (`status !== 'approved'` as a data filter)
- Put in business logic: Domain rules, calculations, business decisions (`canBeReimbursed(expense, user)` as a business rule)
- Gray areas: Use your judgment based on team conventions and whether the logic is more about "how to get data" vs "what to do with data"

Don't over-optimize these boundaries initially. Start with what feels natural, and refactor when patterns emerge or testing becomes difficult.

**Note on adapter signatures**: The above example shows adapters that accept `mongoClient`, `organizationId`, and optional `session` parameters, managing repository creation internally.

- **Pros**: Self-contained, simplified transaction handling, consistent interface
- **Cons**: Less flexible for testing (harder to inject mock repositories), couples adapter to specific repository factories

For maximum testability, you might prefer injecting repositories directly and handling session management at the caller level, trading some convenience for flexibility.

### Business Logic with Transactions

When transactions are required, you can reuse specialized data access functions from the previous section. The key is to let the caller manage the transaction boundary by passing the session to the adapter:

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
            { $match: repo.applyConstraints({ currency }) },
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
            filter: repo.applyConstraints({ _id: e.expenseId }),
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

As with most architectural decisions, there's no universal answer - the choice depends on your specific context, complexity, and trade-offs. The following sections explore the patterns and decision criteria.

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

The key insight is making it impossible (not just inconvenient) for business logic to create arbitrary specifications. TypeScript's branded types provide exactly this capability - you can mark approved specifications with a unique symbol that only controlled factory functions can add. This prevents business logic from constructing specification objects directly while maintaining full parameterization flexibility.

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

## A Factory to Rule Them All?

The patterns discussed so far - repository factories, specialized data access functions, client-side stored procedures, and query abstractions - work best when integrated into a cohesive data access architecture. But this raises a fundamental question: should you create one comprehensive data access factory that provides everything, or organize things differently?

This chapter addresses the architectural decisions around data access factories: **what belongs in them**, **what doesn't**, and **how to organize them effectively**. Understanding these boundaries is crucial for keeping data access factories focused and maintainable while still enabling proper composition of complex operations.

### What Belongs in a Data Access Factory?

The data access factory should provide **reusable building blocks** (repositories, common queries, cross-cutting procedures) rather than every possible operation. One-off migrations, specialized batch jobs, and narrow-purpose procedures often don't belong in it - they can consume the factory's building blocks without being part of it.

Include in data access factory:

- Repositories and basic CRUD operations
- Reusable specialized data access functions (used across multiple contexts)
- Client-side stored procedures with broad applicability
- Cross-cutting concerns (auditing, bulk operations, common queries)

Instantiate on-demand:

- One-off migration scripts
- Job-specific batch processing logic
- Narrow-purpose procedures serving single use cases
- Operations that combine multiple domains in unique ways

Note that on-demand operations can still leverage dependency injection and testing patterns - they just don't clutter the general-purpose factory. For heavily database-focused operations, integration testing is often more valuable than unit testing anyway.

The key insight is that data access factories work best when they provide building blocks that can be composed into larger operations, rather than trying to contain every conceivable operation. This keeps the factory focused, maintainable, and prevents it from becoming an unwieldy "god object" that grows indefinitely.

### The Unified Data Access Factory

Once you've decided what belongs in your data access factory, the question becomes: how do you structure that factory to scale across multiple domains, teams, and usage contexts? Two main approaches emerge for organizing data access.

For applications where consistency and convenience are priorities, a single comprehensive factory provides all data access capabilities through one interface (simplified example):

```typescript
export type DataAccess = {
  expenses: {
    // Repository access
    repo: ExpenseRepo;

    // Named queries
    getByTrip: (tripId: string) => Promise<Expense[]>;
    getByExportSummary: (exportSummaryId: string) => Promise<Expense[]>;

    // Client-side stored procedures
    markTopExpensesByCategory: MarkTopExpensesByCategory;
    finalizeExpenseReimbursement: FinalizeExpenseReimbursement;

    // Sub-domain organization
    receipts: {
      insertReceiptExpenseAndStartTracking: InsertReceiptExpenseAndStartTracking;
      updateReceiptFromDigitizeCallback: UpdateReceiptFromDigitizeCallback;
      updateReceiptFromConversionCallback: UpdateReceiptFromConversionCallback;
    };

    perDiems: {
      getRelevantHistoricPerDiemExpenses: GetRelevantHistoricPerDiemExpenses;
      removeTaxabilityFromPerDiemExpenses: RemoveTaxabilityFromPerDiemExpenses;
      getPerDiemExpensesToBeRecomputed: GetPerDiemExpensesToBeRecomputed;
    };
  };

  trips: {
    repo: TripRepo;
    getTripWithExpenseSummary: GetTripWithExpenseSummary;
    deleteAutogeneratedTripExpenses: DeleteAutogeneratedTripExpenses;
    updateLinkedTrips: UpdateLinkedTrips;
  };

  users: {
    repo: UserRepo;
    getRecentUserPreferences: GetRecentUserPreferences;
    updateUserExpenseSettings: UpdateUserExpenseSettings;
  };

  // Operations using multiple repositories
  composite: {
    importExpensesFromCsv: ImportExpensesFromCsv;
    validateDataConsistency: ValidateDataConsistency;
    recalculateExpenseTotals: RecalculateExpenseTotals;
    syncExpenseStatusAcrossTrips: SyncExpenseStatusAcrossTrips;
  };
};
```

The corresponding factory implementation organizes all repositories and functions (shortened):

```typescript
// data-access-factory.ts
export function createDataAccess(
  deps: { mongoClient: MongoClient; logger: Logger },
  { organizationId }: { organizationId: string }
): DataAccess {
  const expenseRepo = createExpenseRepo(deps, organizationId);
  const tripRepo = createTripRepo(deps, organizationId);
  const userRepo = createUserRepo(deps, organizationId);

  return {
    expenses: {
      repo: expenseRepo,

      // Named queries
      getByTrip: createGetByTrip(expenseRepo),
      getByExportSummary: createGetByExportSummary(expenseRepo),

      // Client-side stored procedures
      markTopExpensesByCategory: createMarkTopExpensesByCategory({
        expenseRepo,
        logger,
      }),
      finalizeExpenseReimbursement: createFinalizeExpenseReimbursement({
        expenseRepo,
        userRepo,
        logger,
      }),

      receipts: {
        // these ops manage transactions internally and instantiate repos themselve
        insertReceiptExpenseAndStartTracking:
          createInsertReceiptExpenseAndStartTracking(deps, organizationId),
        updateReceiptFromDigitizeCallback:
          createUpdateReceiptFromDigitizeCallback(deps, organizationId),
        updateReceiptFromConversionCallback:
          createUpdateReceiptFromConversionCallback(deps, organizationId),
      },

      // ... other sub-domains like perDiems
    },

    trips: {
      repo: tripRepo,
      // ... trip-specific operations
    },

    users: {
      repo: userRepo,
      // ... user-specific operations
    },

    composite: {
      // ... operations across repositories and domains
    },
  };
}
```

**Whether or not to pass a transaction session to the factory** is a design choice that depends on your application's needs. The example above omits session from the factory signature since it provides client-side stored procedures that manage their own transactions internally. Including a session parameter would create inconsistent behavior where some operations use the factory's session while others manage their own, leading to confusion about transaction boundaries.

Since the main factory requires explicit dependencies and context, it's often helpful to create convenience factories that pre-configure common usage patterns. These wrapper functions encapsulate the repetitive setup for typical scenarios like HTTP requests, background scripts, or integration tests, making the data access factory easier to use across different parts of your application.

```typescript
// Convenience factory for HTTP requests
export function createDataAccessForRequest(req: express.Request): DataAccess {
  const { logger };
  return createDataAccess(
    {
      mongoClient: mongoClientSingleton(),
      logger,
    },
    validateOrgScope(req.params)
  );
}

// Convenience factory for scripts
export function createDataAccessForScript(): DataAccess {
  return createDataAccess(
    {
      mongoClient: mongoClientSingleton(),
      logger: consoleLogger(),
    },
    validateOrgScope(process.env)
  );
}

// Convenience factory for integration tests
export function createDataAccessForTest(organizationId: string): DataAccess {
  return createDataAccess(
    { mongoClient: mongoClientFromTestContainer(), logger: nullLogger() },
    { organizationId }
  );
}
```

### Modular Theme-Oriented Factories

For larger applications or teams, breaking the monolithic factory into focused, domain-specific modules can improve maintainability and team ownership:

```typescript
// expense-data-access.ts
export type ExpenseDataAccess = {
  repo: ExpenseRepo;
  getByTrip: (tripId: string) => Promise<Expense[]>;
  getByExportSummary: (exportSummaryId: string) => Promise<Expense[]>;
  markTopExpensesByCategory: MarkTopExpensesByCategory;
  finalizeExpenseReimbursement: FinalizeExpenseReimbursement;
  receipts: {
    // ...
  };
  perDiems: {
    // ...
  };
};

export function createExpenseDataAccess(
  deps: { mongoClient: MongoClient; logger: Logger },
  params: { organizationId: string }
): ExpenseDataAccess {
  // ...
}

// trip-data-access.ts
export type TripDataAccess = {
  repo: TripRepo;
  getTripWithExpenseSummary: GetTripWithExpenseSummary;
  deleteAutogeneratedTripExpenses: DeleteAutogeneratedTripExpenses;
  updateLinkedTrips: UpdateLinkedTrips;
};

export function createTripDataAccess(
  deps: { mongoClient: MongoClient; logger: Logger },
  params: { organizationId: string }
): TripDataAccess {
  // ...
}

// ... user-data-access.ts, composite-data-access.ts
```

The modular approach provides flexibility in how consumers access data operations. You can use domain-specific modules directly when working within a focused context (e.g., `createExpenseDataAccess` for expense-heavy workflows), or create a comprehensive factory that combines all modules for applications that need broad access.

```typescript
// comprehensive-data-access.ts
export type ComprehensiveDataAccess = {
  expenses: ExpenseDataAccess;
  trips: TripDataAccess;
  users: UserDataAccess;
  composite: CompositeDataAccess;
};

export function createComprehensiveDataAccess(
  deps: { mongoClient: MongoClient; logger: Logger },
  params: { organizationId: string }
): ComprehensiveDataAccess {
  // ... combines all modular factories
}
```

### Choosing a Factory Approach

The choice between unified and modular factories isn't binary - it depends on several contextual factors that often point in different directions leading to hybrid approaches providing both modular factories for focused use cases and comprehensive factories for broad access.

Domain Coverage and Deployment Architecture:

- Narrow, focused functions (single-purpose cloud functions, microservices) often benefit from modular factories that include only what they need
- Comprehensive services (monoliths, modular monoliths, complex APIs serving multiple domains) lean toward unified factories for consistency and convenience
- Shared data access libraries serving multiple deployment units may provide both approaches - modular factories for specific consumers and comprehensive factories for broad usage

Team Structure and Ownership:

- Single team or closely collaborating teams can use unified factories effectively
- Multiple teams with clear domain boundaries benefit from modular factories with independent ownership
- Mixed scenarios (some shared domains, some team-specific) often use hybrid approaches

Practical Considerations:

- Cross-domain operations frequency - common cross-domain workflows favor unified approaches
- Configuration complexity - different per-domain needs (databases, external services) push toward modularity
- Testing and dependency injection preferences may favor one approach over another

Avoiding the "God Class" Problem:

The modular approach naturally helps avoid the god class antipattern that can plague unified factories. By breaking functionality into focused, domain-specific modules, you get clear boundaries and separation of concerns. However, even if you prefer a unified interface, you can still apply internal modular organization:

- Extract implementation modules: Keep the unified interface but implement each domain in separate files
- Use composition: Build the factory by composing smaller, focused factory functions
- Establish clear boundaries: Use TypeScript interfaces to enforce separation between domains
- Separate concerns: Keep external service access (APIs, file systems) in distinct modules from database operations

This way, you can have the convenience of a single entry point while maintaining the organizational benefits of modular design internally. Additionally, lazy initialization can help manage resource usage by only creating repositories and functions when first accessed, which is particularly useful for large unified factories.

### Data Access Adapters in Factories

The [data access adapters](#data-access-adapters) discussed earlier that are used across multiple contexts (HTTP handlers, background jobs, different business workflows) are also candidates for inclusion in factories (regardless of unified or modular). Factories already manage the underlying repositories they depend on, and adapters often coordinate multiple repositories making them perfect for lazy creation.

A simple example:

```typescript
export type DataAccess = {
  expenses: { repo: ExpenseRepo /* ... */ };
  trips: { repo: TripRepo /* ... */ };

  // Adapter factories - lazy creation when needed
  adapters: {
    reimbursement: (options?: AdapterOptions) => ReimbursementDataAccess;
    reporting: () => ReportingDataAccess;
  };
};
```

This gives us discoverability (adapters are part of the factory interface), controlled scope (factory decides which adapters are broadly useful), and efficiency (only created when actually needed). Just be mindful not to include every possible adapter - focus on those with broad applicability rather than highly specialized, single-use adapters.

However, consider some potential concerns: including too many adapters can contribute to factory bloat and the "god class" problem, adapters can be quite specialized and tightly coupled to specific business workflows which may not warrant factory inclusion. Balance convenience with maintainability when deciding which adapters deserve a place in your factory.

## Application-Level Integration

Once you've designed your data access architecture, the next question is how to integrate these patterns into real applications. This chapter covers practical usage patterns for HTTP request handlers, background jobs, and other application contexts, showing how the data access building blocks come together in practice.

The following examples assume you're using [the unified data access factory](#the-unified-data-access-factory) approach with convenience functions like `createDataAccessForRequest` to simplify instantiation and configuration.

### HTTP Request Handlers

HTTP request handlers follow a consistent structure, but the approach evolves based on complexity.

Simple case - no authorization, direct business logic:

```typescript
async function handleSimpleExpenseUpdate(req: Request, res: Response) {
  // 1. Validate payload and extract context
  const expenseData = validatePayload(req.body);

  // 2. Instantiate data access and call business logic
  const repo = createDataAccessForRequest(req).expenses.repo;
  const result = await processExpenseUpdate(
    {
      getExpenseById: repo.getById,
      updateExpense: repo.update,
    },
    { expenseData }
  );

  res.json(result);
}
```

With authorization - reveals data access duplication issues:

```typescript
async function handleExpenseUpdateWithAuth(req: Request, res: Response) {
  const { userId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const repo = createDataAccessForRequest(req).expenses.repo;

  // Problem: Authorization needs expense data
  await checkCanWriteExpense(
    {
      getExpenseById: repo.getById, // Fetch #1
    },
    { userId, expenseId: expenseData.expenseId }
  );

  // Problem: Business logic may also need the same expense data
  const result = await processExpenseUpdate(
    {
      getExpenseById: repo.getById, // Potential fetch #2
      updateExpense: repo.update,
    },
    { expenseData }
  );

  res.json(result);
}
```

Furthermore, this example reveals a leaky abstraction problem: the function `checkCanWriteExpense` receives both the data identifier (`expenseId`) and the method to fetch that data (`getExpenseById`), creating awkward coupling. The authorization function shouldn't need to know how to fetch expenses - it should work with the data directly.

**Refined approach** - strategic prefetching and mixed injection:

```typescript
async function handleExpenseUpdate(req: Request, res: Response) {
  const { userId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const repo = createDataAccessForRequest(req).expenses.repo;

  // Strategic prefetch: Get data needed by multiple operations
  const expense =
    (await repo.getById(expenseData.expenseId)) ?? throwNotFound();

  // Clean authorization: Pass actual data, not data access
  await checkCanWriteExpense({ userId, expense });

  // Business logic: Clean dependency injection with prefetched data
  const result = await processExpenseUpdate(
    {
      updateExpense: repo.update,
    },
    { expenseData, expense }
  );

  res.json(result);
}
```

The evolution sketched here shows key trade-offs: pure dependency injection (middle example) keeps functions testable but can cause data duplication, while strategic prefetching (final example) optimizes performance but couples the handler to specific data needs. Apply what makes sense - prefetch data at the handler level when multiple operations need the same entities, and inject data access methods for operations that need fresh or different data.

Alternative approaches like internal caching in the data access factory can solve duplication transparently, but introduce implicit behavior and potential side-effects that may not be obvious to all developers. The explicit prefetching approach trades some handler complexity for predictable, transparent behavior.

Composing multiple business operations - as a final example, consider a more complex expense update logic that also needs to recalculate trip totals and potentially notify managers. Rather than handling all orchestration at the handler level, you can push the business orchestration down into the workflow function while keeping the handler focused on request/response concerns and dependency wiring:

```typescript
async function handleComplexExpenseUpdate(req: Request, res: Response) {
  const { userId } = validateAuth(req);
  const expenseData = validatePayload(req.body);
  const dataAccess = createDataAccessForRequest(req);
  const pubSubAccess = createPubSubAccessForRequest(req);

  // Prefetch data needed for authorization and business logic
  const expense =
    (await dataAccess.expenses.repo.getById(expenseData.expenseId)) ??
    throwNotFound();
  await checkCanWriteExpense({ userId, expense });

  // Create business functions that close over their data access needs
  const recalculateTrip = partial(recalculateTripTotals, {
    findExpensesByTrip: dataAccess.expenses.findByTripId,
    updateTrip: dataAccess.trips.repo.update,
  });

  const notifyManager = partial(notifyExpenseUpdate, {
    getUserById: dataAccess.users.repo.getById,
    sendEmail: pubSubAccess.notifications.sendEmail,
  });

  // Business orchestration handled by the workflow function
  const result = await processExpenseUpdate(
    {
      updateExpense: dataAccess.expenses.repo.update,
      recalculateTrip,
      notifyManager,
    },
    { expenseData, expense, userId }
  );

  res.json(result);
}
```

This approach keeps the handler focused on request lifecycle concerns (validation, authorization, response) while pushing business orchestration logic into `processExpenseUpdate`. The business process function receives business capabilities as dependencies, not raw data access methods, creating cleaner separation of concerns.

### Background Jobs and Scripts

Background jobs, scripts, and other operational tasks typically run without user-based authorization concerns since they operate with system privileges rather than on behalf of individual users. However, they often need more complex data coordination and raise important questions about what belongs in a data access factory versus what should be instantiated on-demand.

Architectural boundaries: The data access factory should provide reusable building blocks (repositories, common queries, cross-cutting procedures) rather than every possible operation. One-off migrations, specialized batch jobs, and narrow-purpose procedures often don't belong in it - they can consume the factory's building blocks without being part of it.

Like HTTP handlers, background jobs and scripts follow the same pattern of instantiating the data access factory to get their needed building blocks. The main difference is that they typically have less complex business logic and interact more directly with the provided repositories and queries, often performing straightforward data processing tasks without the layered dependency injection patterns seen in handlers.

Direct use of building blocks from factory (DB-agnostic):

```typescript
async function runExpenseCleanupJob(organizationId: string) {
  const logger = createJobLogger();
  const repo = createDataAccess({ organizationId, logger }).expenses.repo;

  // DB-agnostic deletion (2 roundtrips)
  const staleExpenses = await repo.findBySpec(createStaleExpenseSpec(30), {
    id: true,
  });
  await repo.deleteMany(staleExpenses.map((e) => e.id));

  logger.info(`Cleaned up ${staleExpenses.length} stale expenses`);
}
```

While this example uses clean, testable interfaces, it requires two database roundtrips - one to find matching records, another to delete them by ID. For performance-critical batch operations, this overhead can be improved by bypassing the DB-agnostic interface and using database-specific optimizations.

Skip data access factory and instantiate repository to get access to native features:

```typescript
async function runExpenseCleanupJobOptimized(organizationId: string) {
  const logger = createJobLogger();
  const mongoClient = getMongoClient();

  // Access repository factory directly for MongoDB-specific operations
  const repo = createExpenseRepo(mongoClient, { organizationId });

  // MongoDB-specific: efficient single deleteMany operation
  const filter = repo.applyConstraints(createStaleExpenseSpec(30).toFilter());
  const result = await repo.collection.deleteMany(filter);

  logger.info(`Cleaned up ${result.deletedCount} stale expenses`);
}
```

The two approaches illustrate key architectural tradeoffs: the data access factory provides convenient, testable building blocks with DB-agnostic interfaces, but sometimes you need direct repository access for performance-critical operations. This is why having access to both the data access factory and underlying repository factories can be valuable - use the factory for most operations, but bypass it when you need DB-specific optimizations or advanced features not exposed through the abstract interface. The same considerations apply to [client-side stored procedures](#client-side-stored-procedures) - simpler ones can leverage factory building blocks, while complex procedures may need direct repository access for optimal performance.

Complex workflows instantiated on-demand:

```typescript
async function runReceiptReprocessingJob(organizationId: string) {
  const logger = createJobLogger();
  const dataAccess = createDataAccess({ organizationId, logger });

  // Complex workflow: instantiate separately, use factory's building blocks
  const reprocessor = createReceiptReprocessor({
    expenseRepo: dataAccess.expenses.repo,
    findFailedReceipts: dataAccess.expenses.findFailedReceipts,
    updateReceiptStatus: dataAccess.expenses.updateReceiptStatus,
    logger,
  });

  await reprocessor.execute({ batchSize: 100, retryFailures: true });
}
```

The key insight is that background jobs benefit from the same architectural patterns - they use factory building blocks for common operations but can bypass the factory for performance-critical or database-specific operations when needed.
