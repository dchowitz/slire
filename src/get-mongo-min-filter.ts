import get from 'lodash/get';
import { MinKey } from 'mongodb';

/**
 * Builds a filter that guarantees cursor-based pagination works correctly
 * with custom orderBy clauses. This creates a lexicographic comparison filter
 * that skips all documents up to and including the startAfter document.
 *
 * The sortOption should contain the effective sort fields (with _id last).
 *
 * Example 1:
 * - sortOption: { name: 1, age: 1, _id: 1 }
 * - startAfter doc: { _id: 'X', name: 'Bob', age: 25 }
 * - resulting filter:
 *    (name > 'Bob')
 *    OR (name = 'Bob' AND age > 25)
 *    OR (name = 'Bob' AND age = 25 AND _id > 'X')
 *
 * Example 2:
 * - sortOption: { name: -1, age: 1, _id: 1 }
 * - startAfter doc: { _id: 'X', name: 'Bob', age: 25 }
 * - resulting filter:
 *    (name < 'Bob' OR NULLISH(name))
 *    OR (name = 'Bob' AND age > 25)
 *    OR (name = 'Bob' AND age = 25 AND _id > 'X')
 *
 * Example 3 (only _id):
 * - sortOption: { _id: 1 }
 * - startAfter doc: { _id: 'X' }
 * - resulting filter: (_id > 'X')
 *
 * @see https://www.mongodb.com/docs/manual/reference/bson-type-comparison-order/
 */
export function getMongoMinFilter({
  sortOption,
  startAfterDoc,
}: {
  sortOption: Record<string, 1 | -1>;
  startAfterDoc: any;
}): any {
  // MongoDB BSON type ordering helpers
  const greaterThanNullAndUndefined = {
    $nin: [[], null, MinKey],
    $exists: true,
  };
  const lowerThanNullAndUndefined = { $in: [[], MinKey] };
  const nullish = (field: string) => [
    { [field]: { $exists: false } },
    { [field]: null },
  ];

  const filters: any[] = [];
  const equalityPredicates: any[] = [];

  const options = Object.entries(sortOption);

  for (let i = 0; i < options.length - 1; i++) {
    const [field, direction] = options[i];
    const startAfterValue = get(startAfterDoc, field); // for dot notation
    const filter: any[] = [...equalityPredicates];

    if (startAfterValue == null) {
      filter.push({
        [field]:
          direction === 1
            ? greaterThanNullAndUndefined
            : lowerThanNullAndUndefined,
      });
      equalityPredicates.push({ $or: nullish(field) });
    } else {
      if (direction === 1) {
        filter.push({ [field]: { $gt: startAfterValue } });
      } else {
        filter.push({
          $or: [{ [field]: { $lt: startAfterValue } }, ...nullish(field)],
        });
      }
      equalityPredicates.push({ [field]: startAfterValue });
    }

    filters.push({ $and: filter });
  }

  const [lastKey, dir] = options[options.length - 1];
  if (lastKey !== '_id') {
    // ensure contract is met
    throw new Error('Last sort field must be _id');
  }

  filters.push({
    $and: [
      ...equalityPredicates,
      { _id: { [dir === 1 ? '$gt' : '$lt']: startAfterDoc._id } },
    ],
  });

  return { $or: filters };
}
