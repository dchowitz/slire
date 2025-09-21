import { omit, range, sortBy } from 'lodash-es';
import { Collection } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  combineSpecs,
  createSmartMongoRepo,
  SmartRepo,
  Specification,
  CreateManyPartialFailure,
} from '../lib/smart-repo';
import { mongo, setupMongo, teardownMongo } from './mongo-fixture';

describe('createSmartMongoRepo', function () {
  jest.setTimeout(60 * 1000);
  const COLLECTION_NAME = 'generic_repo_test';

  beforeAll(async () => {
    await setupMongo();
  });

  function testCollection(): Collection<TestEntity> {
    const db = mongo.client.db();
    return db.collection<TestEntity>(COLLECTION_NAME);
  }

  function rawTestCollection(): Collection<any> {
    const db = mongo.client.db();
    return db.collection(COLLECTION_NAME);
  }

  beforeEach(async () => {
    await testCollection().deleteMany({});
  });

  afterAll(async () => {
    await testCollection().drop();
    await teardownMongo();
  });

  describe('create', () => {
    it('should create a new entity and return its id', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity1 = createTestEntity({ name: 'Entity 1' });
      const entity2 = createTestEntity({ name: 'Entity 2' });

      const id1Result = await repo.create(entity1);
      const id2Result = await repo.create(entity2);

      expect(id1Result).not.toEqual(id2Result);
    });

    it('should handle entities with optional fields', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // Entity with undefined at root level and nested levels
      const entity = createTestEntity({
        name: 'Deep Test',
        metadata: {
          tags: ['test'],
          notes: undefined, // Should be filtered out
          nested: {
            field1: 'value1',
            field2: undefined, // Should be filtered out
            field3: null, // Should be preserved as null
          },
        } as any, // Cast to allow nested property for testing
        // Root level undefined field
        email: undefined as any,
      });

      const createdId = await repo.create(entity);

      // Check what actually got stored in MongoDB
      const rawDoc = await rawTestCollection().findOne({ _id: createdId });

      // Verify undefined fields are absent (not null)
      expect(rawDoc).not.toHaveProperty('email');
      expect(rawDoc?.metadata).not.toHaveProperty('notes');
      expect(rawDoc?.metadata?.nested).not.toHaveProperty('field2');

      // Verify null fields are preserved as null
      expect(rawDoc?.metadata?.nested?.field3).toBe(null);

      // Verify defined fields are present
      expect(rawDoc?.name).toBe('Deep Test');
      expect(rawDoc?.metadata?.tags).toEqual(['test']);
      expect(rawDoc?.metadata?.nested?.field1).toBe('value1');
    });

    it('should strip system-managed fields from input entities during create', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: {
          softDelete: true,
          traceTimestamps: true,
          version: true,
        },
      });

      // Create entity with system fields that should be stripped
      const entityWithSystemFields = {
        ...createTestEntity({ name: 'System Field Test' }),
        _deleted: true, // Should be stripped
        _version: 999, // Should be stripped
        _createdAt: new Date('2020-01-01'), // Should be stripped
        _updatedAt: new Date('2021-01-01'), // Should be stripped
        _deletedAt: new Date('2022-01-01'), // Should be stripped
      } as any;

      const createdId = await repo.create(entityWithSystemFields);

      // Check what actually got stored - system fields should be managed automatically
      const rawDoc = await rawTestCollection().findOne({ _id: createdId });

      // Verify malicious system fields were stripped and proper values set
      expect(rawDoc?._deleted).toBeUndefined(); // Should not exist (not soft-deleted)
      expect(rawDoc?._version).toBe(1); // Should be 1, not 999
      expect(rawDoc?._createdAt).toBeInstanceOf(Date); // Should be current time, not 2020
      expect(rawDoc?._updatedAt).toBeInstanceOf(Date); // Should be current time, not 2021
      expect(rawDoc?._deletedAt).toBeUndefined(); // Should not exist

      // Verify the actual data was preserved
      expect(rawDoc?.name).toBe('System Field Test');

      // Verify timestamps are recent (within last 5 seconds)
      const now = new Date();
      const fiveSecondsAgo = new Date(now.getTime() - 5000);
      expect(rawDoc?._createdAt.getTime()).toBeGreaterThan(
        fiveSecondsAgo.getTime()
      );
      expect(rawDoc?._updatedAt.getTime()).toBeGreaterThan(
        fiveSecondsAgo.getTime()
      );
    });

    it('should strip system-managed fields with custom timestamp keys during create', async () => {
      // Define extended entity type with custom timestamp and version fields
      type ExtendedTestEntity = TestEntity & {
        createdAt?: Date;
        updatedAt?: Date;
        deletedAt?: Date;
        version?: number;
      };

      function testCollectionWithExtended(): Collection<ExtendedTestEntity> {
        const db = mongo.client.db();
        return db.collection<ExtendedTestEntity>(COLLECTION_NAME);
      }

      const repo = createSmartMongoRepo({
        collection: testCollectionWithExtended(),
        mongoClient: mongo.client,
        options: {
          softDelete: true,
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
            deletedAt: 'deletedAt',
          },
          version: true,
        },
      });

      // Create entity with custom system fields that should be stripped
      const entityWithSystemFields: ExtendedTestEntity = {
        ...createTestEntity({ name: 'Custom System Field Test' }),
        _deleted: true, // Should be stripped
        _version: 999, // Should be stripped (default version field)
        createdAt: new Date('2020-01-01'), // Should be stripped (custom created field)
        updatedAt: new Date('2021-01-01'), // Should be stripped (custom updated field)
        deletedAt: new Date('2022-01-01'), // Should be stripped (custom deleted field)
      } as any;

      const createdId = await repo.create(entityWithSystemFields);

      // Check what actually got stored
      const rawDoc = await rawTestCollection().findOne({ _id: createdId });

      // Verify system fields were stripped and proper values set
      expect(rawDoc?._deleted).toBeUndefined(); // Should not exist
      expect(rawDoc?._version).toBe(1); // Should be 1, not 999
      expect(rawDoc?.createdAt).toBeInstanceOf(Date); // Should be current time
      expect(rawDoc?.updatedAt).toBeInstanceOf(Date); // Should be current time
      expect(rawDoc?.deletedAt).toBeUndefined(); // Should not exist

      // Verify timestamps are recent (within last 5 seconds)
      const now = new Date();
      const fiveSecondsAgo = new Date(now.getTime() - 5000);
      expect(rawDoc?.createdAt.getTime()).toBeGreaterThan(
        fiveSecondsAgo.getTime()
      );
      expect(rawDoc?.updatedAt.getTime()).toBeGreaterThan(
        fiveSecondsAgo.getTime()
      );

      // Verify the actual data was preserved
      expect(rawDoc?.name).toBe('Custom System Field Test');
    });
  });

  describe('createMany', () => {
    it('should create multiple entities and return their ids', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = [
        createTestEntity({ name: 'Alice', email: 'alice@example.com' }),
        createTestEntity({ name: 'Bob', email: 'bob@example.com' }),
        createTestEntity({ name: 'Charlie', email: 'charlie@example.com' }),
      ];

      const createdIds = await repo.createMany(entities);

      expect(Array.isArray(createdIds)).toBe(true);
      expect(createdIds).toHaveLength(3);
      createdIds.forEach((id) => {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      });

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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const createdIds = await repo.createMany([]);

      expect(Array.isArray(createdIds)).toBe(true);
      expect(createdIds).toHaveLength(0);
    });

    it('should handle entities with optional fields', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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

    it('should handle large batches with chunking', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = range(0, 1500).map((i) =>
        createTestEntity({
          name: `User ${i}`,
          email: `user${i}@example.com`,
          age: 20 + i,
        })
      );

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

    it('should throw CreateManyPartialFailure with inserted/failed ids on duplicate ids within a single batch', async () => {
      // generate identical ids to force only the first upsert to insert, others match and do not upsert
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
          expect(e.insertedIds).toHaveLength(1);
          expect(e.failedIds).toHaveLength(2);
          // DB should contain exactly the inserted documents
          const count = await rawTestCollection().countDocuments({});
          expect(count).toBe(1);
          const aDoc = await rawTestCollection().findOne({ name: 'A' });
          expect(aDoc).toBeTruthy();
        } else {
          throw e;
        }
      }
    });

    it('should report prior-batch inserts and mark subsequent ids as failed when a later batch fails', async () => {
      // create 1005 entities to span two batches (1000 + 5)
      // generate unique ids for the first 1000, then duplicate the same id for the last 5
      let counter = 0;
      const generateId = () => {
        counter += 1;
        return counter <= 1000 ? `ID-${counter}` : 'DUP-LAST-BATCH';
      };

      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { generateId },
      });

      const entities = range(0, 1005).map((i) =>
        createTestEntity({ name: `U${i}`, email: `u${i}@e.com` })
      );

      try {
        await repo.createMany(entities);
        fail('should have thrown');
      } catch (e: any) {
        if (e instanceof CreateManyPartialFailure) {
          // first 1000 + first of second batch were inserted
          expect(e.insertedIds).toHaveLength(1001);
          // remaining 4 in second batch failed
          expect(e.failedIds).toHaveLength(4);
          const count = await rawTestCollection().countDocuments({});
          expect(count).toBe(1001);
        } else {
          throw e;
        }
      }
    });
  });

  describe('getById', () => {
    it('should return the entity when it exists', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const retrieved = await repo.getById('non-existent-id');
      expect(retrieved).toBeNull();
    });

    it('should support projections', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({ name: 'Projection Test' });

      const createdId = await repo.create(entity);

      // test projection with specific fields
      const retrieved = await repo.getById(createdId, {
        name: true,
        email: true,
      });

      expect(retrieved).toEqual({
        name: 'Projection Test',
        email: 'test@example.com',
      });
    });
  });

  describe('getByIds', () => {
    it('should return entities that exist and ids that do not exist', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = range(0, 5).map((i) =>
        createTestEntity({ name: `Entity ${i}` })
      );
      const createdIds: string[] = [];

      for (const entity of entities) {
        const createdId = await repo.create(entity);
        createdIds.push(createdId);
      }

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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const [found, notFound] = await repo.getByIds(['id1', 'id2', 'id3']);

      expect([found, notFound]).toEqual([[], ['id1', 'id2', 'id3']]);
    });

    it('should support projections', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = range(0, 3).map((i) =>
        createTestEntity({ name: `Entity ${i}` })
      );
      const createdIds = await Promise.all(entities.map(repo.create));

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
  });

  describe('update', () => {
    it('should update an existing entity', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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

      const repo = createSmartMongoRepo({
        collection:
          testCollection() as unknown as Collection<EntityWithUndefinedField>,
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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

      // Check what actually got stored in MongoDB
      const rawDoc = await rawTestCollection().findOne({ _id: createdId });

      // Verify undefined fields in nested objects are absent (not null)
      // Note: age remains from original entity since undefined was filtered from set operation
      expect(rawDoc?.age).toBe(30); // Original value remains
      expect(rawDoc?.metadata).not.toHaveProperty('notes');
      expect(rawDoc?.metadata?.nested).not.toHaveProperty('field2');
      expect(rawDoc?.metadata?.nested?.deep).not.toHaveProperty(
        'level3undefined'
      );

      // Verify null fields are preserved as null
      expect(rawDoc?.metadata?.nested?.field3).toBe(null);

      // Verify defined fields are present and updated
      expect(rawDoc?.name).toBe('Updated Name');
      expect(rawDoc?.metadata?.tags).toEqual(['updated']);
      expect(rawDoc?.metadata?.nested?.field1).toBe('updated-value1');
      expect(rawDoc?.metadata?.nested?.deep?.level3).toBe('updated');
    });

    it('should update existing entity in scoped collection', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection:
          testCollection() as unknown as Collection<EntityWithManagedFields>,
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: rawTestCollection() as Collection<EntityWithManagedFields>,
        mongoClient: mongo.client,
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
  });

  describe('updateMany', () => {
    it('should update multiple entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = range(0, 5).map((i) =>
        createTestEntity({ name: `Entity ${i}` })
      );
      const createdIds = await Promise.all(entities.map(repo.create));

      await repo.updateMany(createdIds, { set: { isActive: false, age: 25 } });

      for (const id of createdIds) {
        const updated = await repo.getById(id);
        expect(updated).toMatchObject({
          isActive: false,
          age: 25,
        });
      }
    });

    it('should handle large batches with chunking', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = range(0, 150).map((i) =>
        createTestEntity({ name: `Entity ${i}` })
      );

      const createdIds = await repo.createMany(entities);
      expect(createdIds).toHaveLength(150);

      await repo.updateMany(createdIds, { set: { isActive: false } });

      const [updated, notFound] = await repo.getByIds(createdIds);

      expect([
        updated.filter((u) => !u.isActive).length,
        notFound.length,
      ]).toEqual([150, 0]);
    });

    it('should handle mixed existing and non-existing ids', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      const createdId = await repo.create(entity);

      const ids = [createdId, 'non-existent-1', 'non-existent-2'];

      // this should not throw an error
      await repo.updateMany(ids, { set: { isActive: false } });

      // verify the existing entity was updated
      const updated = await repo.getById(createdId);
      expect(updated?.isActive).toBe(false);
    });
  });

  describe('upsert', () => {
    it('should create a new entity when it does not exist', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({
        id: 'test-upsert-id',
        name: 'Upsert Test',
      });

      await repo.upsert(entity);

      const retrieved = await repo.getById('test-upsert-id');
      expect(retrieved).toEqual(entity);
    });

    it('should replace an existing entity when it exists', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const originalEntity = createTestEntity({ name: 'Original', age: 25 });
      const createdId = await repo.create(originalEntity);

      // upsert with completely different data
      const upsertEntity = createTestEntity({
        id: createdId,
        name: 'Replaced',
        age: 50,
        email: 'replaced@example.com',
        metadata: { tags: ['replaced'], notes: 'Completely replaced' },
      });

      await repo.upsert(upsertEntity);

      const retrieved = await repo.getById(createdId);
      expect(retrieved).toEqual(upsertEntity);
    });

    it('should handle entities with optional fields', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({
        id: 'optional-fields-test',
        name: 'Optional Fields',
        metadata: undefined,
      });

      await repo.upsert(entity);

      const retrieved = await repo.getById('optional-fields-test');
      expect(retrieved).toEqual({
        id: 'optional-fields-test',
        tenantId: 'org123',
        name: 'Optional Fields',
        email: 'test@example.com',
        age: 30,
        isActive: true,
      });
    });

    it('should recursively filter undefined properties in upsert (not store as null)', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // Entity with undefined at root level and nested levels
      const entity = createTestEntity({
        id: 'deep-upsert-test',
        name: 'Deep Upsert Test',
        age: undefined as any, // Should be filtered out at root
        metadata: {
          tags: ['upsert-test'],
          notes: undefined, // Should be filtered out
          nested: {
            field1: 'upsert-value1',
            field2: undefined, // Should be filtered out
            field3: null, // Should be preserved as null
            deep: {
              level3: 'value',
              level3undefined: undefined, // Should be filtered out
            },
          },
        } as any, // Cast to allow nested property for testing
      });

      await repo.upsert(entity);

      // Check what actually got stored in MongoDB
      const rawDoc = await rawTestCollection().findOne({
        _id: 'deep-upsert-test',
      });

      // Verify undefined fields are absent (not null)
      expect(rawDoc).not.toHaveProperty('age');
      expect(rawDoc?.metadata).not.toHaveProperty('notes');
      expect(rawDoc?.metadata?.nested).not.toHaveProperty('field2');
      expect(rawDoc?.metadata?.nested?.deep).not.toHaveProperty(
        'level3undefined'
      );

      // Verify null fields are preserved as null
      expect(rawDoc?.metadata?.nested?.field3).toBe(null);

      // Verify defined fields are present
      expect(rawDoc?.name).toBe('Deep Upsert Test');
      expect(rawDoc?.metadata?.tags).toEqual(['upsert-test']);
      expect(rawDoc?.metadata?.nested?.field1).toBe('upsert-value1');
      expect(rawDoc?.metadata?.nested?.deep?.level3).toBe('value');
    });

    it('should work with scoped repositories', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
      });

      const entity = omit(
        createTestEntity({ id: 'scoped-upsert', name: 'Scoped Upsert' }),
        'tenantId'
      );

      await scopedRepo.upsert(entity);

      const retrieved = await scopedRepo.getById('scoped-upsert');
      expect(retrieved).toMatchObject({
        id: 'scoped-upsert',
        name: 'Scoped Upsert',
        tenantId: 'acme',
      });
    });

    it('should validate scope property values during upsert', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
      });

      // Valid scope value should work
      const validEntity = createTestEntity({
        id: 'valid-scope',
        name: 'Valid',
        tenantId: 'acme',
      });
      await scopedRepo.upsert(validEntity);

      // Invalid scope value should fail
      const entityWithWrongScope = createTestEntity({
        id: 'invalid-scope',
        name: 'Invalid',
        tenantId: 'not-acme',
      });

      await expect(scopedRepo.upsert(entityWithWrongScope)).rejects.toThrow(
        "Cannot upsert entity: scope property 'tenantId' must be 'acme', got 'not-acme'"
      );
    });

    it('should set timestamps (app time)', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { traceTimestamps: true },
      });

      const entity = createTestEntity({
        id: 'timestamp-create',
        name: 'Timestamp Create',
      });

      // create
      await repo.upsert(entity);

      const raw = await rawTestCollection().findOne({
        _id: 'timestamp-create',
      });
      expect(raw?._createdAt).toBeInstanceOf(Date);
      expect(raw?._updatedAt).toBeInstanceOf(Date);
      expect(raw!._createdAt.getTime()).toEqual(raw!._updatedAt.getTime());

      await new Promise((r) => setTimeout(r, 2));

      // update
      await repo.upsert({ ...entity, name: 'Timestamp Update' });

      const raw2 = await rawTestCollection().findOne({
        _id: 'timestamp-create',
      });
      expect(raw2?._updatedAt).toBeInstanceOf(Date);
      expect(raw2!._updatedAt.getTime()).toBeGreaterThan(
        raw!._updatedAt.getTime()
      );
      expect(raw2!._createdAt.getTime()).toEqual(raw!._createdAt.getTime());
    });

    it('should set timestamps (mongo server time)', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { traceTimestamps: 'mongo' },
      });

      const entity = createTestEntity({
        id: 'mongo-timestamp',
        name: 'Mongo Timestamp',
      });

      await repo.upsert(entity);

      const raw = await rawTestCollection().findOne({ _id: 'mongo-timestamp' });
      expect(raw?._createdAt).toBeInstanceOf(Date);
      expect(raw?._updatedAt).toBeInstanceOf(Date);
      // _createdAt is app time and should be slightly before _updatedAt (server time)
      // diff should be minimal, but depends on testing env
      expect(
        raw!._updatedAt.getTime() - raw!._createdAt.getTime()
      ).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 2));

      // update
      await repo.upsert({ ...entity, name: 'Timestamp Update' });

      const raw2 = await rawTestCollection().findOne({
        _id: 'mongo-timestamp',
      });
      expect(raw2?._updatedAt).toBeInstanceOf(Date);
      expect(raw2!._updatedAt.getTime()).toBeGreaterThan(
        raw!._updatedAt.getTime()
      );
      expect(raw2!._createdAt.getTime()).toEqual(raw!._createdAt.getTime());
    });

    it('should strip system-managed fields from input entities during upsert', async () => {
      let time = new Date('2025-01-01T00:00:00Z');
      const clock = () => time;

      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: {
          softDelete: true,
          traceTimestamps: clock,
          version: true,
        },
      });

      // Upsert entity with system fields that should be stripped
      const entityWithSystemFields = {
        ...createTestEntity({
          id: 'system-field-upsert-test',
          name: 'System Field Upsert Test',
        }),
        _deleted: true, // Should be stripped
        _version: 999, // Should be stripped
        _createdAt: new Date('2020-01-01'), // Should be stripped
        _updatedAt: new Date('2021-01-01'), // Should be stripped
        _deletedAt: new Date('2022-01-01'), // Should be stripped
      } as any;

      await repo.upsert(entityWithSystemFields);

      // Check what actually got stored - system fields should be managed automatically
      const rawDoc = await rawTestCollection().findOne({
        _id: 'system-field-upsert-test',
      });

      // Verify malicious system fields were stripped and proper values set
      expect(rawDoc?._deleted).toBeUndefined(); // Should not exist (not soft-deleted)
      expect(rawDoc?._version).toBe(1); // Should be 1, not 999 (initial version for new doc)
      expect(rawDoc?._createdAt).toEqual(time); // Should be current time, not 2020
      expect(rawDoc?._updatedAt).toEqual(time); // Should be current time, not 2021
      expect(rawDoc?._deletedAt).toBeUndefined(); // Should not exist

      // Verify the actual data was preserved
      expect(rawDoc?.name).toBe('System Field Upsert Test');

      // Now update the same entity with malicious system fields again
      const updateWithSystemFields = {
        ...createTestEntity({
          id: 'system-field-upsert-test',
          name: 'Updated System Field Test',
        }),
        _deleted: true, // Should be stripped
        _version: 555, // Should be stripped
        _createdAt: new Date('2019-01-01'), // Should be stripped
        _updatedAt: new Date('2020-01-01'), // Should be stripped
        _deletedAt: new Date('2021-01-01'), // Should be stripped
      } as any;

      time = new Date('2021-01-01T00:00:01Z');
      await repo.upsert(updateWithSystemFields);

      // Check the updated document
      const updatedRawDoc = await rawTestCollection().findOne({
        _id: 'system-field-upsert-test',
      });

      // Verify system fields were stripped and proper values maintained/updated
      expect(updatedRawDoc?._deleted).toBeUndefined(); // Should still not exist
      expect(updatedRawDoc?._version).toBe(2); // Should be 2 (incremented), not 555
      expect(updatedRawDoc?._createdAt).toEqual(rawDoc?._createdAt); // Should be unchanged
      expect(updatedRawDoc?._updatedAt).toEqual(time); // Should be updated time
      expect(updatedRawDoc?._deletedAt).toBeUndefined(); // Should still not exist

      // Verify the actual data was updated
      expect(updatedRawDoc?.name).toBe('Updated System Field Test');
    });

    it('should work with soft delete enabled', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      const entity = createTestEntity({
        id: 'soft-delete-upsert',
        name: 'Soft Delete Test',
      });

      await repo.upsert(entity);

      const retrieved = await repo.getById('soft-delete-upsert');
      expect(retrieved).toEqual(entity);

      // verify it's not marked as deleted
      const raw = await rawTestCollection().findOne({
        _id: 'soft-delete-upsert',
      });
      expect(raw).not.toHaveProperty('_deleted');
    });

    it('should not overwrite soft-deleted entities by default, but can with includeSoftDeleted option', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      // create and then soft-delete an entity
      const entity = createTestEntity({ name: 'To Delete' });
      const createdId = await repo.create(entity);
      await repo.delete(createdId);

      // verify it's soft deleted
      expect(await repo.getById(createdId)).toBeNull();

      // normal upsert should not target soft-deleted entity, will try to create new which fails on unique constraint
      const upsertEntity = createTestEntity({
        id: createdId,
        name: 'Should Not Work',
      });

      // This should fail because it tries to create a new entity with existing ID
      await expect(repo.upsert(upsertEntity)).rejects.toThrow(
        'duplicate key error'
      );

      // upsert with includeSoftDeleted: true should work and update the soft-deleted entity
      const restoringUpsertEntity = createTestEntity({
        id: createdId,
        name: 'Upserted After Delete',
      });
      await repo.upsert(restoringUpsertEntity, { includeSoftDeleted: true });

      // verify the entity data was updated but is still soft-deleted in DB (no automatic undelete)
      const raw = await rawTestCollection().findOne({ _id: createdId });
      expect(raw).toHaveProperty('_deleted', true);
      expect(raw).toMatchObject({ name: 'Upserted After Delete' });

      // the entity should still not appear in normal queries because _deleted is still true
      const afterUpsert = await repo.getById(createdId);
      expect(afterUpsert).toBeNull(); // Should still be null because _deleted is still true
    });
  });

  describe('upsertMany', () => {
    it('should create multiple new entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = [
        createTestEntity({ id: 'upsert-1', name: 'Entity 1', age: 25 }),
        createTestEntity({ id: 'upsert-2', name: 'Entity 2', age: 30 }),
        createTestEntity({ id: 'upsert-3', name: 'Entity 3', age: 35 }),
      ];

      await repo.upsertMany(entities);

      const [found, notFound] = await repo.getByIds([
        'upsert-1',
        'upsert-2',
        'upsert-3',
      ]);
      expect(found).toHaveLength(3);
      expect(notFound).toHaveLength(0);

      const expectedNames = ['Entity 1', 'Entity 2', 'Entity 3'];
      const expectedAges = [25, 30, 35];
      const foundNames = found.map((e) => e.name);
      const foundAges = found.map((e) => e.age);

      expect(foundNames).toEqual(expect.arrayContaining(expectedNames));
      expect(foundAges).toEqual(expect.arrayContaining(expectedAges));
    });

    it('should replace existing entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // create some initial entities
      const initialEntities = [
        createTestEntity({ name: 'Original 1', age: 20 }),
        createTestEntity({ name: 'Original 2', age: 25 }),
      ];
      const [id1, id2] = await repo.createMany(initialEntities);

      // upsert with replacements
      const upsertEntities = [
        createTestEntity({
          id: id1,
          name: 'Replaced 1',
          age: 99,
          email: 'replaced1@example.com',
        }),
        createTestEntity({
          id: id2,
          name: 'Replaced 2',
          age: 88,
          email: 'replaced2@example.com',
        }),
      ];

      await repo.upsertMany(upsertEntities);

      const [found] = await repo.getByIds([id1, id2]);
      expect(found).toHaveLength(2);

      const entity1 = found.find((e) => e.id === id1);
      const entity2 = found.find((e) => e.id === id2);

      expect(entity1).toMatchObject({
        name: 'Replaced 1',
        age: 99,
        email: 'replaced1@example.com',
      });
      expect(entity2).toMatchObject({
        name: 'Replaced 2',
        age: 88,
        email: 'replaced2@example.com',
      });
    });

    it('should handle mixed create and replace operations', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // create one initial entity
      const existingEntity = createTestEntity({ name: 'Existing', age: 40 });
      const existingId = await repo.create(existingEntity);

      // upsert mix of existing and new
      const upsertEntities = [
        createTestEntity({
          id: existingId,
          name: 'Updated Existing',
          age: 45,
        }),
        createTestEntity({
          id: 'new-entity-1',
          name: 'New Entity 1',
          age: 50,
        }),
        createTestEntity({
          id: 'new-entity-2',
          name: 'New Entity 2',
          age: 55,
        }),
      ];

      await repo.upsertMany(upsertEntities);

      const [found, notFound] = await repo.getByIds([
        existingId,
        'new-entity-1',
        'new-entity-2',
      ]);
      expect(found).toHaveLength(3);
      expect(notFound).toHaveLength(0);

      const expectedNames = [
        'Updated Existing',
        'New Entity 1',
        'New Entity 2',
      ];
      const expectedAges = [45, 50, 55];
      const foundNames = found.map((e) => e.name);
      const foundAges = found.map((e) => e.age);

      expect(foundNames).toEqual(expect.arrayContaining(expectedNames));
      expect(foundAges).toEqual(expect.arrayContaining(expectedAges));
    });

    it('should handle empty array', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // should not throw an error
      await repo.upsertMany([]);

      const count = await repo.count({});
      expect(count).toEqual(0);
    });

    it('should handle large batches with chunking', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = range(0, 1500).map((i) =>
        createTestEntity({
          id: `batch-upsert-${i}`,
          name: `Batch Entity ${i}`,
          email: `batch${i}@example.com`,
          age: 20 + i,
        })
      );

      await repo.upsertMany(entities);

      const count = await repo.count({});
      expect(count).toEqual(1500);

      // verify a sample of entities
      const sampleIds = [
        'batch-upsert-0',
        'batch-upsert-500',
        'batch-upsert-1000',
        'batch-upsert-1499',
      ];
      const [found] = await repo.getByIds(sampleIds);
      expect(found).toHaveLength(4);

      for (const entity of found) {
        const expectedIndex = parseInt(entity.id.split('-')[2]);
        expect(entity.name).toBe(`Batch Entity ${expectedIndex}`);
        expect(entity.email).toBe(`batch${expectedIndex}@example.com`);
        expect(entity.age).toBe(20 + expectedIndex);
      }
    });

    it('should work with scoped repositories', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
      });

      await scopedRepo.upsertMany([
        omit(
          createTestEntity({ id: 'scoped-many-1', name: 'Scoped 1' }),
          'tenantId'
        ),
        omit(
          createTestEntity({ id: 'scoped-many-2', name: 'Scoped 2' }),
          'tenantId'
        ),
      ]);

      const [found] = await scopedRepo.getByIds([
        'scoped-many-1',
        'scoped-many-2',
      ]);

      expect(found).toHaveLength(2);
      expect(found.every((e) => e.tenantId === 'acme')).toBe(true);
    });

    it('upsertMany should respect soft-delete behavior', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      // create and soft-delete some entities
      const [id1, id2] = await repo.createMany([
        createTestEntity({ name: 'Entity 1' }),
        createTestEntity({ name: 'Entity 2' }),
      ]);
      await repo.deleteMany([id1, id2]);

      // normal upsertMany should fail for soft-deleted entities (tries to create with existing ID)
      const normalUpserts = [
        createTestEntity({ id: id1, name: 'Should Fail 1' }),
        createTestEntity({ id: id2, name: 'Should Fail 2' }),
      ];
      await expect(repo.upsertMany(normalUpserts)).rejects.toThrow();

      // upsertMany with includeSoftDeleted should work
      const includedUpserts = [
        createTestEntity({ id: id1, name: 'Restored 1' }),
        createTestEntity({ id: id2, name: 'Restored 2' }),
      ];
      await repo.upsertMany(includedUpserts, { includeSoftDeleted: true });

      // verify data was updated but entities are still soft-deleted
      const raw1 = await rawTestCollection().findOne({ _id: id1 });
      const raw2 = await rawTestCollection().findOne({ _id: id2 });
      expect(raw1?.name).toBe('Restored 1');
      expect(raw2?.name).toBe('Restored 2');
      expect(raw1).toHaveProperty('_deleted', true);
      expect(raw2).toHaveProperty('_deleted', true);

      // entities should still not appear in normal queries
      expect(await repo.getById(id1)).toBeNull();
      expect(await repo.getById(id2)).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an existing entity', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({ name: 'To Delete' });

      const createdId = await repo.create(entity);

      await repo.delete(createdId);

      const deleted = await repo.getById(createdId);
      expect(deleted).toBeNull();
    });

    it('should not throw on non-existent entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      await repo.delete('non-existent-id');
    });
  });

  describe('deleteMany', () => {
    it('should delete multiple entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
  });

  describe('find', () => {
    it('should find entities matching the filter', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const results = await repo.find({ name: 'Non-existent' });
      expect(results).toHaveLength(0);
    });

    it('should support projections', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const results = await repo.find(
        { name: 'Non-existent' },
        { name: true, email: true }
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('count', () => {
    it('should count entities matching the filter', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const entity = createTestEntity({ name: 'Test Entity' });
      await repo.create(entity);

      const count = await repo.count({ name: 'Non-existent' });
      expect(count).toBe(0);
    });
  });

  describe('findBySpec, countBySpec', () => {
    it('should support findBySpec and countBySpec with basic specifications', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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

    it('should demonstrate approved specification pattern for security', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      await repo.createMany([
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
      ]);

      // Branded specification approach
      const APPROVED_SPEC = Symbol('approved-specification');

      type ApprovedSpecification<T> = Specification<T> & {
        readonly [APPROVED_SPEC]: true;
      };

      // Internal factory - would not be exported in real code
      function createApprovedSpec<T>(
        spec: Specification<T>
      ): ApprovedSpecification<T> {
        return { ...spec, [APPROVED_SPEC]: true as const };
      }

      // Controlled factory that business logic can access
      const approvedTestSpecs = {
        active: () =>
          createApprovedSpec<TestEntity>({
            toFilter: () => ({ isActive: true }),
            describe: 'active users',
          }),
        byAge: (age: number) =>
          createApprovedSpec<TestEntity>({
            toFilter: () => ({ age }),
            describe: `users aged ${age}`,
          }),
      } as const;

      // Function that only accepts approved specs
      async function findByApprovedSpec<T extends { id: string }>(
        repository: SmartRepo<T>,
        spec: ApprovedSpecification<T>
      ): Promise<T[]> {
        return repository.findBySpec(spec);
      }

      // Test approved specifications work
      const activeUsers = await findByApprovedSpec(
        repo,
        approvedTestSpecs.active()
      );
      expect(activeUsers).toHaveLength(2);

      const youngUsers = await findByApprovedSpec(
        repo,
        approvedTestSpecs.byAge(25)
      );
      expect(youngUsers).toHaveLength(1);
      expect(youngUsers[0].name).toBe('Alice');

      // Demonstrate that rogue specs cannot be created
      // This would fail at compile time:
      // const rogueSpec = { toFilter: () => ({}), describe: 'hack' };
      // const result = await findByApprovedSpec(repo, rogueSpec); // ❌ Type error!
    });
  });

  describe('scoping', () => {
    it('scoped repo only has access to entities matching the scope', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const emptyScopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
    it('detached: create stores separate internal key and business id', async () => {
      const repo = createSmartMongoRepo<TestEntity>({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { identity: 'detached' },
      });

      // client-supplied id is ignored on create
      const suppliedId = 'client-supplied-id';
      const createdId = await repo.create(
        createTestEntity({ name: 'Detached A', id: suppliedId } as any)
      );
      expect(createdId).not.toBe(suppliedId);

      const raw = await rawTestCollection().findOne({ id: createdId });
      expect(raw).toBeTruthy();
      expect(typeof raw!._id).toBe('string');
      expect(typeof raw!.id).toBe('string');
      expect(raw!._id).not.toBe(raw!.id);

      const roundTripped = await repo.getById(createdId);
      expect(roundTripped?.id).toBe(createdId);
      expect(roundTripped?.name).toBe('Detached A');
    });

    it('detached: CRUD by business id', async () => {
      const repo = createSmartMongoRepo<TestEntity>({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { identity: 'detached' },
      });

      const [aId, bId] = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
      ]);

      // update by business id
      await repo.update(aId, { set: { name: 'A-updated' } });
      const afterUpdate = await repo.getById(aId);
      expect(afterUpdate?.name).toBe('A-updated');

      // find/count by business id
      const found = await repo.find({ id: bId });
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe('B');
      expect(await repo.count({ id: bId })).toBe(1);

      // delete by business id
      await repo.delete(bId);
      expect(await repo.getById(bId)).toBeNull();
    });

    it('detached: upsert updates by business id and preserves internal key', async () => {
      const repo = createSmartMongoRepo<TestEntity>({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { identity: 'detached' },
      });

      const id = await repo.create(createTestEntity({ name: 'X' }));
      const before = await rawTestCollection().findOne({ id });
      const internalBefore = before!._id;

      await repo.upsert({ ...(createTestEntity({ name: 'X2' }) as any), id });

      const after = await rawTestCollection().findOne({ id });
      expect(after!.name).toBe('X2');
      // internal _id remains the same after upsert update
      expect(after!._id).toBe(internalBefore);

      // projection should include id when requested
      expect(await repo.getById(id, { id: true, name: true })).toEqual({
        id,
        name: 'X2',
      });
    });
  });

  describe('soft delete', () => {
    it('soft deleted entities stay in the database', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Test Entity' }));
      await repo.delete(id);

      const raw = await rawTestCollection().findOne({ _id: id });
      expect(raw).toMatchObject({ _deleted: true });
    });

    it('update should not touch soft-deleted entities by default', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Test Entity' }));
      await repo.delete(id);

      await repo.update(id, { set: { name: 'Should Not Update' } });
      const raw = await rawTestCollection().findOne({ _id: id });
      expect(raw?.name).not.toBe('Should Not Update');
      expect(raw?.name).toBe('Test Entity'); // original name
    });

    it('update can target soft-deleted entities with includeSoftDeleted option', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Entity 1' }));
      await repo.delete(id);

      await repo.update(
        id,
        { set: { name: 'Updated Soft Deleted' } },
        { includeSoftDeleted: true }
      );

      const raw1 = await rawTestCollection().findOne({ _id: id });
      expect(raw1?.name).toBe('Updated Soft Deleted');
      expect(raw1).toHaveProperty('_deleted', true); // still soft-deleted

      // entity should still not appear in normal queries
      expect(await repo.getById(id)).toBeNull();
    });

    it('should not return soft-deleted entities in reads', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      const ids = await repo.createMany([
        createTestEntity({ name: 'A' }),
        createTestEntity({ name: 'B' }),
        createTestEntity({ name: 'C' }),
      ]);

      await repo.deleteMany([ids[0], ids[2]]);

      const remaining = await repo.find({});
      expect(remaining.map((e) => e.name)).toEqual(['B']);
      const count = await repo.count({});
      expect(count).toBe(1);
    });
  });

  describe('trace timestamps', () => {
    it('should set timestamps when traceTimestamps enabled (app time)', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true, traceTimestamps: true },
      });

      const id = await repo.create(createTestEntity({ name: 'TS' }));

      const raw1 = await rawTestCollection().findOne({ _id: id });
      expect(raw1?._createdAt).toBeInstanceOf(Date);
      expect(raw1?._updatedAt).toBeInstanceOf(Date);
      expect(raw1?._deletedAt).toBeUndefined();
      // createdAt and updatedAt should be equal on create
      expect(raw1!._createdAt.getTime()).toBe(raw1!._updatedAt.getTime());

      // ensure the next update happens at a later timestamp
      await new Promise((r) => setTimeout(r, 2));
      await repo.update(id, { set: { name: 'TS2' } });
      const raw2 = await rawTestCollection().findOne({ _id: id });
      expect(raw2?._updatedAt).toBeInstanceOf(Date);
      // updatedAt should be newer than before
      expect(raw2!._updatedAt.getTime()).toBeGreaterThan(
        raw1!._updatedAt.getTime()
      );

      // ensure delete happens at a later timestamp
      await new Promise((r) => setTimeout(r, 2));
      await repo.delete(id);
      const raw3 = await rawTestCollection().findOne({ _id: id });
      expect(raw3?._deletedAt).toBeInstanceOf(Date);
      // on delete, updatedAt and deletedAt should be equal and newer than previous updatedAt
      expect(raw3!._updatedAt.getTime()).toBe(raw3!._deletedAt.getTime());
      expect(raw3!._updatedAt.getTime()).toBeGreaterThan(
        raw2!._updatedAt.getTime()
      );
    });

    it('should set timestamps using mongo server time', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true, traceTimestamps: 'mongo' },
      });

      const id = await repo.create(createTestEntity({ name: 'TS-M' }));
      const raw1 = await rawTestCollection().findOne({ _id: id });
      expect(raw1?._createdAt).toBeInstanceOf(Date);
      expect(raw1?._updatedAt).toBeInstanceOf(Date);
      expect(
        Math.abs(raw1!._createdAt.getTime() - raw1!._updatedAt.getTime())
      ).toBeLessThan(5); // sometimes differ

      await new Promise((r) => setTimeout(r, 2));
      await repo.update(id, { set: { name: 'TS2' } });
      const raw2 = await rawTestCollection().findOne({ _id: id });
      expect(raw2!._updatedAt.getTime()).toBeGreaterThan(
        raw1!._updatedAt.getTime()
      );

      await new Promise((r) => setTimeout(r, 2));
      await repo.delete(id);
      const raw3 = await rawTestCollection().findOne({ _id: id });
      expect(raw3!._updatedAt.getTime()).toBe(raw3!._deletedAt.getTime());
      expect(raw3!._updatedAt.getTime()).toBeGreaterThan(
        raw2!._updatedAt.getTime()
      );
    });

    it('should use custom clock function', async () => {
      let t = new Date('2020-01-01T00:00:00Z');
      const clock = () => new Date(t);
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true, traceTimestamps: clock },
      });

      const id = await repo.create(createTestEntity({ name: 'TS-C' }));
      const raw1 = await rawTestCollection().findOne({ _id: id });
      expect(raw1!._createdAt.getTime()).toBe(t.getTime());
      expect(raw1!._updatedAt.getTime()).toBe(t.getTime());

      t = new Date('2020-01-01T00:00:01Z');
      await repo.update(id, { set: { name: 'X' } });
      const raw2 = await rawTestCollection().findOne({ _id: id });
      expect(raw2!._updatedAt.getTime()).toBe(t.getTime());

      t = new Date('2020-01-01T00:00:02Z');
      await repo.delete(id);
      const raw3 = await rawTestCollection().findOne({ _id: id });
      expect(raw3!._deletedAt.getTime()).toBe(t.getTime());
      expect(raw3!._updatedAt.getTime()).toBe(t.getTime());
    });
  });

  describe('configurable timestamp keys', () => {
    type EntityWithTimestamps = TestEntity & {
      createdAt: Date;
      updatedAt: Date;
      deletedAt?: Date; // should be omitted when no soft-delete is configured
    };

    function testCollectionWithTimestamps(): Collection<EntityWithTimestamps> {
      const db = mongo.client.db();
      return db.collection<EntityWithTimestamps>(COLLECTION_NAME);
    }

    it('should expose timestamp fields in reads when configured as entity properties', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt' as const,
            updatedAt: 'updatedAt' as const,
            deletedAt: 'deletedAt' as const,
          },
        },
      });

      const entity = createTestEntity({ name: 'Timestamp Test' });
      const id = await repo.create(entity);

      const retrieved = await repo.getById(id);
      expect(retrieved).toHaveProperty('createdAt');
      expect(retrieved).toHaveProperty('updatedAt');
      expect(retrieved!.createdAt).toBeInstanceOf(Date);
      expect(retrieved!.updatedAt).toBeInstanceOf(Date);
      expect(retrieved!.createdAt.getTime()).toBe(
        retrieved!.updatedAt.getTime()
      );
    });

    it('should support projections including timestamp fields', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const entity = createTestEntity({ name: 'Projection Test' });
      const id = await repo.create(entity);

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

      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          traceTimestamps: clock,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const entity = createTestEntity({ name: 'Update Test' });
      const id = await repo.create(entity);

      const initial = await repo.getById(id);
      expect(initial!.createdAt.getTime()).toBe(testTime.getTime());
      expect(initial!.updatedAt.getTime()).toBe(testTime.getTime());

      // advance time and update
      testTime = new Date('2023-01-01T01:00:00Z');
      await repo.update(id, { set: { name: 'Updated Name' } });

      const updated = await repo.getById(id);
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.createdAt.getTime()).toBe(
        new Date('2023-01-01T00:00:00Z').getTime()
      );
      expect(updated!.updatedAt.getTime()).toBe(testTime.getTime());
    });

    it('should prevent writing to configured timestamp fields', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
          },
        },
      });

      const entity = createTestEntity({ name: 'Readonly Test' });
      const id = await repo.create(entity);

      await expect(
        repo.update(id, { set: { createdAt: new Date() } } as any)
      ).rejects.toThrow('Cannot update readonly properties: createdAt');

      await expect(
        repo.update(id, { set: { updatedAt: new Date() } } as any)
      ).rejects.toThrow('Cannot update readonly properties: updatedAt');
    });

    it('should support partial timestamp configuration', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          traceTimestamps: true,
          timestampKeys: {
            // only configure createdAt, others use defaults
            createdAt: 'createdAt',
          },
        },
      });

      const entity = {
        ...createTestEntity({ name: 'Partial Config Test' }),
        updatedAt: new Date('2023-01-01T00:00:00Z'),
      };
      const id = await repo.create(entity);

      const retrieved = await repo.getById(id);
      expect(retrieved).toHaveProperty('createdAt'); // configured entity timestamps are visible
      expect(retrieved?.updatedAt.getTime()).toBe(entity.updatedAt.getTime()); // updatedAt is here a regular prop
      expect(retrieved).not.toHaveProperty('_updatedAt'); // hidden timestamp key as no updateAt key is configured

      // but _updatedAt should exist in raw document
      const raw = await rawTestCollection().findOne({ _id: id });
      expect(raw).toHaveProperty('_updatedAt');
    });

    it('should automatically enable timestamps when timestampKeys are configured', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          timestampKeys: {
            createdAt: 'createdAt' as const,
            updatedAt: 'updatedAt' as const,
          },
        },
      });

      const entity = createTestEntity({ name: 'Auto Timestamps Test' });
      const id = await repo.create(entity);

      const retrieved = await repo.getById(id);
      // timestamps should be automatically set even though traceTimestamps wasn't explicitly enabled
      expect(retrieved).toHaveProperty('createdAt');
      expect(retrieved).toHaveProperty('updatedAt');
      expect(retrieved!.createdAt).toBeInstanceOf(Date);
      expect(retrieved!.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('id generation', () => {
    it('should use custom id generation', async () => {
      let counter = 0;
      const customGenerateId = () => `custom-${++counter}`;

      const customRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: {
          generateId: customGenerateId,
        },
      });

      const entity = createTestEntity({ name: 'Custom ID Test' });

      const createdId = await customRepo.create(entity);
      expect(createdId).toBe('custom-1');

      const secondId = await customRepo.create(entity);
      expect(secondId).toBe('custom-2');
    });
  });

  describe('version counter', () => {
    it('should increment version with hidden field when version: true', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { version: true },
      });

      const id = await repo.create(createTestEntity({ name: 'Version Test' }));

      // check initial version in raw document
      const raw1 = await rawTestCollection().findOne({ _id: id });
      expect(raw1).toHaveProperty('_version', 1);

      // update and check version increment
      await repo.update(id, { set: { name: 'Updated' } });
      const raw2 = await rawTestCollection().findOne({ _id: id });
      expect(raw2).toHaveProperty('_version', 2);

      // entity should not include hidden version field
      const retrieved = await repo.getById(id);
      expect(retrieved).not.toHaveProperty('_version');
    });

    it('should increment version with entity field when version key is configured', async () => {
      type VersionedEntity = TestEntity & {
        version: number;
      };

      function testCollectionVersioned(): Collection<VersionedEntity> {
        const db = mongo.client.db();
        return db.collection<VersionedEntity>(COLLECTION_NAME);
      }

      const repo = createSmartMongoRepo({
        collection: testCollectionVersioned(),
        mongoClient: mongo.client,
        options: { version: 'version' },
      });

      const entity = createTestEntity({ name: 'Entity Version Test' });
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
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { version: true, softDelete: true },
      });

      const id = await repo.create(
        createTestEntity({ name: 'Delete Version Test' })
      );

      // check initial version
      const raw1 = await rawTestCollection().findOne({ _id: id });
      expect(raw1).toHaveProperty('_version', 1);

      // soft delete and check version increment
      await repo.delete(id);
      const raw2 = await rawTestCollection().findOne({ _id: id });
      expect(raw2).toHaveProperty('_version', 2);
      expect(raw2).toHaveProperty('_deleted', true);
    });

    it('should handle version in upsert operations', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { version: true },
      });

      const entityWithId = createTestEntity({
        id: 'upsert-version-test',
        name: 'Upsert Version Test',
      });

      // first upsert (insert) - should set version to 1
      await repo.upsert(entityWithId);
      const raw1 = await rawTestCollection().findOne({
        _id: 'upsert-version-test',
      });
      expect(raw1).toHaveProperty('_version', 1);

      // second upsert (update) - should increment version to 2
      await repo.upsert({
        ...entityWithId,
        name: 'Updated Upsert',
        _version: 99,
      } as any); // _version passed here is ignored
      const raw2 = await rawTestCollection().findOne({
        _id: 'upsert-version-test',
      });
      expect(raw2).toHaveProperty('_version', 2);
    });

    it('should work with bulk operations', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { version: true },
      });

      const ids = await repo.createMany([
        createTestEntity({ name: 'Bulk 1' }),
        createTestEntity({ name: 'Bulk 2' }),
        createTestEntity({ name: 'Bulk 3' }),
      ]);

      for (const id of ids) {
        const raw = await rawTestCollection().findOne({ _id: id });
        expect(raw).toHaveProperty('_version', 1);
      }

      await repo.updateMany(ids, { set: { name: 'Updated Bulk' } });

      for (const id of ids) {
        const raw = await rawTestCollection().findOne({ _id: id });
        expect(raw).toHaveProperty('_version', 2);
      }
    });

    it('should not interfere when version is disabled', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const id = await repo.create(
        createTestEntity({ name: 'No Version Test' })
      );

      // should not have version field
      const raw = await rawTestCollection().findOne({ _id: id });
      expect(raw).not.toHaveProperty('_version');

      // update should still work without version
      await repo.update(id, { set: { name: 'Updated No Version' } });
      const raw2 = await rawTestCollection().findOne({ _id: id });
      expect(raw2).not.toHaveProperty('_version');
    });
  });

  describe('advanced operations', () => {
    it('buildUpdateOperation sets timestamps', async () => {
      let t = new Date('2020-01-01T00:00:00Z');
      const clock = () => t;
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { traceTimestamps: clock },
      });

      const [id1, id2, id3] = await repo.createMany(
        range(0, 3).map((_) => createTestEntity())
      );

      const updates = [
        { id: id1, set: { name: 'Updated1' } },
        { id: id2, set: { name: 'Updated2' } },
        { id: id3, set: { name: 'Updated3' } },
      ];

      t = new Date('2020-01-01T00:00:01Z');
      await repo.collection.bulkWrite(
        updates.map((update) => ({
          updateOne: {
            filter: { _id: update.id },
            update: repo.buildUpdateOperation(update),
          },
        }))
      );

      const updated1 = await repo.collection.findOne({ _id: id1 });
      const updated2 = await repo.collection.findOne({ _id: id2 });
      const updated3 = await repo.collection.findOne({ _id: id3 });

      expect(updated1).toMatchObject({ name: 'Updated1', _updatedAt: t });
      expect(updated2).toMatchObject({ name: 'Updated2', _updatedAt: t });
      expect(updated3).toMatchObject({ name: 'Updated3', _updatedAt: t });
    });

    it('buildUpdateOperation prevents writing read-only props (runtime)', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
        options: { softDelete: true, traceTimestamps: true },
      });

      expect(() =>
        repo.buildUpdateOperation({
          set: {
            name: 'Updated1',
            _id: 'foo',
            tenantId: 'bar',
            _createdAt: new Date(),
          },
        } as any)
      ).toThrow('Cannot update readonly properties: _id, _createdAt, tenantId');
    });

    it('applyConstraints with default behavior', async () => {
      const acmeRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
        options: { softDelete: true },
      });

      const fooRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'foo' },
        options: { softDelete: true },
      });

      const ids = await Promise.all([
        acmeRepo.create(
          createTestEntity({
            name: '0',
            isActive: true,
            tenantId: 'acme',
          })
        ),
        acmeRepo.create(
          createTestEntity({
            name: '1',
            isActive: true,
            tenantId: 'acme',
          })
        ),
        acmeRepo.create(
          createTestEntity({
            name: '2',
            isActive: false,
            tenantId: 'acme',
          })
        ),
        fooRepo.create(
          createTestEntity({ name: '3', isActive: true, tenantId: 'foo' })
        ),
        fooRepo.create(
          createTestEntity({ name: '4', isActive: true, tenantId: 'foo' })
        ),
        fooRepo.create(
          createTestEntity({
            name: '5',
            isActive: false,
            tenantId: 'foo',
          })
        ),
        fooRepo.create(
          createTestEntity({
            name: '6',
            isActive: false,
            tenantId: 'foo',
          })
        ),
      ]);

      await fooRepo.delete(ids[6]);

      const results = await testCollection()
        .aggregate([
          { $match: fooRepo.applyConstraints({}) },
          {
            $group: {
              _id: '$isActive',
              count: { $sum: 1 },
            },
          },
        ])
        .toArray();

      expect(sortBy(results, (i) => i.count)).toEqual([
        { _id: false, count: 1 },
        { _id: true, count: 2 },
      ]);
    });

    it('applyConstraints with includeSoftDeleted option', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
        options: { softDelete: true },
      });

      const id = await repo.create(createTestEntity({ tenantId: 'acme' }));

      // Soft delete the entity
      await repo.delete(id);

      // Default behavior - should not match soft-deleted entity
      await repo.collection.updateOne(repo.applyConstraints({ _id: id }), {
        $set: { _notInModel: 'default' },
      });

      let updated = await repo.collection.findOne({ _id: id });
      expect(updated).not.toHaveProperty('_notInModel');

      // With includeSoftDeleted: true - should match soft-deleted entity
      await repo.collection.updateOne(
        repo.applyConstraints({ _id: id }, { includeSoftDeleted: true }),
        { $set: { _notInModel: 'included' } }
      );

      updated = await repo.collection.findOne({ _id: id });
      expect(updated).toMatchObject({ _notInModel: 'included' });
    });
  });

  describe('transactions', () => {
    it('withSession should apply all operations within the same session', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      await mongo.client.withSession(async (session) => {
        await session.withTransaction(async () => {
          const txRepo = repo.withSession(session);

          const createdIds = await txRepo.createMany([
            createTestEntity({ name: 'TX Entity 1' }),
            createTestEntity({ name: 'TX Entity 2' }),
            createTestEntity({ name: 'TX Entity 3' }),
          ]);

          // update one of them
          await txRepo.update(createdIds[0], { set: { age: 99 } });

          // delete another
          await txRepo.delete(createdIds[2]);

          // verify changes are visible within transaction
          const remaining = await txRepo.find({});
          expect(remaining).toHaveLength(2);
          expect(remaining.find((e) => e.id === createdIds[0])?.age).toBe(99);
        });
      });

      // verify changes persisted after transaction
      const finalEntities = await repo.find({});
      expect(finalEntities).toHaveLength(2);
      expect(finalEntities.some((e) => e.name === 'TX Entity 1')).toBe(true);
      expect(finalEntities.some((e) => e.name === 'TX Entity 2')).toBe(true);
      expect(finalEntities.some((e) => e.name === 'TX Entity 3')).toBe(false);
      expect(finalEntities.find((e) => e.name === 'TX Entity 1')?.age).toBe(99);
    });

    it('runTransaction should execute all operations within a transaction', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const result = await repo.runTransaction(async (txRepo) => {
        const createdIds = await txRepo.createMany([
          createTestEntity({ name: 'Run TX 1', age: 25 }),
          createTestEntity({ name: 'Run TX 2', age: 30 }),
          createTestEntity({ name: 'Run TX 3', age: 35 }),
        ]);

        // update all ages
        await txRepo.updateMany(createdIds, { set: { age: 40 } });

        // find and verify within transaction
        const updated = await txRepo.find({ age: 40 });
        expect(updated).toHaveLength(3);

        return { processedCount: updated.length, ids: createdIds };
      });

      // verify transaction result
      expect(result.processedCount).toBe(3);

      // verify changes persisted
      const finalEntities = await repo.find({ age: 40 });
      expect(finalEntities).toHaveLength(3);
      expect(finalEntities.map((e) => e.name)).toEqual(
        expect.arrayContaining(['Run TX 1', 'Run TX 2', 'Run TX 3'])
      );
    });

    it('should rollback all changes when withSession transaction fails', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // create some initial data
      const initialEntity = createTestEntity({ name: 'Initial Entity' });
      const initialId = await repo.create(initialEntity);

      try {
        await mongo.client.withSession(async (session) => {
          await session.withTransaction(async () => {
            const txRepo = repo.withSession(session);

            await txRepo.createMany([
              createTestEntity({ name: 'Should Not Persist 1' }),
              createTestEntity({ name: 'Should Not Persist 2' }),
            ]);

            // update initial entity
            await txRepo.update(initialId, {
              set: { name: 'Should Not Be Updated' },
            });

            // verify changes are visible within transaction
            const entities = await txRepo.find({});
            expect(entities).toHaveLength(3);

            // throw error to trigger rollback
            throw new Error('Intentional transaction failure');
          });
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'Intentional transaction failure'
        );
      }

      // verify rollback - only initial entity should exist with original values
      const finalEntities = await repo.find({});
      expect(finalEntities).toHaveLength(1);
      expect(finalEntities[0].name).toBe('Initial Entity');
    });

    it('should rollback all changes when runTransaction fails', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const initialIds = await repo.createMany([
        createTestEntity({ name: 'Existing 1', age: 20 }),
        createTestEntity({ name: 'Existing 2', age: 25 }),
      ]);

      try {
        await repo.runTransaction(async (txRepo) => {
          await txRepo.createMany([
            createTestEntity({ name: 'Rollback Test 1' }),
            createTestEntity({ name: 'Rollback Test 2' }),
          ]);

          // update existing entities
          await txRepo.updateMany(initialIds, { set: { age: 99 } });

          // delete one existing entity
          await txRepo.delete(initialIds[0]);

          // verify changes within transaction
          const remaining = await txRepo.find({});
          expect(remaining).toHaveLength(3); // 1 existing + 2 new

          // throw error to trigger rollback
          throw new Error('Transaction rollback test');
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Transaction rollback test');
      }

      // verify rollback - original state should be restored
      const finalEntities = await repo.find({});
      expect(finalEntities).toHaveLength(2);
      expect(finalEntities.map((e) => e.name)).toEqual(
        expect.arrayContaining(['Existing 1', 'Existing 2'])
      );
      expect(finalEntities.map((e) => e.age)).toEqual(
        expect.arrayContaining([20, 25])
      );
    });

    it('should handle nested operations in runTransaction', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const result = await repo.runTransaction(async (txRepo) => {
        // create initial batch
        const batch1 = await txRepo.createMany([
          createTestEntity({ name: 'Batch 1 - Item 1', isActive: true }),
          createTestEntity({ name: 'Batch 1 - Item 2', isActive: true }),
        ]);

        // find active entities
        const activeEntities = await txRepo.find({ isActive: true });
        expect(activeEntities).toHaveLength(2);

        // create second batch based on first batch
        const batch2Entities = activeEntities.map((e) =>
          createTestEntity({
            name: `Derived from ${e.name}`,
            isActive: false,
          })
        );
        const batch2 = await txRepo.createMany(batch2Entities);

        // update original entities
        await txRepo.updateMany(batch1, { set: { age: 50 } });

        // final count
        const allEntities = await txRepo.find({});

        return {
          batch1Count: batch1.length,
          batch2Count: batch2.length,
          totalCount: allEntities.length,
          activeCount: allEntities.filter((e) => e.isActive).length,
        };
      });

      expect(result.batch1Count).toBe(2);
      expect(result.batch2Count).toBe(2);
      expect(result.totalCount).toBe(4);
      expect(result.activeCount).toBe(2);

      // verify final state
      const finalEntities = await repo.find({});
      expect(finalEntities).toHaveLength(4);
      expect(finalEntities.filter((e) => e.age === 50)).toHaveLength(2);
    });

    it('should work with scoped repositories in transactions', async () => {
      const baseRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { tenantId: 'acme' },
      });

      await scopedRepo.runTransaction(async (txRepo) => {
        const ids = await txRepo.createMany([
          omit(createTestEntity({ name: 'Scoped TX 1' }), 'tenantId'),
          omit(createTestEntity({ name: 'Scoped TX 2' }), 'tenantId'),
        ]);

        // verify entities are created with scope
        const created = await txRepo.find({});
        expect(created).toHaveLength(2);
        expect(created.every((e) => e.tenantId === 'acme')).toBe(true);

        // update through scoped repo
        await txRepo.updateMany(ids, { set: { age: 88 } });
      });

      // verify through base repo
      const allEntities = await baseRepo.find({});
      expect(allEntities).toHaveLength(2);
      expect(
        allEntities.every((e) => e.tenantId === 'acme' && e.age === 88)
      ).toBe(true);
    });

    it('should work with upsert operations in transactions', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      const initialEntity = createTestEntity({
        name: 'Initial TX Entity',
        age: 30,
      });
      const existingId = await repo.create(initialEntity);

      const result = await repo.runTransaction(async (txRepo) => {
        // upsert existing entity (should update)
        const updatedEntity = createTestEntity({
          id: existingId,
          name: 'Updated in TX',
          age: 40,
        });
        await txRepo.upsert(updatedEntity);

        // upsert new entities (should create)
        const newEntities = [
          createTestEntity({ id: 'tx-new-1', name: 'TX New 1', age: 50 }),
          createTestEntity({ id: 'tx-new-2', name: 'TX New 2', age: 60 }),
        ];
        await txRepo.upsertMany(newEntities);

        // verify within transaction
        const allEntities = await txRepo.find({});
        return {
          totalCount: allEntities.length,
          updatedEntity: allEntities.find((e) => e.id === existingId),
          newEntities: allEntities.filter((e) => e.id.startsWith('tx-new')),
        };
      });

      expect(result.totalCount).toBe(3);
      expect(result.updatedEntity).toMatchObject({
        name: 'Updated in TX',
        age: 40,
      });
      expect(result.newEntities).toHaveLength(2);
      expect(result.newEntities.map((e) => e.name)).toEqual(
        expect.arrayContaining(['TX New 1', 'TX New 2'])
      );

      // verify changes persisted after transaction
      const finalEntities = await repo.find({});
      expect(finalEntities).toHaveLength(3);
      expect(finalEntities.find((e) => e.id === existingId)?.name).toBe(
        'Updated in TX'
      );
    });
  });

  describe('configuration validation', () => {
    it('should throw error when timestamp keys are duplicated', () => {
      expect(() => {
        createSmartMongoRepo({
          collection: testCollection(),
          mongoClient: mongo.client,
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
          'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.'
      );
    });

    it('should throw error when version key conflicts with timestamp key', () => {
      expect(() => {
        createSmartMongoRepo({
          collection: testCollection(),
          mongoClient: mongo.client,
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
          'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.'
      );
    });

    it('should throw error when soft delete key conflicts with other keys', () => {
      expect(() => {
        createSmartMongoRepo({
          collection: testCollection(),
          mongoClient: mongo.client,
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
          'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.'
      );
    });

    it('should not throw error when all keys are unique', () => {
      expect(() => {
        createSmartMongoRepo({
          collection: testCollection(),
          mongoClient: mongo.client,
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
        createSmartMongoRepo({
          collection:
            testCollection() as unknown as Collection<EntityWithReadonlyFields>,
          mongoClient: mongo.client,
          options: {
            softDelete: true,
            timestampKeys: { createdAt: 'created' },
            version: '_v',
          },
          scope: {
            _v: 1,
            _deleted: true,
            created: new Date(),
            _updatedAt: new Date(),
          },
        })
      ).toThrow(
        'Readonly fields found in scope: _v, _deleted, created, _updatedAt'
      );
    });
  });
});

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
