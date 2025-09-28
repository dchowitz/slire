import { CollectionReference } from '@google-cloud/firestore';
import { v4 as uuidv4 } from 'uuid';
import { createSmartFirestoreRepo } from '../lib/firestore-repo';
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

      // Check raw document in Firestore
      const rawDoc = await rawTestCollection().doc(createdId).get();
      const rawData = rawDoc.data();

      // Input managed field values should be stripped and replaced with system-managed values
      expect(rawData).not.toHaveProperty('_id'); // _id should never be stored in Firestore documents

      // System should set proper managed field values (not the input values)
      expect(rawData).toMatchObject({
        _version: 1, // System sets version to 1 (not 42 from input)
        _createdAt: fixedTimestamp,
        _updatedAt: fixedTimestamp,
        _trace: {
          userId: 'test-user', // User context preserved
          _op: 'create',
          _at: fixedTimestamp,
        },
      });

      // _deleted should not be present for a create operation
      expect(rawData).not.toHaveProperty('_deleted');

      // Business fields should be present
      expect(rawData).toMatchObject({
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

      // Check raw document in Firestore
      const rawDoc = await rawTestCollection().doc(createdId).get();
      const rawData = rawDoc.data();

      // Custom timestamp fields should not be present from input (stripped and auto-managed)
      // They should be set by the system with the fixed timestamp (not input values)
      expect(rawData).toMatchObject({
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
