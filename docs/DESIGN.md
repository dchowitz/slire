# Design

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
