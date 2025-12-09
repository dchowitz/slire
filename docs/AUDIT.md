# Audit Trail Strategies with Tracing

- [Change Stream Processing (Recommended)](#change-stream-processing-recommended)
- [Embedded Audit Trails](#embedded-audit-trails)
- [Alternative: Synchronous Audit Collection](#alternative-synchronous-audit-collection)
- [Alternative: Event Emission with Pluggable Sinks](#alternative-event-emission-with-pluggable-sinks)
- [Alternative: Application-Level Explicit Audit](#alternative-application-level-explicit-audit)

Slire’s built‑in tracing is designed for two primary audit strategies: 1) **change stream processing** (using the "latest" trace strategy) and 2) **embedded audit trails** (using either "bounded" or "unbounded"). Tracing automatically writes a trace object on every write operation, making these patterns straightforward and consistent.

This document first covers these Slire‑native strategies, then outlines alternatives that do not rely on Slire’s tracing feature — giving you flexibility based on your requirements and infrastructure.


## Change Stream Processing (Recommended)

**Approach:** Use MongoDB change streams to monitor document changes and build audit records asynchronously, using the embedded trace context on each document.

```typescript
// Change stream processor
const changeStream = db
  .collection('tasks')
  .watch([{ $match: { 'fullDocument._trace': { $exists: true } } }]);

changeStream.on('change', async (event) => {
  const auditEntry = {
    entityId: event.fullDocument.id,
    entityType: 'task',
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

- Non‑blocking writes — audit processing does not slow down business operations
- Reliable event delivery with resume tokens (fault tolerance)
- Clear separation of concerns — audit logic lives outside business logic
- Can reconstruct detailed before/after diffs from change stream data
- Scales well — change streams are MongoDB’s recommended pattern for event processing

**Cons:**

- Eventual consistency — audit records appear shortly after writes
- Requires replica set (not available in standalone MongoDB)
- Operational complexity for running/monitoring processors
- Risk of missed processing during outages (resume tokens mitigate)

## Embedded Audit Trails

**Approach:** Use Slire’s "bounded" or "unbounded" trace strategies to maintain operation history directly within each document.

```typescript
// Bounded strategy - limited history with size control
const boundedRepo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId, requestId, service: 'task-api' },
  options: {
    traceStrategy: 'bounded',
    traceLimit: 100, // Keep last 100 operations per document
    traceKey: 'history',
  },
});

// Unbounded strategy - complete history without limits
const unboundedRepo = createMongoRepo({
  collection,
  mongoClient,
  traceContext: { userId, requestId, service: 'task-api' },
  options: {
    traceStrategy: 'unbounded', // No traceLimit needed
    traceKey: 'history',
  },
});

// Normal operations automatically build audit history
await unboundedRepo.update(
  taskId,
  { set: { status: 'done' } },
  { mergeTrace: { action: 'complete-task', reason: 'manual-review' } }
);

// Document contains embedded audit trail
const task = await unboundedRepo.getById(taskId, { id: true, history: true });
console.log(task?.history);
// [
//   // ... previous operations (oldest first; most recent entry is last)
//   {
//     userId: 'user-123',
//     requestId: 'req-123',
//     service: 'task-api',
//     action: 'complete-task',
//     reason: 'manual-review',
//     _op: 'update',
//     _at: '2025-01-15T10:30:00Z'
//   },
// ]

// Query documents by audit criteria using native MongoDB query
const recentCompletions = await unboundedRepo.collection
  .find({
    history: {
      $elemMatch: {
        action: 'complete-task',
        _at: { $gte: new Date('2025-01-01') },
      },
    },
  })
  .toArray();
```

**Pros:**

- Zero external infrastructure — audit history travels with the document
- Immediate consistency — audit trail is always in sync with document state
- Simple querying — filter documents by audit criteria directly
- No separate audit processing or storage
- Complete history available (unbounded)

**Cons:**

- Document size growth — larger documents impact performance and storage
- Limited history (bounded) — capped by `traceLimit`
- Unbounded growth (unbounded) — can lead to very large documents
- No global audit view — history is scattered across documents
- Harder to implement cross‑document analytics
- Document size limits apply (MongoDB 16MB, Firestore 1 MiB)

## Alternative: Synchronous Audit Collection

**Approach:** Write audit entries directly to a separate collection within the same transaction as the main write.

```typescript
function createAuditedTaskRepo(client: MongoClient, tenantId: string) {
  const baseRepo: ReturnType<typeof createTaskRepo> = createTaskRepo(client, tenantId);
  const auditCollection = baseRepo.collection.db.collection(`${baseRepo.collection.collectionName}_audit`);

  return {
    ...baseRepo,
    async update(
      id: string,
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
    ) {
      return client.withSession(async (session) => {
        return session.withTransaction(async () => {
          const txRepo = baseRepo.withSession(session);
          const updateOp = txRepo.buildUpdateOperation(update, options?.mergeTrace);
          const filter = txRepo.applyFilter({ _id: new ObjectId(id) });

          const before = await txRepo.collection.findOne(filter, { session });
          
          const { value: after } = await txRepo.collection.findOneAndUpdate(
            filter,
            updateOp,
            { returnDocument: 'after', session }
          );
          
          await auditCollection.insertOne(
            {
              entityId: id,
              entityType: baseRepo.collection.collectionName,
              operation: 'update',
              trace: options?.mergeTrace,
              before,
              after,
              timestamp: new Date(),
            },
            { session }
          );
        });
      });
    },
  };
}
```

**Pros:**

- Immediate consistency — audit entries are guaranteed for successful operations
- Transactional integrity — audit writes succeed or fail with the main operation
- Complete before/after state capture is straightforward

**Cons:**

- Slower writes due to additional DB roundtrips
- Higher risk of operation failure — audit write failures can fail business ops
- More complex implementation for bulk operations
- Increased database load during writes

## Alternative: Event Emission with Pluggable Sinks

**Approach:** Emit generic audit events from the repository using an in‑process `EventEmitter`, and attach one or more sinks that forward events to your desired destinations (console, database, external message queue, etc.). This unifies the simplicity of the emitter pattern with the scalability of message queues via a sink adapter.

```typescript
import { EventEmitter } from 'events';

