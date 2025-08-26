import { createSmartMongoRepo } from '@chd/smart-repo';
import { omit, range, sortBy } from 'lodash-es';
import { Collection } from 'mongodb';
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
        organizationId: 'org123',
        name: 'Test User',
        email: 'test@example.com',
        age: 30,
        isActive: true,
      });
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
        id: firstEntity!.id,
        organizationId: firstEntity!.organizationId,
        name: 'User 1',
        email: 'test@example.com',
        age: 30,
        isActive: true,
      });

      // verify second entity (with optional fields)
      const secondEntity = found.find((e) => e.name === 'User 2');
      expect(secondEntity).toEqual({
        id: secondEntity!.id,
        organizationId: secondEntity!.organizationId,
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
        organizationId: entity.organizationId,
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
        organizationId: entity.organizationId,
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
        id: createdId,
        ...omit(entity, 'metadata'),
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
        organizationId: entity.organizationId,
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

      const repoWithUndefined = createSmartMongoRepo({
        collection:
          testCollection() as unknown as Collection<EntityWithUndefinedField>,
        mongoClient: mongo.client,
      });

      const entityData = {
        ...createTestEntity(),
        description: 'test description' as string | undefined,
      };

      const createdId = await repoWithUndefined.create(entityData);

      // Both optional properties should be allowed to unset
      await repoWithUndefined.update(createdId, {
        unset: ['description', 'metadata'],
      });

      // The following would cause TypeScript compile errors (commented out to avoid build failure):
      // ❌ await repo.update(createdId, { unset: ['name'] });         // name is required
      // ❌ await repo.update(createdId, { unset: ['email'] });        // email is required
      // ❌ await repo.update(createdId, { unset: ['age'] });          // age is required
      // ❌ await repo.update(createdId, { unset: ['isActive'] });     // isActive is required
      // ❌ await repo.update(createdId, { unset: ['organizationId'] }); // organizationId is required
      // ❌ await repoWithUndefined.update(createdId2, { unset: ['name'] }); // name cannot be undefined

      const updated = await repoWithUndefined.getById(createdId);
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
      const createdIds: string[] = [];

      for (const entity of entities) {
        const createdId = await repo.create(entity);
        createdIds.push(createdId);
      }

      await repo.updateMany(createdIds, { set: { isActive: false } });

      for (const id of createdIds) {
        const updated = await repo.getById(id);
        expect(updated?.isActive).toBe(false);
      }
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
      const entity = {
        id: 'test-upsert-id',
        ...createTestEntity({ name: 'Upsert Test' }),
      };

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
      const upsertEntity = {
        id: createdId,
        ...createTestEntity({
          name: 'Replaced',
          age: 50,
          email: 'replaced@example.com',
          metadata: { tags: ['replaced'], notes: 'Completely replaced' },
        }),
      };

      await repo.upsert(upsertEntity);

      const retrieved = await repo.getById(createdId);
      expect(retrieved).toEqual(upsertEntity);
    });

    it('should handle entities with optional fields', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entity = {
        id: 'optional-fields-test',
        ...createTestEntity({
          name: 'Optional Fields',
          metadata: undefined,
        }),
      };

      await repo.upsert(entity);

      const retrieved = await repo.getById('optional-fields-test');
      expect(retrieved).toEqual({
        id: 'optional-fields-test',
        organizationId: 'org123',
        name: 'Optional Fields',
        email: 'test@example.com',
        age: 30,
        isActive: true,
      });
    });

    it('should work with scoped repositories', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });
      const entity = {
        id: 'scoped-upsert',
        ...omit(createTestEntity({ name: 'Scoped Upsert' }), 'isActive'),
      };

      await scopedRepo.upsert(entity);

      const retrieved = await scopedRepo.getById('scoped-upsert');
      expect(retrieved).toMatchObject({
        id: 'scoped-upsert',
        name: 'Scoped Upsert',
        isActive: true,
      });
    });

    it('should prevent upserting entities with readonly scope properties', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });
      const entityWithScope = {
        id: 'invalid-scope',
        ...createTestEntity({ name: 'Invalid', isActive: false }),
      };

      await expect(scopedRepo.upsert(entityWithScope)).rejects.toThrow(
        'Cannot upsert readonly properties: isActive'
      );
    });

    it('should set timestamps (app time)', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { traceTimestamps: true },
      });

      const entity = {
        id: 'timestamp-create',
        ...createTestEntity({ name: 'Timestamp Create' }),
      };

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

      const entity = {
        id: 'mongo-timestamp',
        ...createTestEntity({ name: 'Mongo Timestamp' }),
      };

      await repo.upsert(entity);

      const raw = await rawTestCollection().findOne({ _id: 'mongo-timestamp' });
      expect(raw?._createdAt).toBeInstanceOf(Date);
      expect(raw?._updatedAt).toBeInstanceOf(Date);
      expect(
        Math.abs(raw!._createdAt.getTime() - raw!._updatedAt.getTime())
      ).toBeLessThan(100); // _createdAt is app time

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

    it('should work with soft delete enabled', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { softDelete: true },
      });

      const entity = {
        id: 'soft-delete-upsert',
        ...createTestEntity({ name: 'Soft Delete Test' }),
      };

      await repo.upsert(entity);

      const retrieved = await repo.getById('soft-delete-upsert');
      expect(retrieved).toEqual(entity);

      // verify it's not marked as deleted
      const raw = await rawTestCollection().findOne({
        _id: 'soft-delete-upsert',
      });
      expect(raw).not.toHaveProperty('_deleted');
    });

    it('should overwrite soft-deleted entities via upsert', async () => {
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

      // upsert should create a new entity (overwriting the soft-deleted one)
      const upsertEntity = {
        id: createdId,
        ...createTestEntity({ name: 'Upserted After Delete' }),
      };
      await repo.upsert(upsertEntity);

      // should be able to retrieve it now
      const retrieved = await repo.getById(createdId);
      expect(retrieved).toEqual(upsertEntity);

      // verify the _deleted flag is gone
      const raw = await rawTestCollection().findOne({ _id: createdId });
      expect(raw).not.toHaveProperty('_deleted');
    });
  });

  describe('upsertMany', () => {
    it('should create multiple new entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const entities = [
        { id: 'upsert-1', ...createTestEntity({ name: 'Entity 1', age: 25 }) },
        { id: 'upsert-2', ...createTestEntity({ name: 'Entity 2', age: 30 }) },
        { id: 'upsert-3', ...createTestEntity({ name: 'Entity 3', age: 35 }) },
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
      const [id1, id2] = await Promise.all(initialEntities.map(repo.create));

      // upsert with replacements
      const upsertEntities = [
        {
          id: id1,
          ...createTestEntity({
            name: 'Replaced 1',
            age: 99,
            email: 'replaced1@example.com',
          }),
        },
        {
          id: id2,
          ...createTestEntity({
            name: 'Replaced 2',
            age: 88,
            email: 'replaced2@example.com',
          }),
        },
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
        {
          id: existingId,
          ...createTestEntity({ name: 'Updated Existing', age: 45 }),
        },
        {
          id: 'new-entity-1',
          ...createTestEntity({ name: 'New Entity 1', age: 50 }),
        },
        {
          id: 'new-entity-2',
          ...createTestEntity({ name: 'New Entity 2', age: 55 }),
        },
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
      const entities = range(0, 1500).map((i) => ({
        id: `batch-upsert-${i}`,
        ...createTestEntity({
          name: `Batch Entity ${i}`,
          email: `batch${i}@example.com`,
          age: 20 + i,
        }),
      }));

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
        scope: { isActive: true },
      });
      const entities = [
        {
          id: 'scoped-many-1',
          ...omit(createTestEntity({ name: 'Scoped 1' }), 'isActive'),
        },
        {
          id: 'scoped-many-2',
          ...omit(createTestEntity({ name: 'Scoped 2' }), 'isActive'),
        },
      ];

      await scopedRepo.upsertMany(entities);

      const [found] = await scopedRepo.getByIds([
        'scoped-many-1',
        'scoped-many-2',
      ]);
      expect(found).toHaveLength(2);
      expect(found.every((e) => e.isActive)).toBe(true);
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

    it('should not affect non-existent entities', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      // this should not throw an error
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
      const createdIds: string[] = [];

      for (const entity of entities) {
        const createdId = await repo.create(entity);
        createdIds.push(createdId);
      }

      await repo.deleteMany(createdIds);

      for (const id of createdIds) {
        const deleted = await repo.getById(id);
        expect(deleted).toBeNull();
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
      const createdIds: string[] = [];

      for (const entity of entities) {
        const createdId = await repo.create(entity);
        createdIds.push(createdId);
      }

      await repo.deleteMany(createdIds);

      for (const id of createdIds) {
        const deleted = await repo.getById(id);
        expect(deleted).toBeNull();
      }
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
      const entities = [
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
        createTestEntity({ name: 'David', age: 40, isActive: true }),
      ];

      for (const entity of entities) {
        await repo.create(entity);
      }

      const activeUsers = await repo.find({ isActive: true });
      expect(activeUsers).toHaveLength(3);
      activeUsers.forEach((user) => {
        expect(user.isActive).toBe(true);
      });

      // Note: MongoDB query operators are not supported in the generic repo interface
      // This would need to be implemented as a special-purpose function
      const youngUsers = await repo.find({ age: 25 }); // exact match only
      expect(youngUsers).toHaveLength(1);
      expect(youngUsers[0].name).toBe('Alice');
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
      const entities = [
        createTestEntity({ name: 'Alice', age: 25, isActive: true }),
        createTestEntity({ name: 'Bob', age: 30, isActive: true }),
        createTestEntity({ name: 'Charlie', age: 35, isActive: false }),
        createTestEntity({ name: 'David', age: 40, isActive: true }),
      ];

      for (const entity of entities) {
        await repo.create(entity);
      }

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

  describe('scoping', () => {
    it('scoped repo only has access to entities matching the scope', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });

      const [, , inactiveId] = await repo.createMany([
        createTestEntity({ name: 'Active User 1', isActive: true }),
        createTestEntity({ name: 'Active User 2', isActive: true }),
        createTestEntity({ name: 'Inactive User', isActive: false }),
      ]);

      const inactive = await scopedRepo.getById(inactiveId);
      expect(inactive).toBeNull();

      const activeUsers = await scopedRepo.find({});
      expect(activeUsers).toHaveLength(2);
      activeUsers.forEach((user) => {
        expect(user.isActive).toBe(true);
      });

      const count = await scopedRepo.count({});
      expect(count).toBe(2);
    });

    it('adds scope when creating entities', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });

      const id = await scopedRepo.create(omit(createTestEntity(), 'isActive'));
      const moreIds = await scopedRepo.createMany(
        range(0, 2).map((_) => omit(createTestEntity(), 'isActive'))
      );

      const result = await scopedRepo.getByIds([id, ...moreIds], {
        isActive: true,
      }); // with projection

      expect(result).toEqual([
        [{ isActive: true }, { isActive: true }, { isActive: true }],
        [],
      ]);
    });

    it('should prevent creating entities with scope properties', async () => {
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });

      // this should work (no scope property)
      const { isActive, ...validEntity } = createTestEntity({
        name: 'Valid User',
      });
      await scopedRepo.create(validEntity);

      // this should fail at runtime
      const invalidEntity = createTestEntity({
        name: 'Invalid User',
        isActive: false,
      });
      await expect(scopedRepo.create(invalidEntity)).rejects.toThrow(
        'Cannot create readonly properties: isActive'
      );
    });

    it('should prevent updating entities with scope properties', async () => {
      // create a scoped repository
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });

      // create an entity first
      const entity = createTestEntity({ name: 'Test User', isActive: true });
      const id = await repo.create(entity);

      // this should work (no scope property)
      await scopedRepo.update(id, { set: { name: 'Updated Name' } });

      // this should fail at runtime (scope property in set)
      await expect(
        scopedRepo.update(id, { set: { isActive: false } } as any)
      ).rejects.toThrow('Cannot update readonly properties: isActive');

      // this should fail at runtime (scope property in unset)
      await expect(
        scopedRepo.update(id, { unset: ['isActive'] } as any)
      ).rejects.toThrow('Cannot unset readonly properties: isActive');
    });

    it('should prevent creating many entities with scope properties', async () => {
      // create a scoped repository
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });

      const entities = [
        createTestEntity({ name: 'User 1' }),
        createTestEntity({ name: 'User 2', isActive: false }), // has scope property
      ];

      // this should fail at runtime
      await expect(scopedRepo.createMany(entities)).rejects.toThrow(
        'Cannot create readonly properties: isActive'
      );
    });

    it('should allow reading scope properties', async () => {
      // create a scoped repository
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });
      const scopedRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { isActive: true },
      });

      const entities = [
        createTestEntity({ name: 'Active User 1', isActive: true }),
        createTestEntity({ name: 'Active User 2', isActive: true }),
        createTestEntity({ name: 'Inactive User', isActive: false }),
      ];

      for (const entity of entities) {
        await repo.create(entity);
      }

      // should be able to query by scope properties
      const activeUsers = await scopedRepo.find({ isActive: true });
      expect(activeUsers).toHaveLength(2);

      // should be able to project scope properties
      const projectedUsers = await scopedRepo.find(
        {},
        { isActive: true, name: true }
      );
      expect(projectedUsers).toHaveLength(2);
      projectedUsers.forEach((user) => {
        expect(user).toHaveProperty('isActive');
        expect(user).toHaveProperty('name');
        expect(user).not.toHaveProperty('email');
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
      const timestampConfig = {
        createdAt: 'createdAt' as const,
        updatedAt: 'updatedAt' as const,
        deletedAt: 'deletedAt' as const,
      };

      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          traceTimestamps: true,
          timestampKeys: timestampConfig,
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

      // project only timestamp fields
      const timestampsOnly = await repo.getById(id, {
        createdAt: true,
        updatedAt: true,
      });
      expect(timestampsOnly).toMatchObject({
        createdAt: timestampsOnly!.createdAt,
        updatedAt: timestampsOnly!.updatedAt,
      });
      expect(timestampsOnly).not.toHaveProperty('name');

      // project timestamp fields with other fields
      const mixed = await repo.getById(id, { name: true, createdAt: true });
      expect(mixed).toMatchObject({
        name: 'Projection Test',
        createdAt: mixed!.createdAt,
      });
      expect(mixed).not.toHaveProperty('updatedAt');
      expect(mixed).not.toHaveProperty('email');
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

      // attempting to update timestamp fields should fail
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
      const timestampConfig = {
        createdAt: 'createdAt' as const,
        updatedAt: 'updatedAt' as const,
      };

      // Note: traceTimestamps is NOT explicitly set, should default to true
      const repo = createSmartMongoRepo({
        collection: testCollectionWithTimestamps(),
        mongoClient: mongo.client,
        options: {
          timestampKeys: timestampConfig, // no traceTimestamps option
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

      const entityWithId = {
        id: 'upsert-version-test',
        ...createTestEntity({ name: 'Upsert Version Test' }),
      };

      // first upsert (insert) - should set version to 1
      await repo.upsert(entityWithId);
      const raw1 = await rawTestCollection().findOne({
        _id: 'upsert-version-test',
      });
      expect(raw1).toHaveProperty('_version', 1);

      // second upsert (update) - should increment version to 2
      await repo.upsert({ ...entityWithId, name: 'Updated Upsert' });
      const raw2 = await rawTestCollection().findOne({
        _id: 'upsert-version-test',
      });
      expect(raw2).toHaveProperty('_version', 2);
    });

    it('should prevent writing to version field', async () => {
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

      // should not allow creating with version field
      await expect(
        repo.create({ ...createTestEntity(), version: 5 } as any)
      ).rejects.toThrow('Cannot create readonly properties: version');

      // should not allow updating version field
      expect(() =>
        repo.buildUpdateOperation({ set: { version: 10 } } as any)
      ).toThrow('Cannot update readonly properties: version');
    });

    it('should work with bulk operations', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        options: { version: true },
      });

      // create multiple entities
      const entities = [
        createTestEntity({ name: 'Bulk 1' }),
        createTestEntity({ name: 'Bulk 2' }),
        createTestEntity({ name: 'Bulk 3' }),
      ];

      const ids = await repo.createMany(entities);

      // all should have version 1
      for (const id of ids) {
        const raw = await rawTestCollection().findOne({ _id: id });
        expect(raw).toHaveProperty('_version', 1);
      }

      // bulk update
      await repo.updateMany(ids, { set: { name: 'Updated Bulk' } });

      // all should have version 2
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

    it('buildUpdateOperation prevents writing read-only props', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { organizationId: 'acme' },
        options: { softDelete: true, traceTimestamps: true },
      });

      expect(() =>
        repo.buildUpdateOperation({
          set: {
            name: 'Updated1',
            _id: 'foo',
            organizationId: 'bar',
            _createdAt: new Date(),
          },
        })
      ).toThrow(
        'Cannot update readonly properties: _id, organizationId, _createdAt'
      );
    });

    it('applyScopeForRead', async () => {
      const acmeRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { organizationId: 'acme' },
        options: { softDelete: true },
      });

      const fooRepo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { organizationId: 'foo' },
        options: { softDelete: true },
      });

      const ids = await Promise.all([
        acmeRepo.create(
          omit(
            createTestEntity({ name: '0', isActive: true }),
            'organizationId'
          )
        ),
        acmeRepo.create(
          omit(
            createTestEntity({ name: '1', isActive: true }),
            'organizationId'
          )
        ),
        acmeRepo.create(
          omit(
            createTestEntity({ name: '2', isActive: false }),
            'organizationId'
          )
        ),
        fooRepo.create(
          omit(
            createTestEntity({ name: '3', isActive: true }),
            'organizationId'
          )
        ),
        fooRepo.create(
          omit(
            createTestEntity({ name: '4', isActive: true }),
            'organizationId'
          )
        ),
        fooRepo.create(
          omit(
            createTestEntity({ name: '5', isActive: false }),
            'organizationId'
          )
        ),
        fooRepo.create(
          omit(
            createTestEntity({ name: '6', isActive: false }),
            'organizationId'
          )
        ),
      ]);

      await fooRepo.delete(ids[6]);

      const results = await testCollection()
        .aggregate([
          { $match: fooRepo.applyScopeForRead({}) },
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

    it('applyScopeForWrite', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
        scope: { organizationId: 'acme' },
      });

      const id = await repo.create(omit(createTestEntity(), 'organizationId'));

      await repo.collection.updateOne(repo.applyScopeForWrite({ _id: id }), {
        $set: { _notInModel: 'foo' },
      });

      const updated = await repo.collection.findOne({ _id: id });

      expect(updated).toMatchObject({ _notInModel: 'foo' });
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

          // create multiple entities in the transaction
          const entities = [
            createTestEntity({ name: 'TX Entity 1' }),
            createTestEntity({ name: 'TX Entity 2' }),
            createTestEntity({ name: 'TX Entity 3' }),
          ];

          const createdIds = await txRepo.createMany(entities);

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
        // create some test data
        const entities = [
          createTestEntity({ name: 'Run TX 1', age: 25 }),
          createTestEntity({ name: 'Run TX 2', age: 30 }),
          createTestEntity({ name: 'Run TX 3', age: 35 }),
        ];

        const createdIds = await txRepo.createMany(entities);

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

            // create new entities
            const newEntities = [
              createTestEntity({ name: 'Should Not Persist 1' }),
              createTestEntity({ name: 'Should Not Persist 2' }),
            ];
            await txRepo.createMany(newEntities);

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

      // create some initial data
      const initialEntities = [
        createTestEntity({ name: 'Existing 1', age: 20 }),
        createTestEntity({ name: 'Existing 2', age: 25 }),
      ];
      const initialIds = await repo.createMany(initialEntities);

      try {
        await repo.runTransaction(async (txRepo) => {
          // create new entities
          const newEntities = [
            createTestEntity({ name: 'Rollback Test 1' }),
            createTestEntity({ name: 'Rollback Test 2' }),
          ];
          await txRepo.createMany(newEntities);

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
        scope: { isActive: true },
      });

      await scopedRepo.runTransaction(async (txRepo) => {
        // create entities through scoped repo (should automatically set isActive: true)
        const ids = await txRepo.createMany([
          omit(createTestEntity({ name: 'Scoped TX 1' }), 'isActive'),
          omit(createTestEntity({ name: 'Scoped TX 2' }), 'isActive'),
        ]);

        // verify entities are created with scope
        const created = await txRepo.find({});
        expect(created).toHaveLength(2);
        expect(created.every((e) => e.isActive)).toBe(true);

        // update through scoped repo
        await txRepo.updateMany(ids, { set: { age: 88 } });
      });

      // verify through base repo
      const allEntities = await baseRepo.find({});
      expect(allEntities).toHaveLength(2);
      expect(allEntities.every((e) => e.isActive && e.age === 88)).toBe(true);
    });

    it('should work with upsert operations in transactions', async () => {
      const repo = createSmartMongoRepo({
        collection: testCollection(),
        mongoClient: mongo.client,
      });

      // create some initial data
      const initialEntity = createTestEntity({
        name: 'Initial TX Entity',
        age: 30,
      });
      const existingId = await repo.create(initialEntity);

      const result = await repo.runTransaction(async (txRepo) => {
        // upsert existing entity (should update)
        const updatedEntity = {
          id: existingId,
          ...createTestEntity({ name: 'Updated in TX', age: 40 }),
        };
        await txRepo.upsert(updatedEntity);

        // upsert new entities (should create)
        const newEntities = [
          {
            id: 'tx-new-1',
            ...createTestEntity({ name: 'TX New 1', age: 50 }),
          },
          {
            id: 'tx-new-2',
            ...createTestEntity({ name: 'TX New 2', age: 60 }),
          },
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
  });
});

type TestEntity = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  age: number;
  isActive: boolean;
  metadata?: {
    tags: string[];
    notes?: string;
  };
};

function createTestEntity(
  overrides: Partial<Omit<TestEntity, 'id'>> = {}
): Omit<TestEntity, 'id'> {
  return {
    organizationId: 'org123',
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
