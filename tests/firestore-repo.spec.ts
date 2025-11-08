import { CollectionReference } from '@google-cloud/firestore';
import omit from 'lodash/omit';
import range from 'lodash/range';
import sortBy from 'lodash/sortBy';
import {
  convertFirestoreTimestamps,
  createSmartFirestoreRepo,
} from '../src/firestore-repo';
import {
  combineSpecs,
  CreateManyPartialFailure,
  Specification,
} from '../src/smart-repo';
import {
  clearFirestoreCollection,
  firestore,
  setupFirestore,
  teardownFirestore,
} from './firestore-fixture';
import { ascendingIds, pages } from './utils';

describe('createSmartFirestoreRepo', function () {
  jest.setTimeout(60 * 1000);
  const COLLECTION_NAME = 'generic_repo_test';

  beforeAll(async () => {
    await setupFirestore();
  });

  function testCollection(): CollectionReference<TestEntity> {
    return firestore.firestore.collection(
      COLLECTION_NAME,
    ) as CollectionReference<TestEntity>;
  }

  function scopedTestCollection(
    orgId: string,
  ): CollectionReference<TestEntity> {
    return firestore.firestore.collection(
      `tenants/${orgId}/${COLLECTION_NAME}`,
    ) as CollectionReference<TestEntity>;
  }

  function rawTestCollection(): CollectionReference<any> {
    return firestore.firestore.collection(COLLECTION_NAME);
  }

  beforeEach(async () => {
    await clearFirestoreCollection(COLLECTION_NAME);
  });

  afterAll(async () => {
    await clearFirestoreCollection(COLLECTION_NAME);
    await teardownFirestore();
  });

  describe('create', () => {
    it('should create a new entity and return its id', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({
        name: 'John Doe',
        email: 'john@example.com',
      });

      const createdId = await repo.create(entity);

      expect(typeof createdId).toBe('string');
      expect(createdId.length).toBeGreaterThan(0);

      // verify the entity was created
      const created = await repo.getById(createdId);
      expect(created).toMatchObject({
        name: 'John Doe',
        email: 'john@example.com',
      });
    });

    it('should generate unique ids for different entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity1 = createTestEntity({ name: 'Entity 1' });
      const entity2 = createTestEntity({ name: 'Entity 2' });

      const id1Result = await repo.create(entity1);
      const id2Result = await repo.create(entity2);

      expect(id1Result).not.toEqual(id2Result);
    });

    it('should handle entities with optional fields', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({
        metadata: undefined,
      });

      const createdId = await repo.create(entity);

      const created = await repo.getById(createdId);
      expect(created).toEqual({
        id: createdId,
        tenantId: 'org123',
        name: 'Test User',
        email: 'test@example.com',
        age: 30,
        isActive: true,
      });
    });

    it('should recursively filter undefined properties (not store as null)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({
        metadata: {
          tags: ['test', undefined as any, 'integration'],
          notes: undefined,
        },
      });

      const createdId = await repo.create(entity);

      // Check raw document in Firestore
      const rawDoc = await rawTestCollection().doc(createdId).get();
      const rawData = rawDoc.data();

      expect(rawData).toMatchObject({
        tenantId: 'org123',
        name: 'Test User',
        email: 'test@example.com',
        age: 30,
        isActive: true,
        metadata: {
          tags: ['test', 'integration'], // undefined filtered out from array
          // notes field should not exist at all (not set to null)
        },
      });
      expect(rawData?.metadata).not.toHaveProperty('notes');
    });

    it('should strip system-managed fields from input entities during create', async () => {
      const fixedTimestamp = new Date('2024-01-01T12:00:00.000Z');
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: {
          softDelete: true,
          version: true,
          traceTimestamps: () => fixedTimestamp,
        },
        traceContext: { userId: 'test-user' },
      });
      const entityWithManagedFields = {
        ...createTestEntity(),
        _id: 'should-be-stripped',
        _version: 42,
        _createdAt: new Date('2023-01-01'),
        _updatedAt: new Date('2023-01-02'),
        _deleted: true,
        _trace: { userId: 'user123' },
      } as any;

      const createdId = await repo.create(entityWithManagedFields);

      // Check raw document in Firestore (convert Timestamps to Dates for testing)
      const rawDoc = await rawTestCollection().doc(createdId).get();
      const convertedData = convertFirestoreTimestamps(rawDoc.data());

      // Input managed field values should be stripped and replaced with system-managed values
      expect(convertedData).not.toHaveProperty('_id'); // _id should never be stored in Firestore documents

      // System should set proper managed field values (not the input values)
      expect(convertedData).toMatchObject({
        _version: 1, // System sets version to 1 (not 42 from input)
        _createdAt: fixedTimestamp,
        _updatedAt: fixedTimestamp,
        _deleted: false, // docs get created with non-deleted marker
      });

      // Check trace structure (now uses configured timestamp strategy)
      expect(convertedData._trace).toMatchObject({
        userId: 'test-user', // User context preserved
        _op: 'create', // System adds operation type
        _at: fixedTimestamp, // Now respects configured timestamp strategy
      });

      // Business fields should be present
      expect(convertedData).toMatchObject({
        tenantId: 'org123',
        name: 'Test User',
        email: 'test@example.com',
      });
    });

    it('should strip system-managed fields with custom timestamp keys during create', async () => {
      const fixedTimestamp = new Date('2024-02-15T10:30:00.000Z');
      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<TestEntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
          traceTimestamps: () => fixedTimestamp,
        },
      });

      const entityWithCustomTimestamps: TestEntityWithTimestamps = {
        ...createTestEntity(),
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
      };

      const createdId = await repo.create(entityWithCustomTimestamps);

      // Check raw document in Firestore (convert Timestamps to Dates for testing)
      const rawDoc = await rawTestCollection().doc(createdId).get();
      const convertedData = convertFirestoreTimestamps(rawDoc.data());

      // Custom timestamp fields should not be present from input (stripped and auto-managed)
      // They should be set by the system with the fixed timestamp (not input values)
      expect(convertedData).toMatchObject({
        createdAt: fixedTimestamp,
        updatedAt: fixedTimestamp,
      });
    });
  });

  describe('createMany', () => {
    it('should create multiple entities and return their ids', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entities = [
        createTestEntity({ name: 'Alice', email: 'alice@example.com' }),
        createTestEntity({ name: 'Bob', email: 'bob@example.com' }),
        createTestEntity({ name: 'Charlie', email: 'charlie@example.com' }),
      ];

      const createdIds = await repo.createMany(entities);

      expect(Array.isArray(createdIds)).toBe(true);
      expect(createdIds).toHaveLength(3);
      for (const id of createdIds) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }

      // verify all entities were created
      const [found, notFound] = await repo.getByIds(createdIds);
      expect(found).toHaveLength(3);
      expect(notFound).toHaveLength(0);

      // verify entity data
      const expectedNames = ['Alice', 'Bob', 'Charlie'];
      const expectedEmails = [
        'alice@example.com',
        'bob@example.com',
        'charlie@example.com',
      ];
      const foundNames = found.map((entity) => entity.name);
      const foundEmails = found.map((entity) => entity.email);

      expect(foundNames).toEqual(expect.arrayContaining(expectedNames));
      expect(foundEmails).toEqual(expect.arrayContaining(expectedEmails));
    });

    it('should generate unique ids for all entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entities = [
        createTestEntity({ name: 'Entity 1' }),
        createTestEntity({ name: 'Entity 2' }),
        createTestEntity({ name: 'Entity 3' }),
      ];

      const createdIds = await repo.createMany(entities);

      // all ids should be unique
      const uniqueIds = new Set(createdIds);
      expect(uniqueIds.size).toEqual(createdIds.length);
      expect(uniqueIds.size).toEqual(3);
    });

    it('should handle empty array', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const createdIds = await repo.createMany([]);

      expect(Array.isArray(createdIds)).toBe(true);
      expect(createdIds).toHaveLength(0);
    });

    it('should handle entities with optional fields', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entities = [
        createTestEntity({
          name: 'User 1',
          metadata: undefined,
        }),
        createTestEntity({
          name: 'User 2',
          metadata: { tags: ['custom'], notes: 'Custom notes' },
        }),
      ];

      const createdIds = await repo.createMany(entities);

      const [found, notFound] = await repo.getByIds(createdIds);
      expect(found).toHaveLength(2);
      expect(notFound).toHaveLength(0);

      // verify first entity (without optional fields)
      const firstEntity = found.find((e) => e.name === 'User 1');
      expect(firstEntity).toEqual({
        id: createdIds[0],
        tenantId: firstEntity!.tenantId,
        name: 'User 1',
        email: 'test@example.com',
        age: 30,
        isActive: true,
      });

      // verify second entity (with optional fields)
      const secondEntity = found.find((e) => e.name === 'User 2');
      expect(secondEntity).toEqual({
        id: createdIds[1],
        tenantId: secondEntity!.tenantId,
        name: 'User 2',
        email: 'test@example.com',
        age: 30,
        isActive: true,
        metadata: { tags: ['custom'], notes: 'Custom notes' },
      });
    });

    it('should recursively filter undefined properties', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entities = [
        {
          ...createTestEntity(),
          metadata: {
            tags: ['tag1', undefined, 'tag2'] as any,
            notes: undefined,
            nested: {
              value: 'keep',
              remove: undefined,
            },
          },
        },
      ];

      const createdIds = await repo.createMany(entities);

      // Check raw document in Firestore
      const rawDoc = await rawTestCollection().doc(createdIds[0]).get();
      const rawData = rawDoc.data();

      // Undefined should be filtered out (including from arrays in Firestore)
      expect(rawData?.metadata).toEqual({
        tags: ['tag1', 'tag2'], // undefined filtered from array
        nested: {
          value: 'keep',
          // remove: undefined should be absent
        },
        // notes: undefined should be absent
      });
      expect(rawData?.metadata).not.toHaveProperty('notes');
      expect(rawData?.metadata.nested).not.toHaveProperty('remove');
    });

    it('should handle large batches with chunking', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      // Create 1500 entities to test chunking (Firestore batch limit is 500)
      const entities: TestEntity[] = [];
      for (let i = 0; i < 1500; i++) {
        entities.push(
          createTestEntity({
            name: `User ${i}`,
            email: `user${i}@example.com`,
            age: 20 + i,
          }),
        );
      }

      const createdIds = await repo.createMany(entities);

      expect(createdIds).toHaveLength(1500);

      // verify all entities were created
      const [found, notFound] = await repo.getByIds(createdIds);
      expect(found).toHaveLength(1500);
      expect(notFound).toHaveLength(0);

      // verify data for a sample of entities
      const sampleIndices = [0, 500, 1000, 1499];
      for (const i of sampleIndices) {
        const entity = found.find((e) => e.id === createdIds[i]);
        expect(entity).toMatchObject({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          age: 20 + i,
        });
      }
    });

    it('should throw CreateManyPartialFailure on duplicate ids within a single batch (Firestore: entire batch fails)', async () => {
      // generate identical ids to force batch failure (Firestore batches are atomic)
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { generateId: () => 'DUPLICATE-ID' },
      });

      const entities = [
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
        createTestEntity({ name: 'C' }),
      ];

      try {
        await repo.createMany(entities);
        fail('should have thrown');
      } catch (e: any) {
        if (e instanceof CreateManyPartialFailure) {
          // Firestore behavior: entire batch fails atomically, so no inserts succeed
          expect(e.insertedIds).toHaveLength(0);
          expect(e.failedIds).toHaveLength(3);
          // Firestore should contain no documents (entire batch failed)
          const snapshot = await rawTestCollection().get();
          expect(snapshot.size).toBe(0);
        } else {
          throw e;
        }
      }
    });

    it('should report prior-batch inserts and mark subsequent ids as failed when a later batch fails', async () => {
      // create 1005 entities to span multiple batches (Firestore batch limit is 500)
      // generate unique ids for the first 1000, then duplicate the same id for the last 5
      let counter = 0;
      const generateId = () => {
        counter += 1;
        return counter <= 1000 ? `ID-${counter}` : 'DUP-LAST-BATCH';
      };

      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { generateId },
      });

      const entities: TestEntity[] = [];
      for (let i = 0; i < 1005; i++) {
        entities.push(
          createTestEntity({ name: `U${i}`, email: `u${i}@e.com` }),
        );
      }

      try {
        await repo.createMany(entities);
        fail('should have thrown');
      } catch (e: any) {
        if (e instanceof CreateManyPartialFailure) {
          // Firestore behavior: first 900 succeed (batches 1-3), third batch fails entirely
          expect(e.insertedIds).toHaveLength(900);
          // All 105 entities in the fourth batch fail (entire batch fails atomically)
          expect(e.failedIds).toHaveLength(105);
          const snapshot = await rawTestCollection().get();
          expect(snapshot.size).toBe(900);
        } else {
          throw e;
        }
      }
    });
  });

  describe('getById', () => {
    it('should return the entity when it exists', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Test Entity' });

      const createdId = await repo.create(entity);
      const retrieved = await repo.getById(createdId);

      expect(retrieved).toEqual({
        id: createdId,
        tenantId: entity.tenantId,
        name: 'Test Entity',
        email: 'test@example.com',
        age: 30,
        isActive: true,
        metadata: entity.metadata,
      });
    });

    it('should return null when entity does not exist', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const retrieved = await repo.getById('non-existent-id');
      expect(retrieved).toBeUndefined();
    });

    it('should support projections', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Projection Test' });

      const createdId = await repo.create(entity);

      const retrieved = await repo.getById(createdId, {
        name: true,
        email: true,
      });

      expect(retrieved).toEqual({
        name: 'Projection Test',
        email: 'test@example.com',
      });
    });

    it('should return entity even if configured scope mismatches (reads ignore scope)', async () => {
      const base = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await base.create(
        createTestEntity({ tenantId: 'tenant-A', name: 'Scoped' }),
      );

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-B' },
      });

      const result = await scoped.getById(id, { id: true, name: true });
      expect(result).toEqual({ id, name: 'Scoped' });
    });
  });

  describe('getByIds', () => {
    it('should return entities that exist and ids that do not exist', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const createdIds = await repo.createMany(
        range(0, 5).map((i) => createTestEntity({ name: `Entity ${i}` })),
      );

      const requestedIds = [
        ...createdIds.slice(0, 3),
        'non-existent-1',
        'non-existent-2',
      ];
      const [found, notFound] = await repo.getByIds(requestedIds);

      expect(found).toHaveLength(3);
      expect(notFound).toHaveLength(2);
      expect(notFound).toEqual(
        expect.arrayContaining(['non-existent-1', 'non-existent-2']),
      );

      // check that all expected entities are found, regardless of order
      const expectedNames = ['Entity 0', 'Entity 1', 'Entity 2'];
      const foundNames = found.map((entity) => entity.name);
      expect(foundNames).toEqual(expect.arrayContaining(expectedNames));
    });

    it('should return empty arrays when no entities exist', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const [found, notFound] = await repo.getByIds(['id1', 'id2', 'id3']);

      expect([found, notFound]).toEqual([[], ['id1', 'id2', 'id3']]);
    });

    it('should support projections', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const createdIds = await repo.createMany(
        range(0, 3).map((i) => createTestEntity({ name: `Entity ${i}` })),
      );

      const requestedIds = [...createdIds, 'non-existent-1'];
      const [found, notFound] = await repo.getByIds(requestedIds, {
        name: true,
        email: true,
      });

      // check that all found entities have only the projected fields, regardless of order
      const expectedNames = ['Entity 0', 'Entity 1', 'Entity 2'];
      const foundNames = found.map((entity) => entity.name);
      expect(foundNames).toEqual(expect.arrayContaining(expectedNames));

      // verify all entities have the correct structure
      for (const entity of found) {
        expect(entity).toEqual({
          name: entity.name,
          email: 'test@example.com',
        });
      }

      expect([found.length, notFound]).toEqual([3, ['non-existent-1']]);
    });

    it('should return only active docs and list soft-deleted/non-existent in notFound (reads ignore scope)', async () => {
      // Prepare data in one collection
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const aId = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'A' }),
      );
      const bId = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'B' }),
      );
      const cId = await repo.create(
        createTestEntity({ tenantId: 'other', name: 'C' }),
      );

      // Soft delete B
      await repo.delete(bId);

      const ghost = 'non-existent-id';
      const [found, notFound] = await repo.getByIds([aId, bId, cId, ghost], {
        id: true,
        name: true,
      });

      // Active A and active C should be found; B (soft-deleted) and ghost not found
      expect(found.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
        { id: aId, name: 'A' },
        { id: cId, name: 'C' },
      ]);
      expect(notFound.sort()).toEqual([bId, ghost].sort());
    });
  });

  describe('update', () => {
    it('should update an existing entity', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Original Name' });

      const createdId = await repo.create(entity);

      await repo.update(createdId, { set: { name: 'Updated Name', age: 35 } });

      const updated = await repo.getById(createdId);
      expect(updated).toEqual({
        id: createdId,
        tenantId: entity.tenantId,
        name: 'Updated Name',
        email: 'test@example.com',
        age: 35,
        isActive: true,
        metadata: entity.metadata,
      });
    });

    it('should unset fields when specified', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const entity = createTestEntity({
        name: 'Test Entity',
        metadata: { tags: ['tag1'], notes: 'Test notes' },
      });

      const createdId = await repo.create(entity);

      await repo.update(createdId, { unset: ['metadata'] });

      const updated = await repo.getById(createdId);

      expect(updated).toEqual({
        ...omit(entity, 'metadata'),
        id: createdId,
      });
    });

    it('should handle set and unset in the same operation', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({
        name: 'Original Name',
        metadata: { tags: ['old'], notes: 'Old notes' },
      });

      const createdId = await repo.create(entity);

      await repo.update(createdId, {
        set: { name: 'New Name', age: 40 },
        unset: ['metadata'],
      });

      const updated = await repo.getById(createdId);

      expect(updated).toEqual({
        id: createdId,
        tenantId: entity.tenantId,
        name: 'New Name',
        email: 'test@example.com',
        age: 40,
        isActive: true,
      });
    });

    it('should only allow unsetting properties that can be undefined (type safety)', async () => {
      type EntityWithUndefinedField = TestEntity & {
        description: string | undefined;
      };

      const repo = createSmartFirestoreRepo({
        collection:
          testCollection() as unknown as CollectionReference<EntityWithUndefinedField>,
        firestore: firestore.firestore,
      });

      const entityData = {
        ...createTestEntity(),
        description: 'test description' as string | undefined,
      };

      const createdId = await repo.create(entityData);

      // Both optional properties should be allowed to unset
      await repo.update(createdId, {
        unset: ['description', 'metadata'],
      });

      // The following would cause TypeScript compile errors (commented out to avoid build failure):
      // await repo.update(createdId, { unset: ['name'] });
      // await repo.update(createdId, { unset: ['email'] });
      // await repo.update(createdId, { unset: ['age'] });
      // await repo.update(createdId, { unset: ['isActive'] });
      // await repo.update(createdId, { unset: ['organizationId'] });
      // await repo.update(createdId, { unset: ['name'] });

      const updated = await repo.getById(createdId);
      expect(updated).not.toHaveProperty('description');
      expect(updated).not.toHaveProperty('metadata');
    });

    it('should allow unsetting nested optional properties using dot notation', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const entity = createTestEntity({
        metadata: {
          tags: ['tag1', 'tag2'],
          notes: 'Some notes that will be unset',
        },
      });

      const createdId = await repo.create(entity);

      // Unset nested optional property using dot notation
      await repo.update(createdId, {
        unset: ['metadata.notes'],
      });

      const updated = await repo.getById(createdId);
      expect(updated).toBeDefined();
      expect(updated!.metadata).toBeDefined();
      expect(updated!.metadata?.tags).toEqual(['tag1', 'tag2']);
      expect(updated!.metadata?.notes).toBeUndefined();

      // Verify the raw document in Firestore
      const raw = await rawTestCollection().doc(createdId).get();
      const data = convertFirestoreTimestamps(raw.data());
      expect(data.metadata.notes).toBeUndefined();
      expect(data.metadata.tags).toEqual(['tag1', 'tag2']);
    });

    it('should allow unsetting a single optional property as string (not array)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const entity = createTestEntity({
        metadata: {
          tags: ['tag1', 'tag2'],
          notes: 'Some notes that will be unset',
        },
      });

      const createdId = await repo.create(entity);

      // Unset single optional property as string (not array)
      await repo.update(createdId, {
        unset: 'metadata.notes',
      });

      const updated = await repo.getById(createdId);
      expect(updated).toBeDefined();
      expect(updated!.metadata).toBeDefined();
      expect(updated!.metadata?.tags).toEqual(['tag1', 'tag2']);
      expect(updated!.metadata?.notes).toBeUndefined();

      // Verify the raw document in Firestore
      const raw = await rawTestCollection().doc(createdId).get();
      const data = convertFirestoreTimestamps(raw.data());
      expect(data.metadata.notes).toBeUndefined();
      expect(data.metadata.tags).toEqual(['tag1', 'tag2']);
    });

    it('should not affect non-existent entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      // this should not throw an error
      await repo.update('non-existent-id', { set: { name: 'New Name' } });

      // verify no entity was created
      const retrieved = await repo.getById('non-existent-id');
      expect(retrieved).toBeUndefined();

      const matched = await repo.find({ name: 'New Name' }).toArray();
      expect(matched).toHaveLength(0);
    });

    it('should recursively filter undefined properties in set operations (not store as null)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      // First create an entity
      const initialEntity = createTestEntity({ name: 'Initial Name' });
      const createdId = await repo.create(initialEntity);

      // Update with nested undefined properties
      await repo.update(createdId, {
        set: {
          name: 'Updated Name',
          metadata: {
            tags: ['updated'],
            notes: undefined, // Should be filtered out
            nested: {
              field1: 'updated-value1',
              field2: undefined, // Should be filtered out
              field3: null, // Should be preserved as null
              deep: {
                level3: 'updated',
                level3undefined: undefined, // Should be filtered out
              },
            },
          } as any, // Cast to allow nested property for testing
          // Root level undefined in set operation
          age: undefined as any, // Should be filtered out
        },
      });

      // Check what actually got stored in Firestore
      const rawDoc = await rawTestCollection().doc(createdId).get();
      const rawData = convertFirestoreTimestamps(rawDoc.data()!);

      // Verify undefined fields in nested objects are absent (not null)
      // Note: age remains from original entity since undefined was filtered from set operation
      expect(rawData?.age).toBe(30); // Original value remains
      expect(rawData?.metadata).not.toHaveProperty('notes');
      expect(rawData?.metadata?.nested).not.toHaveProperty('field2');
      expect(rawData?.metadata?.nested?.deep).not.toHaveProperty(
        'level3undefined',
      );

      // Verify null fields are preserved as null
      expect(rawData?.metadata?.nested?.field3).toBe(null);

      // Verify defined fields are present and updated
      expect(rawData?.name).toBe('Updated Name');
      expect(rawData?.metadata?.tags).toEqual(['updated']);
      expect(rawData?.metadata?.nested?.field1).toBe('updated-value1');
      expect(rawData?.metadata?.nested?.deep?.level3).toBe('updated');
    });

    it('should reject update that attempts to change scope', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const id = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'Original Name' }),
      );

      await expect(
        repo.update(id, {
          set: { tenantId: 'foo', name: 'Updated Name' } as any,
        }),
      ).rejects.toThrow('Cannot update readonly properties: tenantId');

      expect(await repo.getById(id, { tenantId: true, name: true })).toEqual({
        tenantId: 'acme',
        name: 'Original Name',
      });
    });

    it('should reject update that attempts to set managed fields', async () => {
      type EntityWithManagedFields = TestEntity & {
        _v: number;
        _createdAt: Date;
      };
      const repo = createSmartFirestoreRepo({
        collection:
          testCollection() as unknown as CollectionReference<EntityWithManagedFields>,
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
        options: { version: '_v', timestampKeys: { createdAt: '_createdAt' } },
      });

      const id = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'Original Name' }),
      );

      await expect(
        repo.update(id, {
          set: { _v: 47, name: 'Updated Name' } as any,
          unset: ['_createdAt'] as any,
        }),
      ).rejects.toThrow('Cannot update readonly properties: _v');

      expect(await repo.getById(id, { tenantId: true, name: true })).toEqual({
        tenantId: 'acme',
        name: 'Original Name',
      });
    });

    it('should reject update that attempts to unset managed fields', async () => {
      type EntityWithManagedFields = TestEntity & {
        _v: number;
        _createdAt: Date;
      };
      const repo = createSmartFirestoreRepo({
        collection:
          rawTestCollection() as CollectionReference<EntityWithManagedFields>,
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
        options: { version: '_v', timestampKeys: { createdAt: '_createdAt' } },
      });

      const id = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'Original Name' }),
      );

      await expect(
        repo.update(id, {
          set: { name: 'Updated Name' },
          unset: ['_createdAt'] as any,
        }),
      ).rejects.toThrow('Cannot unset readonly properties: _createdAt');

      expect(await repo.getById(id, { tenantId: true, name: true })).toEqual({
        tenantId: 'acme',
        name: 'Original Name',
      });
    });

    it('should not update a soft-deleted entity (id path, server-side filtered)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Entity 1' }));
      await repo.delete(id);

      await repo.update(id, { set: { name: 'Updated Soft Deleted' } });

      const raw = await rawTestCollection().doc(id).get();
      const data = raw.data()!;
      expect(data._deleted).toBe(true);
      expect(data.name).toBe('Entity 1');
    });
  });

  describe('updateMany', () => {
    it('should update many entities and ignore non-existing ids', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const createdIds = await repo.createMany([
        createTestEntity({ name: 'User 1' }),
        createTestEntity({ name: 'User 2' }),
        createTestEntity({ name: 'User 3' }),
      ]);

      // include a non-existent id; this should not throw
      const nonExistentId = 'non-existent-id';
      await repo.updateMany([...createdIds, nonExistentId], {
        set: { isActive: false },
      });

      // verify all entities were updated
      const [found] = await repo.getByIds(createdIds);
      expect(found).toHaveLength(3);
      expect(found.every((e) => e.isActive === false)).toBe(true);
    });

    it('should update only active entities (skip soft-deleted) in bulk', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });
      const [aId, bId, cId] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
        createTestEntity({ name: 'C' }),
      ]);

      // soft delete B
      await repo.delete(bId);

      // bulk update
      await repo.updateMany([aId, bId, cId], { set: { isActive: false } });

      const rawA = (await rawTestCollection().doc(aId).get()).data()!;
      const rawB = (await rawTestCollection().doc(bId).get()).data()!;
      const rawC = (await rawTestCollection().doc(cId).get()).data()!;

      expect(rawA.isActive).toBe(false);
      expect(rawC.isActive).toBe(false);
      // B remains unchanged besides _deleted
      expect(rawB._deleted).toBe(true);
      expect(rawB.isActive).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete an existing entity', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'To Delete' });

      const createdId = await repo.create(entity);

      await repo.delete(createdId);

      const deleted = await repo.getById(createdId);
      expect(deleted).toBeUndefined();
    });

    it('should not throw on non-existent entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      await repo.delete('non-existent-id');
    });
  });

  describe('deleteMany', () => {
    it('should delete multiple entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entities = range(0, 5).map((i) =>
        createTestEntity({ name: `Entity ${i}` }),
      );

      const createdIds = await repo.createMany(entities);

      await repo.deleteMany(createdIds);

      const [found, notFound] = await repo.getByIds(createdIds);

      expect([found.length, notFound.length]).toEqual([0, 5]);
    });

    it('should handle large batches with chunking', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entities = range(0, 150).map((i) =>
        createTestEntity({ name: `Entity ${i}` }),
      );

      const createdIds = await repo.createMany(entities);

      await repo.deleteMany(createdIds);

      const [found, notFound] = await repo.getByIds(createdIds);

      expect([found.length, notFound.length]).toEqual([0, 150]);
    });

    it('should handle mixed existing and non-existing ids', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      const createdId = await repo.create(entity);

      const ids = [createdId, 'non-existent-1', 'non-existent-2'];

      // this should not throw an error
      await repo.deleteMany(ids);

      // verify the existing entity was deleted
      const deleted = await repo.getById(createdId);
      expect(deleted).toBeUndefined();
    });

    it('should soft delete only active docs and ignore already soft-deleted/non-existing', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const [aId, bId, cId] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
        createTestEntity({ name: 'C' }),
      ]);

      // Pre-soft-delete B
      await repo.delete(bId);

      // Include a non-existent id
      const ghost = 'non-existent-id';

      await repo.deleteMany([aId, bId, cId, ghost]);

      const rawA = (await rawTestCollection().doc(aId).get()).data()!;
      const rawB = (await rawTestCollection().doc(bId).get()).data()!;
      const rawC = (await rawTestCollection().doc(cId).get()).data()!;

      expect(rawA._deleted).toBe(true);
      expect(rawB._deleted).toBe(true);
      expect(rawC._deleted).toBe(true);
    });
  });

  describe('find', () => {
    it('should find entities matching the filter', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
        createTestEntity({ name: 'David', age: 40, isActive: true }),
      ]);

      const activeUsers = await repo.find({ isActive: true }).toArray();
      expect(activeUsers).toHaveLength(3);
      activeUsers.forEach((user) => {
        expect(user.isActive).toBe(true);
      });

      const youngUsers = await repo.find({ age: 25 }).toArray(); // exact match only
      expect(youngUsers).toHaveLength(1);
      expect(youngUsers[0].name).toBe('Alice');
    });

    it('should return all entities if filter is empty', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
        createTestEntity({ name: 'David', age: 40, isActive: true }),
      ]);

      const all = await repo.find({}).toArray();
      expect(all).toHaveLength(4);
    });

    it('should return empty array when no entities match', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const results = await repo.find({ name: 'Non-existent' }).toArray();
      expect(results).toHaveLength(0);
    });

    it('should support streaming operations (skip, take, toArray)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'User 1', age: 20 }),
        createTestEntity({ name: 'User 2', age: 25 }),
        createTestEntity({ name: 'User 3', age: 30 }),
        createTestEntity({ name: 'User 4', age: 35 }),
        createTestEntity({ name: 'User 5', age: 40 }),
      ]);

      const stream = repo.find({}, { orderBy: { name: 'asc' } });

      const result = await stream.skip(2).take(2).toArray();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('User 3');
      expect(result[1].name).toBe('User 4');
    });

    it('should support orderBy option', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Charlie', age: 30 }),
        createTestEntity({ name: 'Alice', age: 25 }),
        createTestEntity({ name: 'Bob', age: 35 }),
      ]);

      // Test ascending order
      const ascending = await repo
        .find({}, { orderBy: { name: 'asc' } })
        .toArray();
      expect(ascending.map((u) => u.name)).toEqual(['Alice', 'Bob', 'Charlie']);

      // Test descending order
      const descending = await repo
        .find({}, { orderBy: { name: 'desc' } })
        .toArray();
      expect(descending.map((u) => u.name)).toEqual([
        'Charlie',
        'Bob',
        'Alice',
      ]);

      // Test mixed directions
      const mixed = await repo
        .find({}, { orderBy: { age: 'desc', name: 'asc' } })
        .toArray();
      expect(mixed.map((u) => u.name)).toEqual(['Bob', 'Charlie', 'Alice']); // Bob 35, Charlie 30, Alice 25
    });

    it('should support projections', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
      ]);

      const projectedUsers = await repo
        .find({ isActive: true }, { projection: { name: true, age: true } })
        .toArray();

      expect(sortBy(projectedUsers, (u) => u.name)).toEqual([
        { name: 'Alice', age: 25 },
        { name: 'Bob', age: 30 },
      ]);
    });

    it('should support projections with id field', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const createdIds = await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25 }),
        createTestEntity({ name: 'Bob', age: 30 }),
      ]);

      const projectedUsers = await repo
        .find({}, { projection: { id: true, name: true } })
        .toArray();

      expect(sortBy(projectedUsers, (u) => u.name)).toEqual([
        { name: 'Alice', id: createdIds[0] },
        { name: 'Bob', id: createdIds[1] },
      ]);
    });

    it('should handle projections with no matching entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const results = await repo
        .find(
          { name: 'Non-existent' },
          { projection: { name: true, email: true } },
        )
        .toArray();

      expect(results).toHaveLength(0);
    });

    it('should support filtering by id field', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const [aId, bId] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
      ]);

      const onlyA = await repo.find({ id: aId }).toArray();
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0].id).toBe(aId);

      const onlyB = await repo
        .find({ id: bId }, { projection: { id: true, name: true } })
        .toArray();

      expect(onlyB).toEqual([{ id: bId, name: 'B' }]);
    });

    it('should return scope-breaching docs included in a path-scoped collection (no scope filter on reads)', async () => {
      const scopedCollection = scopedTestCollection('tenant-A');
      const base = createSmartFirestoreRepo({
        collection: scopedCollection,
        firestore: firestore.firestore,
      });
      const id = await base.create(
        createTestEntity({ tenantId: 'wrong-tenant', name: 'Scoped' }),
      );

      const scoped = createSmartFirestoreRepo({
        collection: scopedCollection,
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-A' },
      });

      const results = await scoped
        .find({ id }, { projection: { id: true, name: true } })
        .toArray();

      expect(results).toHaveLength(1);
    });

    it('should return empty on scope-breach by default', async () => {
      const unscoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await unscoped.createMany([
        createTestEntity({ tenantId: 'acme', name: 'InScope' }),
        createTestEntity({ tenantId: 'other', name: 'OutOfScope' }),
      ]);

      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const results = await repo.find({ tenantId: 'other' }).toArray();
      expect(results).toEqual([]);
    });

    it('should throw on scope-breach when configured to error', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      expect(() =>
        repo.find({ tenantId: 'other' }, { onScopeBreach: 'error' }),
      ).toThrow('Scope breach detected in find filter');
    });
  });

  describe('findPage', () => {
    it('should return a page of results with pagination cursor', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { generateId: ascendingIds() },
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25 }),
        createTestEntity({ name: 'Bob', age: 30 }),
        createTestEntity({ name: 'Charlie', age: 35 }),
        createTestEntity({ name: 'David', age: 40 }),
        createTestEntity({ name: 'Eve', age: 45 }),
      ]);

      const result = await pages(
        repo,
        {},
        { limit: 2, projection: { name: true } },
      );

      expect(result).toEqual([
        [{ name: 'Alice' }, { name: 'Bob' }],
        [{ name: 'Charlie' }, { name: 'David' }],
        [{ name: 'Eve' }],
      ]);
    });

    it('should work with filters', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { generateId: ascendingIds() },
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', isActive: true }),
        createTestEntity({ name: 'Bob', isActive: false }),
        createTestEntity({ name: 'Charlie', isActive: false }),
        createTestEntity({ name: 'David', isActive: true }),
      ]);

      const result = await pages(
        repo,
        { isActive: true },
        { limit: 1, projection: { name: true } }, // implicit sort by id
      );

      expect(result).toEqual([[{ name: 'Alice' }], [{ name: 'David' }]]);
    });

    it('should work with custom orderBy', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { generateId: ascendingIds(), mirrorId: true },
      });

      await repo.createMany([
        createTestEntity({ name: 'Charlie', age: 35 }), // id-000
        createTestEntity({ name: 'Charlie', age: 35 }), // id-001
        createTestEntity({ name: 'Charlie', age: 36 }), // id-002
        createTestEntity({ name: 'Charlie', age: 37 }), // id-003
        createTestEntity({ name: 'Alice', age: 25 }), // id-004
        createTestEntity({ name: 'Alice', age: 27 }), // id-005
        createTestEntity({ name: 'Bob', age: 30 }), // id-006
        createTestEntity({ name: 'Bob', age: 35 }), // id-007
        createTestEntity({ name: 'Bob', age: 40 }), // id-008
      ]);

      const page = await repo.findPage(
        {},
        {
          limit: 100,
          orderBy: { name: 'asc', age: 'desc', id: 'desc', email: 'asc' }, // email will be ignored
        },
      );

      expect(page.items.map((u) => `${u.name}-${u.age}-${u.id}`)).toEqual([
        'Alice-27-id-005',
        'Alice-25-id-004',
        'Bob-40-id-008',
        'Bob-35-id-007',
        'Bob-30-id-006',
        'Charlie-37-id-003',
        'Charlie-36-id-002',
        'Charlie-35-id-001',
        'Charlie-35-id-000',
      ]);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should handle empty results', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const page = await repo.findPage({ name: 'NonExistent' }, { limit: 10 });
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should handle scope breach with default empty behavior', async () => {
      const scoped = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-A' },
      });

      const page = await scoped.findPage(
        { tenantId: 'tenant-B' },
        { limit: 10 },
      );
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should throw on scope breach when configured', async () => {
      const scoped = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-A' },
      });

      await expect(
        scoped.findPage(
          { tenantId: 'tenant-B' },
          { limit: 10, onScopeBreach: 'error' },
        ),
      ).rejects.toThrow('Scope breach detected in findPage filter');
    });

    it('should throw with invalid cursor (not found)', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await expect(
        repo.findPage({}, { limit: 10, cursor: 'does-not-exist' }),
      ).rejects.toThrow('Invalid cursor: document not found');
    });

    it('should throw with invalid cursor (scope breach)', async () => {
      const unscoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await unscoped.create(createTestEntity({ tenantId: 'acme' }));

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-A' },
      });

      await expect(
        scoped.findPage({}, { limit: 10, cursor: id }),
      ).rejects.toThrow('Invalid cursor: document not found');
    });

    it('should throw with invalid cursor (soft-deleted)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity());
      await repo.delete(id);

      await expect(
        repo.findPage({}, { limit: 10, cursor: id }),
      ).rejects.toThrow('Invalid cursor: document not found');
    });

    it('should work with large page sizes', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'User 1' }),
        createTestEntity({ name: 'User 2' }),
        createTestEntity({ name: 'User 3' }),
      ]);

      const page = await repo.findPage({}, { limit: 100 });
      expect(page.items).toHaveLength(3);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should work with limit 0', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'User 1' }),
        createTestEntity({ name: 'User 2' }),
        createTestEntity({ name: 'User 3' }),
      ]);

      const page = await repo.findPage({}, { limit: 0 });
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should work with negative limit', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'User 1' }),
        createTestEntity({ name: 'User 2' }),
        createTestEntity({ name: 'User 3' }),
      ]);

      const page = await repo.findPage({}, { limit: -1 });
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should work with specifications', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', isActive: true }),
        createTestEntity({ name: 'Bob', isActive: true }),
        createTestEntity({ name: 'Charlie', isActive: false }),
        createTestEntity({ name: 'David', isActive: true }),
        createTestEntity({ name: 'Eve', isActive: true }),
      ]);

      const activeUsersSpec: Specification<TestEntity> = {
        toFilter: () => ({ isActive: true }),
        describe: 'active users',
      };

      const page1 = await repo.findPageBySpec(activeUsersSpec, {
        limit: 2,
        orderBy: { name: 'asc' },
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0].name).toBe('Alice');
      expect(page1.items.every((u) => u.isActive)).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await repo.findPageBySpec(activeUsersSpec, {
        limit: 2,
        orderBy: { name: 'asc' },
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.items.every((u) => u.isActive)).toBe(true);
    });

    describe('cursor pagination with custom orderBy', () => {
      it('should paginate correctly with single field ascending order', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Charlie', age: 35 }), // id-000
          createTestEntity({ name: 'Alice', age: 25 }), // id-001
          createTestEntity({ name: 'David', age: 40 }), // id-002
          createTestEntity({ name: 'Bob', age: 30 }), // id-003
          createTestEntity({ name: 'Eve', age: 45 }), // id-004
          createTestEntity({ name: 'Bob', age: 45 }), // id-005
        ]);

        const result = await pages(
          repo,
          {},
          { limit: 4, orderBy: { name: 'asc' }, projection: { id: true } },
        );

        expect(result).toEqual([
          [
            { id: 'id-001' },
            { id: 'id-003' },
            { id: 'id-005' },
            { id: 'id-000' },
          ],
          [{ id: 'id-002' }, { id: 'id-004' }],
        ]);
      });

      it('should paginate correctly with single field descending order', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Charlie', age: 35 }),
          createTestEntity({ name: 'Alice', age: 25 }),
          createTestEntity({ name: 'David', age: 40 }),
          createTestEntity({ name: 'Bob', age: 30 }),
          createTestEntity({ name: 'Eve', age: 45 }),
        ]);

        const result = await pages(
          repo,
          {},
          { limit: 2, orderBy: { name: 'desc' }, projection: { name: true } },
        );

        expect(result).toEqual([
          [{ name: 'Eve' }, { name: 'David' }],
          [{ name: 'Charlie' }, { name: 'Bob' }],
          [{ name: 'Alice' }],
        ]);
      });

      it('should paginate correctly with multi-field ordering (mixed directions)', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Alice', age: 30, isActive: true }),
          createTestEntity({ name: 'Bob', age: 25, isActive: true }),
          createTestEntity({ name: 'Charlie', age: 30, isActive: false }),
          createTestEntity({ name: 'David', age: 25, isActive: true }),
          createTestEntity({ name: 'Eve', age: 35, isActive: false }),
        ]);

        const result = await pages(
          repo,
          {},
          {
            limit: 2,
            orderBy: { age: 'desc', name: 'asc' },
            projection: { name: true, age: true },
          },
        );

        expect(result).toEqual([
          [
            { name: 'Eve', age: 35 },
            { name: 'Alice', age: 30 },
          ],
          [
            { name: 'Charlie', age: 30 },
            { name: 'Bob', age: 25 },
          ],
          [{ name: 'David', age: 25 }],
        ]);
      });

      it('handles null correctly (asc)', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Alice', age: 25 }),
          createTestEntity({ name: 'Bob', age: null as any }),
          createTestEntity({ name: 'Charlie', age: 30 }),
          createTestEntity({ name: 'David', age: null as any }),
          createTestEntity({ name: 'Eve', age: 35 }),
        ]);

        const result = await pages(
          repo,
          {},
          { limit: 4, orderBy: { age: 'asc' }, projection: { name: true } },
        );

        expect(result).toEqual([
          [
            { name: 'Bob' },
            { name: 'David' },
            { name: 'Alice' },
            { name: 'Charlie' },
          ],
          [{ name: 'Eve' }],
        ]);
      });

      it('handles null correctly (desc)', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Alice', age: 25 }),
          createTestEntity({ name: 'Bob', age: null as any }),
          createTestEntity({ name: 'Charlie', age: 30 }),
          createTestEntity({ name: 'David', age: null as any }),
          createTestEntity({ name: 'Eve', age: 35 }),
        ]);

        const result = await pages(
          repo,
          {},
          { limit: 4, orderBy: { age: 'desc' }, projection: { name: true } },
        );

        expect(result).toEqual([
          [
            { name: 'Eve' },
            { name: 'Charlie' },
            { name: 'Alice' },
            { name: 'Bob' },
          ],
          [{ name: 'David' }],
        ]);
      });

      it('skips docs with an undefined orderBy field', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Alice', age: 25 }),
          createTestEntity({ name: 'Bob', age: undefined as any }),
          createTestEntity({ name: 'Charlie', age: 30 }),
          createTestEntity({ name: 'David', age: undefined as any }),
          createTestEntity({ name: 'Eve', age: 35 }),
        ]);

        const result = await pages(
          repo,
          {},
          { limit: 4, orderBy: { age: 'asc' }, projection: { name: true } },
        );

        expect(result).toEqual([
          [{ name: 'Alice' }, { name: 'Charlie' }, { name: 'Eve' }],
        ]);
      });

      it('should work correctly with filters and custom ordering', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'Alice', age: 25, isActive: true }),
          createTestEntity({ name: 'Bob', age: 30, isActive: false }),
          createTestEntity({ name: 'Charlie', age: 35, isActive: true }),
          createTestEntity({ name: 'David', age: 40, isActive: false }),
          createTestEntity({ name: 'Eve', age: 45, isActive: true }),
          createTestEntity({ name: 'Frank', age: 50, isActive: false }),
        ]);

        const result = await pages(
          repo,
          { isActive: true },
          { limit: 20, orderBy: { age: 'desc' }, projection: { name: true } },
        );
        expect(result).toEqual([
          [{ name: 'Eve' }, { name: 'Charlie' }, { name: 'Alice' }],
        ]);
      });

      it('should handle documents with same sort field values using ID as tiebreaker', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'User1', age: 30 }),
          createTestEntity({ name: 'User2', age: 30 }),
          createTestEntity({ name: 'User3', age: 30 }),
          createTestEntity({ name: 'User4', age: 30 }),
          createTestEntity({ name: 'User5', age: 30 }),
        ]);

        const result = await pages(
          repo,
          {},
          { limit: 2, orderBy: { age: 'asc' }, projection: { name: true } },
        );

        expect(result).toEqual([
          [{ name: 'User1' }, { name: 'User2' }],
          [{ name: 'User3' }, { name: 'User4' }],
          [{ name: 'User5' }],
        ]);
      });

      it('should work with nested field paths in orderBy', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'A', metadata: { tags: [], notes: 'D' } }),
          createTestEntity({ name: 'B', metadata: { tags: [], notes: 'B' } }),
          createTestEntity({ name: 'C', metadata: { tags: [], notes: 'C' } }),
          createTestEntity({ name: 'D', metadata: { tags: [], notes: 'A' } }),
        ]);

        const result = await pages(
          repo,
          {},
          {
            limit: 2,
            orderBy: { 'metadata.notes': 'asc' },
            projection: { name: true },
          },
        );

        expect(result).toEqual([
          [{ name: 'D' }, { name: 'B' }],
          [{ name: 'C' }, { name: 'A' }],
        ]);
      });

      it('should correctly handle id in orderBy and ignore fields after it', async () => {
        const repo = createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { generateId: ascendingIds(), mirrorId: true },
        });

        await repo.createMany([
          createTestEntity({ name: 'User1', age: 30 }),
          createTestEntity({ name: 'User2', age: 30 }),
          createTestEntity({ name: 'User3', age: 33 }),
          createTestEntity({ name: 'User4', age: 30 }),
        ]);

        // orderBy includes id explicitly, followed by name (which should be ignored)
        const result = await pages(
          repo,
          {},
          {
            limit: 2,
            orderBy: { age: 'asc', id: 'asc', name: 'desc' },
            projection: { name: true },
          },
        );

        expect(result).toEqual([
          [{ name: 'User1' }, { name: 'User2' }],
          [{ name: 'User4' }, { name: 'User3' }],
        ]);
      });
    });
  });

  describe('count', () => {
    it('should count entities matching the filter', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
        createTestEntity({ name: 'David', age: 40, isActive: true }),
      ]);

      const totalCount = await repo.count({});
      expect(totalCount).toBe(4);

      const activeCount = await repo.count({ isActive: true });
      expect(activeCount).toBe(3);

      const age25Count = await repo.count({ age: 25 });
      expect(age25Count).toBe(1);
    });

    it('should return 0 when no entities match', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const count = await repo.count({ name: 'Non-existent' });
      expect(count).toBe(0);
    });

    it('should support counting by id field', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const [aId, bId] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
      ]);

      expect(await repo.count({ id: aId })).toBe(1);
      expect(await repo.count({ id: bId })).toBe(1);
      expect(await repo.count({ id: 'does-not-exist' })).toBe(0);
    });

    it('should ignore scope-breaches (no scope filter on reads)', async () => {
      const scopedCollection = scopedTestCollection('tenant-A');
      const base = createSmartFirestoreRepo({
        collection: scopedCollection,
        firestore: firestore.firestore,
      });
      const id = await base.create(
        createTestEntity({ tenantId: 'wrong-tenant', name: 'Scoped' }),
      );

      const scoped = createSmartFirestoreRepo({
        collection: scopedTestCollection('tenant-A'),
        firestore: firestore.firestore,
      });

      expect(await scoped.count({ id })).toBe(1);
    });

    it('should return 0 on scope-breach by default and throw when configured', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });
      expect(await repo.count({ tenantId: 'other' })).toBe(0);

      await expect(
        repo.count({ tenantId: 'other' }, { onScopeBreach: 'error' }),
      ).rejects.toThrow('Scope breach detected in count filter');
    });
  });

  describe('findBySpec, countBySpec', () => {
    it('should support findBySpec and countBySpec with basic specifications', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
      ]);

      const activeUsersSpec: Specification<TestEntity> = {
        toFilter: () => ({ isActive: true }),
        describe: 'active users',
      };

      const specificAgeSpec: Specification<TestEntity> = {
        toFilter: () => ({ age: 25 }),
        describe: 'users aged 25',
      };

      const activeUsers = await repo.findBySpec(activeUsersSpec).toArray();
      expect(activeUsers).toHaveLength(2);
      activeUsers.forEach((user) => expect(user.isActive).toBe(true));

      const youngUsers = await repo.findBySpec(specificAgeSpec).toArray();
      expect(youngUsers).toHaveLength(1);
      expect(youngUsers[0].name).toBe('Alice');

      const activeCount = await repo.countBySpec(activeUsersSpec);
      expect(activeCount).toBe(2);

      const youngCount = await repo.countBySpec(specificAgeSpec);
      expect(youngCount).toBe(1);
    });

    it('should support findBySpec with projections', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const entity = createTestEntity({
        name: 'Test User',
        age: 30,
        isActive: true,
      });
      await repo.create(entity);

      const spec: Specification<TestEntity> = {
        toFilter: () => ({ isActive: true }),
        describe: 'active users',
      };

      const results = await repo
        .findBySpec(spec, {
          projection: { id: true, name: true },
        })
        .toArray();
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('name');
      expect(results[0]).not.toHaveProperty('age');
      expect(results[0]).not.toHaveProperty('isActive');
    });

    it('should support specification composition with combineSpecs', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 25, isActive: false }),
      ]);

      const activeSpec: Specification<TestEntity> = {
        toFilter: () => ({ isActive: true }),
        describe: 'active users',
      };

      const youngSpec: Specification<TestEntity> = {
        toFilter: () => ({ age: 25 }),
        describe: 'users aged 25',
      };

      const combinedSpec = combineSpecs(activeSpec, youngSpec);

      const results = await repo.findBySpec(combinedSpec).toArray();
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Alice');
      expect(results[0].isActive).toBe(true);
      expect(results[0].age).toBe(25);

      expect(combinedSpec.describe).toBe('active users AND users aged 25');

      const count = await repo.countBySpec(combinedSpec);
      expect(count).toBe(1);
    });
  });

  describe('soft delete', () => {
    it('soft deleted entities stay in the database', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Test Entity' }));
      await repo.delete(id);

      const raw = await rawTestCollection().doc(id).get();
      expect(raw.exists).toBe(true);
      expect(raw.data()).toMatchObject({ _deleted: true });
    });

    it('update should not touch soft-deleted entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Test Entity' }));
      await repo.delete(id);

      await repo.update(id, { set: { name: 'Should Not Update' } });
      const raw = await rawTestCollection().doc(id).get();
      const data = raw.data()!;
      expect(data._deleted).toBe(true);
      expect(data.name).toBe('Test Entity');
    });

    it('should not return soft-deleted entities in reads', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const [a, b, c] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
        createTestEntity({ name: 'C' }),
      ]);

      await repo.delete(b);

      const foundAll = await repo.find({}).toArray();
      expect(foundAll.map((e) => e.name)).toEqual(
        expect.arrayContaining(['A', 'C']),
      );

      const gotB = await repo.getById(b);
      expect(gotB).toBeUndefined();

      const [found, notFound] = await repo.getByIds([a, b, c]);
      expect(found.map((e) => e.name)).toEqual(
        expect.arrayContaining(['A', 'C']),
      );
      expect(notFound).toEqual([b]);

      const count = await repo.count({});
      expect(count).toBe(2);
    });

    it('should soft delete many', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const ids = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
        createTestEntity({ name: 'C' }),
      ]);

      await repo.deleteMany([ids[0], ids[2]]);

      const remaining = await repo.find({}).toArray();
      expect(remaining.map((e) => e.name).sort()).toEqual(['B']);
      const count = await repo.count({});
      expect(count).toBe(1);
    });
  });

  describe('scoping', () => {
    it('reads do not enforce field scope; writes still validate when scope provided', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const [a, b] = await repo.createMany([
        createTestEntity({ name: 'A', tenantId: 'acme' }),
        createTestEntity({ name: 'B', tenantId: 'not-acme' }),
      ]);

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      // getById returns both
      expect(await scoped.getById(a)).toBeDefined();
      expect(await scoped.getById(b)).toBeDefined();

      // find/count ignore scope on reads
      expect((await scoped.find({}).toArray()).length).toBe(2);
      expect(await scoped.count({})).toBe(2);
    });

    it('adds scope when creating entities', async () => {
      const scopedRepo = createSmartFirestoreRepo({
        collection: scopedTestCollection('acme'),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const id = await scopedRepo.create(omit(createTestEntity(), 'tenantId'));
      const moreIds = await scopedRepo.createMany(
        range(0, 2).map((_) => omit(createTestEntity(), 'tenantId')),
      );

      const result = await scopedRepo.getByIds([id, ...moreIds], {
        tenantId: true,
      });

      expect(result).toEqual([
        [{ tenantId: 'acme' }, { tenantId: 'acme' }, { tenantId: 'acme' }],
        [],
      ]);
    });

    it('should validate scope property values during create', async () => {
      const scopedRepo = createSmartFirestoreRepo({
        collection: scopedTestCollection('acme'),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      // this should work (matching scope value)
      const validEntity = createTestEntity({
        name: 'Valid User',
        tenantId: 'acme', // matches scope
      });
      await scopedRepo.create(validEntity);

      // this should also work (no scope property - will be added automatically)
      const { tenantId, ...entityWithoutScope } = createTestEntity({
        name: 'Valid User No Scope',
      });
      await scopedRepo.create(entityWithoutScope);

      // this should fail - wrong scope value
      const invalidEntity = createTestEntity({
        name: 'Invalid User',
        tenantId: 'not-acme', // doesn't match scope
      });
      await expect(scopedRepo.create(invalidEntity)).rejects.toThrow(
        "Cannot create entity: scope property 'tenantId' must be 'acme', got 'not-acme'",
      );
    });

    it('should prevent updating scope properties', async () => {
      const baseRepo = createSmartFirestoreRepo({
        collection: scopedTestCollection('acme'),
        firestore: firestore.firestore,
      });
      const scopedRepo = createSmartFirestoreRepo({
        collection: scopedTestCollection('acme'),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const entity = createTestEntity({ name: 'Test User', tenantId: 'acme' });
      const id = await baseRepo.create(entity);

      // this should work (no scope property)
      await scopedRepo.update(id, { set: { name: 'Updated Name' } });

      // this should fail at runtime (scope property in set)
      await expect(
        scopedRepo.update(id, { set: { tenantId: 'not-acme' } } as any),
      ).rejects.toThrow('Cannot update readonly properties: tenantId');

      // this should fail at runtime (scope property in set even if it matches scope)
      await expect(
        scopedRepo.update(id, { set: { tenantId: 'acme' } } as any),
      ).rejects.toThrow('Cannot update readonly properties: tenantId');

      // this should fail at runtime (scope property in unset)
      await expect(
        scopedRepo.update(id, { unset: ['tenantId'] } as any),
      ).rejects.toThrow('Cannot unset readonly properties: tenantId');
    });

    it('should allow reading scope properties', async () => {
      const scopedRepo = createSmartFirestoreRepo({
        collection: scopedTestCollection('acme'),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      await scopedRepo.createMany([
        createTestEntity({ name: 'Active User 1', tenantId: 'acme' }),
        createTestEntity({ name: 'Active User 2', tenantId: 'acme' }),
      ]);

      const activeUsers = await scopedRepo.find({ tenantId: 'acme' }).toArray();
      expect(activeUsers).toHaveLength(2);
      expect(
        await scopedRepo.find({ tenantId: 'not-acme' }).toArray(),
      ).toHaveLength(0);

      const projectedUsers = await scopedRepo
        .find({}, { projection: { tenantId: true, name: true } })
        .toArray();
      expect(projectedUsers).toHaveLength(2);
      projectedUsers.forEach((user) => {
        expect(user).toHaveProperty('tenantId');
        expect(user).toHaveProperty('name');
        expect(user).not.toHaveProperty('email');
      });
    });

    it('supports multi-property scope on writes (validation and readonly)', async () => {
      const scopedRepo = createSmartFirestoreRepo({
        collection: scopedTestCollection('acme'),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme', age: 30 },
      });

      const [id1, id2] = await scopedRepo.createMany([
        omit(createTestEntity({ name: 'Match 1' }), 'tenantId', 'age'),
        omit(createTestEntity({ name: 'Match 2' }), 'tenantId', 'age'),
      ]);

      const results = await scopedRepo
        .find({}, { projection: { tenantId: true, age: true } })
        .toArray();
      expect(results).toHaveLength(2);
      results.forEach((user) => {
        expect(user).toMatchObject({ tenantId: 'acme', age: 30 });
      });

      await expect(
        scopedRepo.update(id1, { set: { age: 31 } } as any),
      ).rejects.toThrow('Cannot update readonly properties: age');
      await expect(
        scopedRepo.update(id2, { unset: ['tenantId'] } as any),
      ).rejects.toThrow('Cannot unset readonly properties: tenantId');
    });

    it('treats empty scope as no scope', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const emptyScopedRepo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: {},
      });

      const [id1, id2] = await repo.createMany([
        createTestEntity({ name: 'U1', tenantId: 'acme', age: 30 }),
        createTestEntity({ name: 'U2', tenantId: 'not-acme', age: 31 }),
        createTestEntity({ name: 'U3', tenantId: 'acme', age: 32 }),
      ]);

      // empty scope should not filter results
      const allFromEmptyScope = await emptyScopedRepo.find({}).toArray();
      expect(allFromEmptyScope.map((u) => u.name).sort()).toEqual([
        'U1',
        'U2',
        'U3',
      ]);
      expect(await emptyScopedRepo.count({})).toBe(3);

      // access by id should work for any entity
      expect(await emptyScopedRepo.getById(id2)).toBeDefined();

      // updates should not have readonly restrictions (since there is no scope)
      await emptyScopedRepo.update(id1, { set: { tenantId: 'changed' } });
      expect(await emptyScopedRepo.getById(id1, { tenantId: true })).toEqual({
        tenantId: 'changed',
      });
    });
  });

  describe('identity', () => {
    it('uses server-generated ids by default and does not mirror by default', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const createdId = await repo.create(createTestEntity({ name: 'A' }));
      expect(typeof createdId).toBe('string');

      // raw doc exists and does not persist id field when mirrorId=false
      const raw = await rawTestCollection().doc(createdId).get();
      const data = raw.data();
      expect(data).toBeTruthy();
      expect(data).not.toHaveProperty('id');

      // entity exposes idKey ('id' by default)
      const got = await repo.getById(createdId);
      expect(got).toMatchObject({ id: createdId, name: 'A' });
    });

    it('mirrors id into document when mirrorId=true', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { mirrorId: true },
      });

      const id = await repo.create(createTestEntity({ name: 'B' }));
      const raw = await rawTestCollection().doc(id).get();
      expect(raw.data()).toHaveProperty('id', id);
    });

    it('supports custom generateId function', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { generateId: () => 'custom-abc' },
      });

      const id = await repo.create(createTestEntity({ name: 'C' }));
      expect(id).toBe('custom-abc');
      const got = await repo.getById(id);
      expect(got?.id).toBe('custom-abc');
    });

    it('supports custom idKey without mirroring', async () => {
      type EntityWithAlias = TestEntity & { entityId: string };
      const repo = createSmartFirestoreRepo<EntityWithAlias>({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithAlias>,
        firestore: firestore.firestore,
        options: { idKey: 'entityId' },
      });

      const id = await repo.create({
        ...(createTestEntity({ name: 'D' }) as any),
      });

      const got = await repo.getById(id);
      expect(got).toHaveProperty('entityId', id);

      // filter by idKey should map to document id
      const found = await repo.find({ entityId: id }).toArray();
      expect(found.map((e) => e.entityId)).toEqual([id]);

      // projection should include computed idKey
      const proj = await repo.getById(id, { entityId: true, name: true });
      expect(proj).toEqual({ entityId: id, name: 'D' });
    });

    it('treats idKey as readonly on update', async () => {
      const repo = createSmartFirestoreRepo<TestEntity>({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const id = await repo.create(createTestEntity({ name: 'E' }));
      await expect(
        repo.update(id, { set: { id: 'hacked' } } as any),
      ).rejects.toThrow('Cannot update readonly properties');
    });
  });

  describe('trace timestamps', () => {
    it('should set timestamps when traceTimestamps enabled (app time)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true, traceTimestamps: true },
      });

      const id = await repo.create(createTestEntity({ name: 'TS' }));

      let raw = await rawTestCollection().doc(id).get();
      const d1 = convertFirestoreTimestamps(raw.data());
      expect(d1?._createdAt).toBeInstanceOf(Date);
      expect(d1?._updatedAt).toBeInstanceOf(Date);
      expect(d1?._deletedAt).toBeUndefined();
      // createdAt and updatedAt should be equal on create
      expect(d1!._createdAt.getTime()).toBe(d1!._updatedAt.getTime());

      // ensure the next update happens at a later timestamp
      await new Promise((r) => setTimeout(r, 2));
      await repo.update(id, { set: { name: 'TS2' } });
      raw = await rawTestCollection().doc(id).get();
      const d2 = convertFirestoreTimestamps(raw.data());
      expect(d2?._updatedAt).toBeInstanceOf(Date);
      expect(d2!._updatedAt.getTime()).toBeGreaterThan(
        d1!._updatedAt.getTime(),
      );

      // ensure delete happens at a later timestamp
      await new Promise((r) => setTimeout(r, 2));
      await repo.delete(id);
      raw = await rawTestCollection().doc(id).get();
      const d3 = convertFirestoreTimestamps(raw.data());
      expect(d3?._deletedAt).toBeInstanceOf(Date);
      // on delete, updatedAt and deletedAt should be equal and newer than previous updatedAt
      expect(d3!._updatedAt.getTime()).toBe(d3!._deletedAt.getTime());
      expect(d3!._updatedAt.getTime()).toBeGreaterThan(
        d2!._updatedAt.getTime(),
      );
    });

    it('should set timestamps using Firestore server time', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true, traceTimestamps: 'server' },
      });

      const id = await repo.create(createTestEntity({ name: 'TS-M' }));
      let raw = await rawTestCollection().doc(id).get();
      const d1 = convertFirestoreTimestamps(raw.data());
      expect(d1?._createdAt).toBeInstanceOf(Date);
      expect(d1?._updatedAt).toBeInstanceOf(Date);

      await new Promise((r) => setTimeout(r, 2));
      await repo.update(id, { set: { name: 'TS2' } });
      raw = await rawTestCollection().doc(id).get();
      const d2 = convertFirestoreTimestamps(raw.data());
      expect(d2!._updatedAt.getTime()).toBeGreaterThan(
        d1!._updatedAt.getTime(),
      );

      await new Promise((r) => setTimeout(r, 2));
      await repo.delete(id);
      raw = await rawTestCollection().doc(id).get();
      const d3 = convertFirestoreTimestamps(raw.data());
      expect(d3!._updatedAt.getTime()).toBe(d3!._deletedAt.getTime());
      expect(d3!._updatedAt.getTime()).toBeGreaterThan(
        d2!._updatedAt.getTime(),
      );
    });

    it('should use custom clock function', async () => {
      let t = new Date('2020-01-01T00:00:00Z');
      const clock = () => new Date(t);
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true, traceTimestamps: clock },
      });

      const id = await repo.create(createTestEntity({ name: 'TS-C' }));
      let raw = await rawTestCollection().doc(id).get();
      const d1 = convertFirestoreTimestamps(raw.data());
      expect(d1!._createdAt.getTime()).toBe(t.getTime());
      expect(d1!._updatedAt.getTime()).toBe(t.getTime());

      t = new Date('2020-01-01T00:00:01Z');
      await repo.update(id, { set: { name: 'X' } });
      raw = await rawTestCollection().doc(id).get();
      const d2 = convertFirestoreTimestamps(raw.data());
      expect(d2!._updatedAt.getTime()).toBe(t.getTime());

      t = new Date('2020-01-01T00:00:02Z');
      await repo.delete(id);
      raw = await rawTestCollection().doc(id).get();
      const d3 = convertFirestoreTimestamps(raw.data());
      expect(d3!._deletedAt.getTime()).toBe(t.getTime());
      expect(d3!._updatedAt.getTime()).toBe(t.getTime());
    });
  });

  describe('configurable timestamp keys', () => {
    type EntityWithTimestamps = TestEntity & {
      createdAt: Date;
      updatedAt: Date;
      deletedAt?: Date;
    };

    it('should expose timestamp fields in reads when configured as entity properties', async () => {
      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
            deletedAt: 'deletedAt',
          },
        },
      });

      const id = await repo.create(
        createTestEntity({ name: 'Timestamp Test' }),
      );

      const retrieved = await repo.getById(id);
      expect(retrieved).toHaveProperty('createdAt');
      expect(retrieved).toHaveProperty('updatedAt');
      expect(retrieved!.createdAt).toBeInstanceOf(Date);
      expect(retrieved!.updatedAt).toBeInstanceOf(Date);
      expect(retrieved!.createdAt.getTime()).toBe(
        retrieved!.updatedAt.getTime(),
      );
    });

    it('should support projections including timestamp fields', async () => {
      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const id = await repo.create(
        createTestEntity({ name: 'Projection Test' }),
      );

      const timestampsOnly = await repo.getById(id, {
        name: true,
        createdAt: true,
        updatedAt: true,
      });
      expect(timestampsOnly).toMatchObject({
        name: 'Projection Test',
        createdAt: timestampsOnly!.createdAt,
        updatedAt: timestampsOnly!.updatedAt,
      });
      expect(timestampsOnly).not.toHaveProperty('email');
    });

    it('should update timestamp fields during update operations', async () => {
      let testTime = new Date('2023-01-01T00:00:00Z');
      const clock = () => testTime;

      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          traceTimestamps: clock,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const id = await repo.create(createTestEntity({ name: 'Update Test' }));

      const initial = (await repo.getById(id)) as any;
      expect(initial.createdAt.getTime()).toBe(testTime.getTime());
      expect(initial.updatedAt.getTime()).toBe(testTime.getTime());

      // advance time and update
      testTime = new Date('2023-01-01T01:00:00Z');
      await repo.update(id, { set: { name: 'Updated Name' } });

      const updated = (await repo.getById(id)) as any;
      expect(updated.name).toBe('Updated Name');
      expect(updated.createdAt.getTime()).toBe(
        new Date('2023-01-01T00:00:00Z').getTime(),
      );
      expect(updated.updatedAt.getTime()).toBe(testTime.getTime());
    });

    it('should prevent writing to configured timestamp fields', async () => {
      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const id = await repo.create(createTestEntity({ name: 'Readonly Test' }));

      await expect(
        repo.update(id, { set: { createdAt: new Date() } } as any),
      ).rejects.toThrow('Cannot update readonly properties: createdAt');

      await expect(
        repo.update(id, { set: { updatedAt: new Date() } } as any),
      ).rejects.toThrow('Cannot update readonly properties: updatedAt');
    });

    it('should support partial timestamp configuration', async () => {
      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            // only configure createdAt, others use defaults (hidden)
            createdAt: 'createdAt',
          },
        },
      });

      const entity = {
        ...createTestEntity({ name: 'Partial Config Test' }),
        updatedAt: new Date('2023-01-01T00:00:00Z'),
      } as any;
      const id = await repo.create(entity);

      const retrieved = (await repo.getById(id)) as any;
      expect(retrieved).toHaveProperty('createdAt');
      expect(retrieved.updatedAt.getTime()).toBe(entity.updatedAt.getTime());
      expect(retrieved).not.toHaveProperty('_updatedAt');

      // raw should have hidden default _updatedAt
      const raw = await rawTestCollection().doc(id).get();
      const converted = convertFirestoreTimestamps(raw.data());
      expect(converted).toHaveProperty('_updatedAt');
    });

    it('should automatically enable timestamps when timestampKeys are configured', async () => {
      const repo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<EntityWithTimestamps>,
        firestore: firestore.firestore,
        options: {
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const id = await repo.create(
        createTestEntity({ name: 'Auto Timestamps Test' }),
      );

      const retrieved = (await repo.getById(id)) as any;
      expect(retrieved).toHaveProperty('createdAt');
      expect(retrieved).toHaveProperty('updatedAt');
      expect(retrieved.createdAt).toBeInstanceOf(Date);
      expect(retrieved.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('id generation', () => {
    it('should use custom id generation', async () => {
      let counter = 0;
      const customGenerateId = () => `fs-custom-${++counter}`;

      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: {
          generateId: customGenerateId,
        },
      });

      const id1 = await repo.create(createTestEntity({ name: 'Custom 1' }));
      const id2 = await repo.create(createTestEntity({ name: 'Custom 2' }));

      expect(id1).toBe('fs-custom-1');
      expect(id2).toBe('fs-custom-2');

      const got1 = await repo.getById(id1);
      const got2 = await repo.getById(id2);
      expect(got1?.id).toBe('fs-custom-1');
      expect(got2?.id).toBe('fs-custom-2');
    });

    it('should default to server-generated ids', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await repo.create(createTestEntity({ name: 'Server ID' }));
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      const got = await repo.getById(id);
      expect(got?.id).toBe(id);
    });
  });

  describe('version counter', () => {
    it('should increment version with hidden field when version: true', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { version: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Version Test' }));

      // check initial version in raw document
      const raw1 = await rawTestCollection().doc(id).get();
      expect(raw1.data()).toHaveProperty('_version', 1);

      // update and check version increment
      await repo.update(id, { set: { name: 'Updated' } });
      const raw2 = await rawTestCollection().doc(id).get();
      expect(raw2.data()).toHaveProperty('_version', 2);

      // entity should not include hidden version field
      const retrieved = await repo.getById(id);
      expect(retrieved).not.toHaveProperty('_version');
    });

    it('should increment version with entity field when version key is configured', async () => {
      type VersionedEntity = TestEntity & {
        version: number;
      };

      const repo = createSmartFirestoreRepo<VersionedEntity>({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<VersionedEntity>,
        firestore: firestore.firestore,
        options: { version: 'version' },
      });

      const entity = createTestEntity({ name: 'Entity Version Test' }) as any;
      const id = await repo.create(entity);

      // check initial version
      const retrieved1 = await repo.getById(id);
      expect(retrieved1).toHaveProperty('version', 1);

      // update and check version increment
      await repo.update(id, { set: { name: 'Updated Entity' } });
      const retrieved2 = await repo.getById(id);
      expect(retrieved2).toHaveProperty('version', 2);
    });

    it('should increment version on soft delete', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { version: true, softDelete: true },
      });

      const id = await repo.create(
        createTestEntity({ name: 'Delete Version Test' }),
      );

      // check initial version
      const raw1 = await rawTestCollection().doc(id).get();
      expect(raw1.data()).toHaveProperty('_version', 1);

      // soft delete and check version increment
      await repo.delete(id);
      const raw2 = await rawTestCollection().doc(id).get();
      expect(raw2.data()).toHaveProperty('_version', 2);
      expect(raw2.data()).toHaveProperty('_deleted', true);
    });

    it('should work with bulk operations', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { version: true },
      });

      const ids = await repo.createMany([
        createTestEntity({ name: 'Bulk 1' }),
        createTestEntity({ name: 'Bulk 2' }),
        createTestEntity({ name: 'Bulk 3' }),
      ]);

      for (const id of ids) {
        const raw = await rawTestCollection().doc(id).get();
        expect(raw.data()).toHaveProperty('_version', 1);
      }

      await repo.updateMany(ids, { set: { name: 'Updated Bulk' } });

      for (const id of ids) {
        const raw = await rawTestCollection().doc(id).get();
        expect(raw.data()).toHaveProperty('_version', 2);
      }
    });

    it('should not interfere when version is disabled', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await repo.create(
        createTestEntity({ name: 'No Version Test' }),
      );

      // should not have version field
      const raw = await rawTestCollection().doc(id).get();
      expect(raw.data()).not.toHaveProperty('_version');

      // update should still work without version
      await repo.update(id, { set: { name: 'Updated No Version' } });
      const raw2 = await rawTestCollection().doc(id).get();
      expect(raw2.data()).not.toHaveProperty('_version');
    });
  });

  describe('advanced operations', () => {
    it('buildUpdateOperation sets timestamps', async () => {
      let t = new Date('2025-01-01T00:00:00.000Z');
      const clock = () => t;
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { traceTimestamps: clock },
      });

      const [id1, id2, id3] = await repo.createMany(
        range(0, 3).map((_) => createTestEntity()),
      );

      t = new Date('2025-01-01T00:00:01.000Z');

      const batch = firestore.firestore.batch();
      const updates = [
        { id: id1, set: { name: 'Updated1' } },
        { id: id2, set: { name: 'Updated2' } },
        { id: id3, set: { name: 'Updated3' } },
      ];
      for (const u of updates) {
        const ref = rawTestCollection().doc(u.id);
        batch.update(ref, repo.buildUpdateOperation(u));
      }
      await batch.commit();

      const raw1 = convertFirestoreTimestamps(
        (await rawTestCollection().doc(id1).get()).data(),
      );
      const raw2 = convertFirestoreTimestamps(
        (await rawTestCollection().doc(id2).get()).data(),
      );
      const raw3 = convertFirestoreTimestamps(
        (await rawTestCollection().doc(id3).get()).data(),
      );

      expect(raw1).toMatchObject({ name: 'Updated1', _updatedAt: t });
      expect(raw2).toMatchObject({ name: 'Updated2', _updatedAt: t });
      expect(raw3).toMatchObject({ name: 'Updated3', _updatedAt: t });
    });

    it('buildUpdateOperation prevents writing read-only props (runtime)', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { version: true, softDelete: true, traceTimestamps: true },
      });

      // readonly system fields
      expect(() =>
        repo.buildUpdateOperation({ set: { _createdAt: new Date() } as any }),
      ).toThrow('Cannot update readonly properties: _createdAt');
      expect(() =>
        repo.buildUpdateOperation({ unset: ['_deleted'] as any }),
      ).toThrow('Cannot unset readonly properties: _deleted');

      // scope properties become readonly on update when scope configured
      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });
      expect(() =>
        scoped.buildUpdateOperation({ set: { tenantId: 'x' } as any }),
      ).toThrow('Cannot update readonly properties: tenantId');
      expect(() =>
        scoped.buildUpdateOperation({ unset: ['tenantId'] as any }),
      ).toThrow('Cannot unset readonly properties: tenantId');
    });

    it('applyConstraints excludes soft-deleted documents', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      const [, b] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
      ]);
      // soft delete B
      await repo.delete(b);

      const q = repo.applyConstraints(
        repo.collection.where('name', 'in', ['A', 'B']),
      );
      const snap = await (q as any).get();
      const names = snap.docs.map((d: any) => d.data().name);
      expect(names).toEqual(['A']);
    });

    it('applyConstraints does not add scope filters (reads ignore scope)', async () => {
      const base = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      // create documents without scope so one breaches the would-be scope
      await base.createMany([
        createTestEntity({ name: 'A', tenantId: 'acme' }),
        createTestEntity({ name: 'B', tenantId: 'not-acme' }),
      ]);

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
        options: { softDelete: true },
      });

      const q = scoped.applyConstraints(
        scoped.collection.where('name', 'in', ['A', 'B']),
      );
      const snap = await (q as any).get();
      const names = snap.docs.map((d: any) => d.data().name).sort();
      expect(names).toEqual(['A', 'B']);
    });
  });

  describe('transactions', () => {
    it('withTransaction should apply all operations within the same transaction', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      // prepare data outside the transaction
      const createdIds = await repo.createMany([
        createTestEntity({ name: 'TX Entity 1' }),
        createTestEntity({ name: 'TX Entity 2' }),
        createTestEntity({ name: 'TX Entity 3' }),
      ]);

      await firestore.firestore.runTransaction(async (tx) => {
        const txRepo = repo.withTransaction(tx);

        // read first
        const before = await txRepo.find({}).toArray();
        expect(before).toHaveLength(3);

        // then writes
        await txRepo.update(createdIds[0], { set: { age: 99 } });
        await txRepo.delete(createdIds[2]);
      });

      // verify changes persisted after transaction
      const finalEntities = await repo.find({}).toArray();
      expect(finalEntities).toHaveLength(2);
      expect(finalEntities.some((e) => e.name === 'TX Entity 1')).toBe(true);
      expect(finalEntities.some((e) => e.name === 'TX Entity 2')).toBe(true);
      expect(finalEntities.some((e) => e.name === 'TX Entity 3')).toBe(false);
      expect(finalEntities.find((e) => e.name === 'TX Entity 1')?.age).toBe(99);
    });

    it('runTransaction should execute all operations within a transaction', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      // prepare data outside the transaction
      const createdIds = await repo.createMany([
        createTestEntity({ name: 'Run TX 1', age: 25 }),
        createTestEntity({ name: 'Run TX 2', age: 30 }),
        createTestEntity({ name: 'Run TX 3', age: 35 }),
      ]);

      await repo.runTransaction(async (txRepo) => {
        // reads first
        const existing = await txRepo.find({}).toArray();
        expect(existing).toHaveLength(3);
        // writes after reads
        await txRepo.updateMany(createdIds, { set: { age: 40 } });
      });

      // verify changes persisted
      const finalEntities = await repo.find({ age: 40 }).toArray();
      expect(finalEntities).toHaveLength(3);
      expect(finalEntities.map((e) => e.name)).toEqual(
        expect.arrayContaining(['Run TX 1', 'Run TX 2', 'Run TX 3']),
      );
    });

    it('should rollback all changes when withTransaction transaction fails', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      // create some initial data
      const initialEntity = createTestEntity({ name: 'Initial Entity' });
      const initialId = await repo.create(initialEntity);

      try {
        await firestore.firestore.runTransaction(async (tx) => {
          const txRepo = repo.withTransaction(tx);

          // read first
          const exists = await txRepo.getById(initialId);
          expect(exists).toBeDefined();

          // update first (performs a read + write internally)
          await txRepo.update(initialId, {
            set: { name: 'Should Not Be Updated' },
          });

          // then pure writes (no reads)
          await txRepo.createMany([
            createTestEntity({ name: 'Should Not Persist 1' }),
            createTestEntity({ name: 'Should Not Persist 2' }),
          ]);

          // trigger rollback
          throw new Error('Intentional transaction failure');
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'Intentional transaction failure',
        );
      }

      // verify rollback - only initial entity should exist with original values
      const finalEntities = await repo.find({}).toArray();
      expect(finalEntities).toHaveLength(1);
      expect(finalEntities[0].name).toBe('Initial Entity');
    });

    it('should rollback all changes when runTransaction fails', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const initialIds = await repo.createMany([
        createTestEntity({ name: 'Existing 1', age: 20 }),
        createTestEntity({ name: 'Existing 2', age: 25 }),
      ]);

      try {
        await repo.runTransaction(async (txRepo) => {
          // reads first
          const before = await txRepo.find({}).toArray();
          expect(before).toHaveLength(2);

          // writes
          await txRepo.updateMany(initialIds, { set: { age: 99 } });
          await txRepo.delete(initialIds[0]);

          // error for rollback
          throw new Error('Transaction rollback test');
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Transaction rollback test');
      }

      // verify rollback - original state should be restored
      const finalEntities = await repo.find({}).toArray();
      expect(finalEntities).toHaveLength(2);
      expect(finalEntities.map((e) => e.name)).toEqual(
        expect.arrayContaining(['Existing 1', 'Existing 2']),
      );
      expect(finalEntities.map((e) => e.age)).toEqual(
        expect.arrayContaining([20, 25]),
      );
    });

    it('should work with scoped repositories in transactions', async () => {
      const baseRepo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<TestEntity>,
        firestore: firestore.firestore,
      });
      const scopedRepo = createSmartFirestoreRepo({
        collection: firestore.firestore.collection(
          COLLECTION_NAME,
        ) as CollectionReference<TestEntity>,
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      // perform operations without violating read-after-write rules
      await scopedRepo.runTransaction(async (txRepo) => {
        await txRepo.createMany([
          omit(createTestEntity({ name: 'Scoped TX 1', age: 88 }), 'tenantId'),
          omit(createTestEntity({ name: 'Scoped TX 2', age: 88 }), 'tenantId'),
        ]);
      });

      // verify through base repo
      const allEntities = await baseRepo.find({}).toArray();
      // reads ignore scope; both should be visible in the base collection
      expect(allEntities).toHaveLength(2);
      expect(
        allEntities.every((e) => e.tenantId === 'acme' && e.age === 88),
      ).toBe(true);
    });
  });

  describe('configuration validation', () => {
    it('should throw error when timestamp keys are duplicated', () => {
      expect(() => {
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: {
            traceTimestamps: true,
            timestampKeys: {
              createdAt: 'timestamp',
              updatedAt: 'timestamp', // duplicate
              deletedAt: 'anotherField',
            },
          } as any,
        });
      }).toThrow(
        'Duplicate keys found in repository configuration: timestamp. ' +
          'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.',
      );
    });

    it('should throw error when version key conflicts with timestamp key', () => {
      expect(() => {
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: {
            traceTimestamps: true,
            timestampKeys: {
              createdAt: 'sharedKey',
              updatedAt: 'updatedAt',
              deletedAt: 'deletedAt',
            },
            version: 'sharedKey', // conflicts with createdAt
          } as any,
        });
      }).toThrow(
        'Duplicate keys found in repository configuration: sharedKey. ' +
          'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.',
      );
    });

    it('should throw error when soft delete key conflicts with other keys', () => {
      expect(() => {
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: {
            softDelete: true,
            traceTimestamps: true,
            timestampKeys: {
              createdAt: 'createdAt',
              updatedAt: '_deleted', // conflicts with soft delete key
              deletedAt: 'deletedAt',
            },
          } as any,
        });
      }).toThrow(
        'Duplicate keys found in repository configuration: _deleted. ' +
          'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.',
      );
    });

    it('should not throw error when all keys are unique', () => {
      expect(() => {
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: {
            softDelete: true,
            traceTimestamps: true,
            timestampKeys: {
              createdAt: 'created',
              updatedAt: 'updated',
              deletedAt: 'deleted',
            },
            version: 'version',
          } as any,
        });
      }).not.toThrow();
    });

    it('should throw when scope contains readonly fields', () => {
      type EntityWithReadonlyFields = TestEntity & {
        created: Date;
        _v: number;
      };
      expect(() =>
        createSmartFirestoreRepo<EntityWithReadonlyFields>({
          collection: firestore.firestore.collection(
            COLLECTION_NAME,
          ) as CollectionReference<EntityWithReadonlyFields>,
          firestore: firestore.firestore,
          options: {
            softDelete: true,
            timestampKeys: { createdAt: 'created' },
            version: '_v',
          },
          scope: {
            _v: 1 as any,
            _deleted: true as any,
            created: new Date(),
            _updatedAt: new Date() as any,
          } as any,
        }),
      ).toThrow(
        'Readonly fields found in scope: _v, _deleted, created, _updatedAt',
      );
    });

    it('should throw when bounded trace strategy is configured (not supported in Firestore)', () => {
      expect(() => {
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: {
            traceTimestamps: true,
            traceStrategy: 'bounded',
            traceLimit: 5,
          } as any,
          // Trace must be enabled for validation to run
          traceContext: { userId: 'tester' },
        });
      }).toThrow('Firestore does not support "bounded" trace strategy');
    });

    it('should allow latest and unbounded trace strategies', () => {
      expect(() => {
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { traceStrategy: 'latest' } as any,
        });
        createSmartFirestoreRepo({
          collection: testCollection(),
          firestore: firestore.firestore,
          options: { traceStrategy: 'unbounded' } as any,
        });
      }).not.toThrow();
    });
  });

  describe('tracing', () => {
    it('should not apply trace when traceContext is not provided', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await repo.create(createTestEntity({ name: 'Trace None' }));

      const raw = await rawTestCollection().doc(id).get();
      expect(raw.data()).not.toHaveProperty('_trace');
    });

    it('should apply per-operation mergeTrace even without base traceContext', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await repo.create(
        createTestEntity({ name: 'Trace Only Merge (FS)' }),
        {
          mergeTrace: { operation: 'one-off', actor: 'tester' },
        },
      );

      const raw = await rawTestCollection().doc(id).get();
      const data = convertFirestoreTimestamps(raw.data());
      expect(data._trace).toMatchObject({
        operation: 'one-off',
        actor: 'tester',
        _op: 'create',
      });
      expect(data._trace._at).toBeInstanceOf(Date);
    });

    it('should apply trace with latest strategy by default', async () => {
      const traceContext = { userId: 'user123', requestId: 'req456' };
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        traceContext,
      });

      const id = await repo.create(createTestEntity({ name: 'Trace Latest' }));
      const raw = await rawTestCollection().doc(id).get();
      const data = convertFirestoreTimestamps(raw.data());

      expect(data._trace).toMatchObject({
        userId: 'user123',
        requestId: 'req456',
        _op: 'create',
      });
      expect(data._trace._at).toBeInstanceOf(Date);
    });

    it('should use custom traceKey when specified', async () => {
      const traceContext = { userId: 'user123' };
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        traceContext,
        options: { traceKey: 'audit' },
      });

      const id = await repo.create(
        createTestEntity({ name: 'Trace Custom Key' }),
      );
      const raw = await rawTestCollection().doc(id).get();
      const data = convertFirestoreTimestamps(raw.data());

      expect(data).not.toHaveProperty('_trace');
      expect(data.audit).toMatchObject({ userId: 'user123', _op: 'create' });
      expect(data.audit._at).toBeInstanceOf(Date);
    });

    it('should merge trace context in operations', async () => {
      const traceContext = { userId: 'user123', requestId: 'req456' };
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        traceContext,
      });

      const id = await repo.create(createTestEntity({ name: 'Trace Merge' }), {
        mergeTrace: { operation: 'import-csv', source: 'upload.csv' },
      });
      const raw = await rawTestCollection().doc(id).get();
      const data = convertFirestoreTimestamps(raw.data());

      expect(data._trace).toMatchObject({
        userId: 'user123',
        requestId: 'req456',
        operation: 'import-csv',
        source: 'upload.csv',
        _op: 'create',
      });

      await repo.update(
        id,
        { set: { name: 'Updated' } },
        {
          mergeTrace: { operation: 'manual-edit' },
        },
      );
      const raw2 = await rawTestCollection().doc(id).get();
      const data2 = convertFirestoreTimestamps(raw2.data());
      expect(data2._trace).toMatchObject({
        userId: 'user123',
        requestId: 'req456',
        operation: 'manual-edit',
        _op: 'update',
      });
    });

    it('should use unbounded strategy when configured', async () => {
      const traceContext = { userId: 'user123' };
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        traceContext,
        options: { traceStrategy: 'unbounded' },
      });

      const id = await repo.create(createTestEntity({ name: 'Trace History' }));
      await repo.update(id, { set: { name: 'Updated 1' } });
      await repo.update(id, { set: { name: 'Updated 2' } });

      const raw = await rawTestCollection().doc(id).get();
      const data = convertFirestoreTimestamps(raw.data());

      // _trace is an array with at least 3 entries (create + 2 updates)
      expect(Array.isArray(data._trace)).toBe(true);
      expect(data._trace.length).toBeGreaterThanOrEqual(3);
      // last entry should be update
      expect(data._trace[data._trace.length - 1]._op).toBe('update');
    });

    it('should respect custom trace timestamp provider', async () => {
      let t = new Date('2024-03-01T00:00:00.000Z');
      const clock = () => t;
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        traceContext: { userId: 'clock' },
        options: { traceTimestamps: clock },
      });

      const id = await repo.create(createTestEntity({ name: 'Clock Trace' }));
      const raw = await rawTestCollection().doc(id).get();
      const data = convertFirestoreTimestamps(raw.data());
      expect(data._trace._at.getTime()).toBe(t.getTime());

      t = new Date('2024-03-01T00:00:05.000Z');
      await repo.update(id, { set: { name: 'Clock Update' } });
      const raw2 = await rawTestCollection().doc(id).get();
      const data2 = convertFirestoreTimestamps(raw2.data());
      expect(data2._trace._at.getTime()).toBe(t.getTime());
    });
  });
});

// Test Entity type and helper function (same as MongoDB tests)
type TestEntity = {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  age: number;
  isActive: boolean;
  metadata?: {
    tags: string[];
    notes?: string;
  };
  audit?: {
    [key: string]: any;
  };
};

type TestEntityWithTimestamps = TestEntity & {
  createdAt: Date;
  updatedAt: Date;
};

function createTestEntity(overrides: Partial<TestEntity> = {}): TestEntity {
  return {
    id: '',
    tenantId: 'org123',
    name: 'Test User',
    email: 'test@example.com',
    age: 30,
    isActive: true,
    metadata: {
      tags: ['test', 'integration'],
      notes: 'Test entity for generic repo',
    },
    ...overrides,
  };
}