type AuditEvent =
  | {
      operation: 'create';
      entityId: string;
      entity: CreateInput;
      trace?: any;
      timestamp: Date;
    }
  | {
      operation: 'update';
      entityId: string;
      update: UpdateOperation<UpdateInput>;
      trace?: any;
      timestamp: Date;
    }
  | {
      operation: 'delete';
      entityId: string;
      trace?: any;
      timestamp: Date;
    };

type AuditSink = {
  handle: (event: AuditEvent) => Promise<void> | void;
};

function createEventfulRepo(
  client: MongoClient,
  tenantId: string,
  sinks: AuditSink[] = []
) {
  const baseRepo = createTaskRepo(client, tenantId);
  const emitter = new EventEmitter();

  // Wire sinks
  for (const sink of sinks) {
    emitter.on('audit', (event: AuditEvent) => {
      // Fire-and-forget to avoid blocking writes; sinks can implement their own buffering/retry
      process.nextTick(() => {
        Promise.resolve(sink.handle(event)).catch((err) => {
          // Optional: replace with real logging/metrics
          console.error('Audit sink error:', err);
        });
      });
    });
  }

  const repo = {
    ...baseRepo,
    // optional, allow external code to subscribe to audit events
    on: emitter.on.bind(emitter),

    async create(entity: CreateInput, options?: { mergeTrace?: any }) {
      const id = await baseRepo.create(entity, options);
      emitter.emit('audit', {
        operation: 'create',
        entityId: id,
        entity,
        trace: options?.mergeTrace,
        timestamp: new Date(),
      } satisfies AuditEvent);
      return id;
    },

    async update(
      id: string,
      update: UpdateOperation<UpdateInput>,
      options?: { mergeTrace?: any }
    ) {
      await baseRepo.update(id, update, options);
      emitter.emit('audit', {
        operation: 'update',
        entityId: id,
        update,
        trace: options?.mergeTrace,
        timestamp: new Date(),
      } satisfies AuditEvent);
    },

    async delete(id: string, options?: { mergeTrace?: any }) {
      await baseRepo.delete(id, options);
      emitter.emit('audit', {
        operation: 'delete',
        entityId: id,
        trace: options?.mergeTrace,
        timestamp: new Date(),
      } satisfies AuditEvent);
    },
  };

  return repo;
}

// Example sinks
const consoleSink: AuditSink = {
  handle: (event) => {
    console.log('Audit event:', event);
  },
};

const mongoAuditSink = (auditCollection: Collection): AuditSink => ({
  handle: async (event) => {
    await auditCollection.insertOne({ ...event, receivedAt: new Date() });
  },
});

const messageQueueSink = (mq: MessageQueue): AuditSink => ({
  handle: async (event) => {
    await mq.publish(`audit.${event.operation}`, event);
  },
});

// Usage: wire sinks you need
const repo = createEventfulRepo(client, tenantId, [
  consoleSink,
  mongoAuditSink(auditCollection),
  messageQueueSink(messageQueue),
]);
```

**Pros:**

- Unified pattern — one emission mechanism, many destinations via sinks
- Flexible — add/remove sinks without changing business logic
- Non-blocking writes — sinks run out-of-band from the write path
- Scales up — add an MQ sink for reliable, distributed processing

**Cons:**

- In-process emitter alone is best-effort; add a durable sink (e.g., MQ) for reliability
- Requires sink error handling, monitoring, and backpressure strategies
- Eventual consistency for asynchronous sinks

## Alternative: Application-Level Explicit Audit

**Approach:** Handle audit logic explicitly in application code rather than relying on automatic tracing for storage.

```typescript
class TaskService {
  constructor(private repo: TaskRepo, private auditLog: AuditRepo) {}

  async completeTask(id: string, actor: User): Promise<void> {
    const before = await this.repo.getById(id);
    if (!before) throw new Error('Task not found');

    await this.repo.update(
      id,
      { set: { status: 'done' } },
      {
        mergeTrace: {
          action: 'complete-task',
          actorId: actor.id,
          reason: 'manual-completion',
        },
      }
    );

    const after = await this.repo.getById(id);

    await this.auditLog.create({
      entityId: id,
      entityType: 'task',
      operation: 'complete',
      actor: actor.id,
      before: before,
      after: after,
      trace: after?._trace,
      businessContext: {
        workflow: 'standard-completion',
      },
    });
  }
}
```

**Pros:**

- Complete control over audit logic and data structure
- Rich business context beyond technical changes
- Explicit and visible — audit behavior is clear in code
- Different strategies per operation are easy to implement

**Cons:**

- Easy to forget — no automatic trail generation
- Boilerplate repeated across operations
- Tighter coupling between business logic and audit requirements
- Risk of inconsistent audit practices across the codebase
