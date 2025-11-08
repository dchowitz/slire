import { MinKey, ObjectId } from 'mongodb';
import { getMongoMinFilter } from '../src/get-mongo-min-filter';

describe('getMongoMinFilter', () => {
  describe('single field ascending', () => {
    it('should create filter for single field with value', () => {
      const result = getMongoMinFilter({
        sortOption: { name: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', name: 'Bob' },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ name: { $gt: 'Bob' } }] },
          { $and: [{ name: 'Bob' }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should handle null values correctly', () => {
      const result = getMongoMinFilter({
        sortOption: { age: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', age: null },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                age: {
                  $nin: [[], null, MinKey],
                  $exists: true,
                },
              },
            ],
          },
          {
            $and: [
              { $or: [{ age: { $exists: false } }, { age: null }] },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });

    it('should handle undefined values correctly', () => {
      const result = getMongoMinFilter({
        sortOption: { age: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', age: undefined },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                age: {
                  $nin: [[], null, MinKey],
                  $exists: true,
                },
              },
            ],
          },
          {
            $and: [
              { $or: [{ age: { $exists: false } }, { age: null }] },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });
  });

  describe('single field descending', () => {
    it('should create filter for single field with value', () => {
      const result = getMongoMinFilter({
        sortOption: { name: -1, _id: 1 },
        startAfterDoc: { _id: 'id-001', name: 'Bob' },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                $or: [
                  { name: { $lt: 'Bob' } },
                  { name: { $exists: false } },
                  { name: null },
                ],
              },
            ],
          },
          { $and: [{ name: 'Bob' }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should handle null values correctly', () => {
      const result = getMongoMinFilter({
        sortOption: { age: -1, _id: 1 },
        startAfterDoc: { _id: 'id-001', age: null },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                age: {
                  $in: [[], MinKey],
                },
              },
            ],
          },
          {
            $and: [
              { $or: [{ age: { $exists: false } }, { age: null }] },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });
  });

  describe('multi-field ordering', () => {
    it('should create filter for two fields ascending', () => {
      const result = getMongoMinFilter({
        sortOption: { name: 1, age: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', name: 'Bob', age: 30 },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ name: { $gt: 'Bob' } }] },
          { $and: [{ name: 'Bob' }, { age: { $gt: 30 } }] },
          { $and: [{ name: 'Bob' }, { age: 30 }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should create filter for mixed directions', () => {
      const result = getMongoMinFilter({
        sortOption: { name: -1, age: 1, _id: -1 },
        startAfterDoc: { _id: 'id-001', name: 'Bob', age: 30 },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                $or: [
                  { name: { $lt: 'Bob' } },
                  { name: { $exists: false } },
                  { name: null },
                ],
              },
            ],
          },
          { $and: [{ name: 'Bob' }, { age: { $gt: 30 } }] },
          { $and: [{ name: 'Bob' }, { age: 30 }, { _id: { $lt: 'id-001' } }] },
        ],
      });
    });

    it('should handle three fields with mixed directions', () => {
      const result = getMongoMinFilter({
        sortOption: { category: 1, priority: -1, createdAt: 1, _id: 1 },
        startAfterDoc: {
          _id: 'id-001',
          category: 'urgent',
          priority: 5,
          createdAt: new Date('2024-01-01'),
        },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ category: { $gt: 'urgent' } }] },
          {
            $and: [
              { category: 'urgent' },
              {
                $or: [
                  { priority: { $lt: 5 } },
                  { priority: { $exists: false } },
                  { priority: null },
                ],
              },
            ],
          },
          {
            $and: [
              { category: 'urgent' },
              { priority: 5 },
              { createdAt: { $gt: new Date('2024-01-01') } },
            ],
          },
          {
            $and: [
              { category: 'urgent' },
              { priority: 5 },
              { createdAt: new Date('2024-01-01') },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });
  });

  describe('only _id field', () => {
    it('should create simple filter when only _id is sorted (asc)', () => {
      const result = getMongoMinFilter({
        sortOption: { _id: 1 },
        startAfterDoc: { _id: 'id-001' },
      });

      expect(result).toEqual({
        $or: [{ $and: [{ _id: { $gt: 'id-001' } }] }],
      });
    });

    it('should create simple filter when only _id is sorted (desc)', () => {
      const result = getMongoMinFilter({
        sortOption: { _id: -1 },
        startAfterDoc: { _id: 'id-001' },
      });

      expect(result).toEqual({
        $or: [{ $and: [{ _id: { $lt: 'id-001' } }] }],
      });
    });
  });

  describe('nested fields', () => {
    it('should handle dot notation fields', () => {
      const result = getMongoMinFilter({
        sortOption: { 'user.name': 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', user: { name: 'Alice' } },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ 'user.name': { $gt: 'Alice' } }] },
          { $and: [{ 'user.name': 'Alice' }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should handle null nested field values', () => {
      const result = getMongoMinFilter({
        sortOption: { 'metadata.score': -1, _id: 1 },
        startAfterDoc: { _id: 'id-001', metadata: { score: null } },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                'metadata.score': {
                  $in: [[], MinKey],
                },
              },
            ],
          },
          {
            $and: [
              {
                $or: [
                  { 'metadata.score': { $exists: false } },
                  { 'metadata.score': null },
                ],
              },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });

    it('should handle undefined nested field values', () => {
      const result = getMongoMinFilter({
        sortOption: { 'metadata.score': -1, _id: 1 },
        startAfterDoc: { _id: 'id-001', metadata: {} },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                'metadata.score': {
                  $in: [[], MinKey],
                },
              },
            ],
          },
          {
            $and: [
              {
                $or: [
                  { 'metadata.score': { $exists: false } },
                  { 'metadata.score': null },
                ],
              },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty string values', () => {
      const result = getMongoMinFilter({
        sortOption: { name: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', name: '' },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ name: { $gt: '' } }] },
          { $and: [{ name: '' }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should handle zero values', () => {
      const result = getMongoMinFilter({
        sortOption: { score: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', score: 0 },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ score: { $gt: 0 } }] },
          { $and: [{ score: 0 }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should handle false boolean values', () => {
      const result = getMongoMinFilter({
        sortOption: { isActive: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', isActive: false },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ isActive: { $gt: false } }] },
          { $and: [{ isActive: false }, { _id: { $gt: 'id-001' } }] },
        ],
      });
    });

    it('should handle ObjectId _id values', () => {
      const _id = new ObjectId();
      const result = getMongoMinFilter({
        sortOption: { name: 1, _id: 1 },
        startAfterDoc: {
          _id,
          name: 'Test',
        },
      });

      expect(result).toEqual({
        $or: [
          { $and: [{ name: { $gt: 'Test' } }] },
          {
            $and: [{ name: 'Test' }, { _id: { $gt: _id } }],
          },
        ],
      });
    });
  });

  describe('mixed null and non-null values', () => {
    it('should handle first field null, second field with value', () => {
      const result = getMongoMinFilter({
        sortOption: { category: 1, name: 1, _id: 1 },
        startAfterDoc: { _id: 'id-001', category: null, name: 'Alice' },
      });

      expect(result).toEqual({
        $or: [
          {
            $and: [
              {
                category: {
                  $nin: [[], null, MinKey],
                  $exists: true,
                },
              },
            ],
          },
          {
            $and: [
              { $or: [{ category: { $exists: false } }, { category: null }] },
              { name: { $gt: 'Alice' } },
            ],
          },
          {
            $and: [
              { $or: [{ category: { $exists: false } }, { category: null }] },
              { name: 'Alice' },
              { _id: { $gt: 'id-001' } },
            ],
          },
        ],
      });
    });
  });
});
