import { Collection } from 'mongodb';
import { ManagedFields, RepositoryConfig } from '../lib/repo-config';
import { UpdateOperation } from '../lib/smart-repo';
import { OptionalKeys } from '../lib/types';

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type Entity = {
  id: string;
  tenant: string;
  department: string;
  name: string;
  age: number;
  active: boolean;
  updatedAt: Date;
  _createdAt: Date;
  _v: number;
  _version: number;
  _deleted: boolean;
  optional?: string;
  comment: string | undefined;
};

type X = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  age: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  nested: {
    foo: string;
    bar: {
      x: number;
      y: { even: boolean; deeper?: { z: string } };
    };
  };
  metadata?: {
    tags: string[];
    notes: {
      foo?: string;
      bar?: { x: number; y: { even: boolean; deeper: { z: string } } };
    };
  };
};

function test<
  T extends { id: string },
  S extends Partial<T> = {},
  C extends RepositoryConfig<T> = {},
  M extends ManagedFields<T, C, S> = ManagedFields<T, C, S>,
  UpdateEntity extends Record<string, unknown> = Omit<T, M>,
  UnsetKeys extends OptionalKeys<UpdateEntity> = OptionalKeys<UpdateEntity>,
  CreateEntity extends Record<string, unknown> = Omit<T, M> &
    Partial<Pick<T, M>>
>(_collection: Collection<T>, scope: S, _config: C) {
  console.log(scope);
  return {
    managed: (...fields: M[]) => console.log(fields),
    create: (entity: Prettify<CreateEntity>) => console.log(entity),
    update: (data: Prettify<Partial<UpdateEntity>>) => console.log(data),
    unset: (...keys: Prettify<UnsetKeys>[]) => console.log(keys),
    setUnset: (op: Prettify<UpdateOperation<UpdateEntity>>) => console.log(op),
  };
}

const x = test(
  {} as Collection<X>,
  { organizationId: 'foo' },
  {
    softDelete: true,
    timestampKeys: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    version: 'version',
  }
);

x.managed('id', 'version', 'createdAt', 'updatedAt');
x.unset('metadata');
x.setUnset({ unset: ['metadata'] });

const entity = test(
  {} as Collection<Entity>,
  { tenant: 'foo', department: 'bar' },
  {
    softDelete: true,
    timestampKeys: { updatedAt: 'updatedAt' },
    version: '_v',
  }
);

entity.managed('department', '_v');

entity.create({
  // id: 'foo',
  // tenant: 'adf',
  // department: 'sdf',
  name: 'bar',
  age: 22,
  active: true,
  // _v: 3,
  _version: 3,
  comment: undefined,
});

entity.update({
  comment: 'foo',
  // department: 'bar',
});

entity.unset('comment', 'optional');

entity.setUnset({
  set: { name: 'foo' },
  unset: ['comment', 'comment', 'optional'],
});
