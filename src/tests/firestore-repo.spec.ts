import { CollectionReference } from '@google-cloud/firestore';
import { omit, range, sortBy } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import {
  convertFirestoreTimestamps,
  createSmartFirestoreRepo,
} from '../lib/firestore-repo';
import {
  combineSpecs,
  CreateManyPartialFailure,
  Specification,
} from '../lib/smart-repo';
import {
  clearFirestoreCollection,
  firestore,
  setupFirestore,
  teardownFirestore,
} from './firestore-fixture';

describe('createSmartFirestoreRepo', function () {
  jest.setTimeout(60 * 1000);
  const COLLECTION_NAME = 'generic_repo_test';

  beforeAll(async () => {
    await setupFirestore();
  });

  function testCollection(): CollectionReference<TestEntity> {
    return firestore.firestore.collection(
      COLLECTION_NAME
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
          COLLECTION_NAME
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
          })
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
          createTestEntity({ name: `U${i}`, email: `u${i}@e.com` })
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
      expect(retrieved).toBeNull();
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

    it('should return null for scope-breached docs (even if projection excludes scope fields)', async () => {
      const base = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const id = await base.create(
        createTestEntity({ tenantId: 'tenant-A', name: 'Scoped' })
      );

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-B' },
      });

      const result = await scoped.getById(id, { id: true, name: true });
      expect(result).toBeNull();
    });
  });

  describe('getByIds', () => {
    it('should return entities that exist and ids that do not exist', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const createdIds = await repo.createMany(
        range(0, 5).map((i) => createTestEntity({ name: `Entity ${i}` }))
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
        expect.arrayContaining(['non-existent-1', 'non-existent-2'])
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
        range(0, 3).map((i) => createTestEntity({ name: `Entity ${i}` }))
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

    it('should return only active, in-scope docs and list others in notFound', async () => {
      // Base repo with soft-delete enabled to prepare data
      const base = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        options: { softDelete: true },
      });

      // Create A (in-scope), B (in-scope, will be soft-deleted), C (out-of-scope)
      const aId = await base.create(
        createTestEntity({ tenantId: 'acme', name: 'A' })
      );
      const bId = await base.create(
        createTestEntity({ tenantId: 'acme', name: 'B' })
      );
      const cId = await base.create(
        createTestEntity({ tenantId: 'other', name: 'C' })
      );

      // Soft delete B
      await base.delete(bId);

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
        options: { softDelete: true },
      });

      const ghost = 'non-existent-id';
      const [found, notFound] = await scoped.getByIds([aId, bId, cId, ghost], {
        id: true,
        name: true,
      });

      // Only A (active, in-scope) should be found
      expect(found).toEqual([{ id: aId, name: 'A' }]);
      // B (soft-deleted), C (scope-breach), ghost (non-existent) should be notFound
      expect(notFound.sort()).toEqual([bId, cId, ghost].sort());
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

    it('should not affect non-existent entities', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      // this should not throw an error
      await repo.update('non-existent-id', { set: { name: 'New Name' } });

      // verify no entity was created
      const retrieved = await repo.getById('non-existent-id');
      expect(retrieved).toBeNull();

      const matched = await repo.find({ name: 'New Name' });
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
        'level3undefined'
      );

      // Verify null fields are preserved as null
      expect(rawData?.metadata?.nested?.field3).toBe(null);

      // Verify defined fields are present and updated
      expect(rawData?.name).toBe('Updated Name');
      expect(rawData?.metadata?.tags).toEqual(['updated']);
      expect(rawData?.metadata?.nested?.field1).toBe('updated-value1');
      expect(rawData?.metadata?.nested?.deep?.level3).toBe('updated');
    });

    it('should update existing entity in scoped collection', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const id = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'Original Name' })
      );

      await repo.update(id, { set: { name: 'Updated Name' } });

      const updated = await repo.getById(id, { name: true });

      expect(updated).toEqual({ name: 'Updated Name' });
    });

    it('should reject update that attempts to change scope', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const id = await repo.create(
        createTestEntity({ tenantId: 'acme', name: 'Original Name' })
      );

      await expect(
        repo.update(id, {
          set: { tenantId: 'foo', name: 'Updated Name' } as any,
        })
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
        createTestEntity({ tenantId: 'acme', name: 'Original Name' })
      );

      await expect(
        repo.update(id, {
          set: { _v: 47, name: 'Updated Name' } as any,
          unset: ['_createdAt'] as any,
        })
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
        createTestEntity({ tenantId: 'acme', name: 'Original Name' })
      );

      await expect(
        repo.update(id, {
          set: { name: 'Updated Name' },
          unset: ['_createdAt'] as any,
        })
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
      expect(deleted).toBeNull();
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
        createTestEntity({ name: `Entity ${i}` })
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
        createTestEntity({ name: `Entity ${i}` })
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
      expect(deleted).toBeNull();
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

      const activeUsers = await repo.find({ isActive: true });
      expect(activeUsers).toHaveLength(3);
      activeUsers.forEach((user) => {
        expect(user.isActive).toBe(true);
      });

      const youngUsers = await repo.find({ age: 25 }); // exact match only
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

      const all = await repo.find({});
      expect(all).toHaveLength(4);
    });

    it('should return empty array when no entities match', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const results = await repo.find({ name: 'Non-existent' });
      expect(results).toHaveLength(0);
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

      const projectedUsers = await repo.find(
        { isActive: true },
        { name: true, age: true }
      );

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

      const projectedUsers = await repo.find({}, { id: true, name: true });

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

      const results = await repo.find(
        { name: 'Non-existent' },
        { name: true, email: true }
      );
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

      const onlyA = await repo.find({ id: aId });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0].id).toBe(aId);

      const onlyB = await repo.find({ id: bId }, { id: true, name: true });
      expect(onlyB).toEqual([{ id: bId, name: 'B' }]);
    });

    it('should return empty when filter breaches scope even if projection excludes scope fields', async () => {
      const base = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const id = await base.create(
        createTestEntity({ tenantId: 'tenant-A', name: 'Scoped' })
      );

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-B' },
      });

      const results = await scoped.find({ id }, { id: true, name: true });
      expect(results).toHaveLength(0);
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

    it('should return 0 when counting by id that breaches scope', async () => {
      const base = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const id = await base.create(
        createTestEntity({ tenantId: 'tenant-A', name: 'Scoped' })
      );

      const scoped = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'tenant-B' },
      });

      expect(await scoped.count({ id })).toBe(0);
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

      const activeUsers = await repo.findBySpec(activeUsersSpec);
      expect(activeUsers).toHaveLength(2);
      activeUsers.forEach((user) => expect(user.isActive).toBe(true));

      const youngUsers = await repo.findBySpec(specificAgeSpec);
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

      const results = await repo.findBySpec(spec, { id: true, name: true });
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

      const results = await repo.findBySpec(combinedSpec);
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

      const foundAll = await repo.find({});
      expect(foundAll.map((e) => e.name)).toEqual(
        expect.arrayContaining(['A', 'C'])
      );

      const gotB = await repo.getById(b);
      expect(gotB).toBeNull();

      const [found, notFound] = await repo.getByIds([a, b, c]);
      expect(found.map((e) => e.name)).toEqual(
        expect.arrayContaining(['A', 'C'])
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

      const remaining = await repo.find({});
      expect(remaining.map((e) => e.name).sort()).toEqual(['B']);
      const count = await repo.count({});
      expect(count).toBe(1);
    });
  });

  describe('scoping', () => {
    it('scoped repo only has access to entities matching the scope', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const scopedRepo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const [, , notAcmeId] = await repo.createMany([
        createTestEntity({ name: 'User 1', tenantId: 'acme' }),
        createTestEntity({ name: 'User 2', tenantId: 'acme' }),
        createTestEntity({ name: 'User 3', tenantId: 'not-acme' }),
      ]);

      const notAcme = await scopedRepo.getById(notAcmeId);
      expect(notAcme).toBeNull();

      const acmeUsers = await scopedRepo.find({});
      expect(acmeUsers).toHaveLength(2);
      acmeUsers.forEach((user) => {
        expect(user.tenantId).toBe('acme');
      });

      const count = await scopedRepo.count({});
      expect(count).toBe(2);
    });

    it('adds scope when creating entities', async () => {
      const scopedRepo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const id = await scopedRepo.create(omit(createTestEntity(), 'tenantId'));
      const moreIds = await scopedRepo.createMany(
        range(0, 2).map((_) => omit(createTestEntity(), 'tenantId'))
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
        collection: testCollection(),
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
        "Cannot create entity: scope property 'tenantId' must be 'acme', got 'not-acme'"
      );
    });

    it('should prevent updating scope properties', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });
      const scopedRepo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      const entity = createTestEntity({ name: 'Test User', tenantId: 'acme' });
      const id = await repo.create(entity);

      // this should work (no scope property)
      await scopedRepo.update(id, { set: { name: 'Updated Name' } });

      // this should fail at runtime (scope property in set)
      await expect(
        scopedRepo.update(id, { set: { tenantId: 'not-acme' } } as any)
      ).rejects.toThrow('Cannot update readonly properties: tenantId');

      // this should fail at runtime (scope property in set even if it matches scope)
      await expect(
        scopedRepo.update(id, { set: { tenantId: 'acme' } } as any)
      ).rejects.toThrow('Cannot update readonly properties: tenantId');

      // this should fail at runtime (scope property in unset)
      await expect(
        scopedRepo.update(id, { unset: ['tenantId'] } as any)
      ).rejects.toThrow('Cannot unset readonly properties: tenantId');
    });

    it('should allow reading scope properties', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const scopedRepo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme' },
      });

      await repo.createMany([
        createTestEntity({ name: 'Active User 1', tenantId: 'acme' }),
        createTestEntity({ name: 'Active User 2', tenantId: 'acme' }),
        createTestEntity({ name: 'Inactive User', tenantId: 'not-acme' }),
      ]);

      // should be able to query by scope properties (event though it's pointless)
      const activeUsers = await scopedRepo.find({ tenantId: 'acme' });
      expect(activeUsers).toHaveLength(2);

      // never returns entities out of scope (even if filter says so)
      expect(await scopedRepo.find({ tenantId: 'not-acme' })).toHaveLength(0);

      // should be able to project scope properties
      const projectedUsers = await scopedRepo.find(
        {},
        { tenantId: true, name: true }
      );
      expect(projectedUsers).toHaveLength(2);
      projectedUsers.forEach((user) => {
        expect(user).toHaveProperty('tenantId');
        expect(user).toHaveProperty('name');
        expect(user).not.toHaveProperty('email');
      });
    });

    it('supports multi-property scope', async () => {
      const repo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
      });

      const scopedRepo = createSmartFirestoreRepo({
        collection: testCollection(),
        firestore: firestore.firestore,
        scope: { tenantId: 'acme', age: 30 },
      });

      const [, id2, id3] = await repo.createMany([
        // in scope
        createTestEntity({ name: 'Match 1', tenantId: 'acme', age: 30 }),
        // out of scope: wrong age
        createTestEntity({ name: 'Wrong age', tenantId: 'acme', age: 31 }),
        // out of scope: wrong tenant
        createTestEntity({
          name: 'Wrong tenant',
          tenantId: 'not-acme',
          age: 30,
        }),
        // in scope
        createTestEntity({ name: 'Match 2', tenantId: 'acme', age: 30 }),
      ]);

      // entities not matching full scope should not be accessible
      expect(await scopedRepo.getById(id2)).toBeNull();
      expect(await scopedRepo.getById(id3)).toBeNull();

      // only entities matching all scope properties are visible
      const results = await scopedRepo.find({});
      expect(results).toHaveLength(2);
      results.forEach((user) => {
        expect(user.tenantId).toBe('acme');
        expect(user.isActive).toBe(true);
        expect(user.age).toBe(30);
      });

      const count = await scopedRepo.count({});
      expect(count).toBe(2);
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
      const allFromEmptyScope = await emptyScopedRepo.find({});
      expect(allFromEmptyScope.map((u) => u.name).sort()).toEqual([
        'U1',
        'U2',
        'U3',
      ]);
      expect(await emptyScopedRepo.count({})).toBe(3);

      // access by id should work for any entity
      expect(await emptyScopedRepo.getById(id2)).not.toBeNull();

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
          COLLECTION_NAME
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
      const found = await repo.find({ entityId: id });
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
        repo.update(id, { set: { id: 'hacked' } } as any)
      ).rejects.toThrow('Cannot update readonly properties');
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
    id: uuidv4(),
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
