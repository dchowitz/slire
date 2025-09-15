import { ManagedFields, RepositoryConfig } from '@chd/smart-repo';
import { Collection } from 'mongodb';

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type DeepPrettify<T> = T extends (...args: any[]) => any
  ? T
  : T extends object
  ? { [K in keyof T]: DeepPrettify<T[K]> }
  : T;

type Entity = {
  id: string;
  name: string;
  age: number;
  active: boolean;
  updatedAt: Date;
  _createdAt: Date;
  _v: number;
  _version: number;
  _deleted: boolean;
};

function test<
  T extends { id: string },
  C extends RepositoryConfig<T>,
  M extends ManagedFields<T, C>,
  InputEntity extends Omit<T, M> & Partial<Pick<T, M>>
>(_collection: Collection<T>, _config: C) {
  return {
    foo: (field: M) => console.log(field),
    set: (entity: Prettify<InputEntity>) => console.log(entity),
  };
}

const { foo, set } = test({} as Collection<Entity>, {
  softDelete: true,
  timestampKeys: { updatedAt: 'updatedAt' },
  version: true,
});

foo('_version');

set({
  // id: 'foo',
  name: 'bar',
  age: 22,
  active: true,
  _v: 3,
  // _version: 3,
});
