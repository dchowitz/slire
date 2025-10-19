// utility type to expand complex types for better IDE tooltips
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

// utility type to extract keys of properties that can be undefined
export type OptionalKeys<T> = {
  [K in keyof T]: undefined extends T[K] ? K : never;
}[keyof T];

// utility type to extract keys of properties that are numbers
export type NumberKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];

// utility type to extract keys of properties that are Dates
export type DateKeys<T> = {
  [K in keyof T]: T[K] extends Date
    ? K
    : T[K] extends Date | undefined
    ? K
    : never;
}[keyof T] &
  string;

// utility type to extract keys of properties that are objects (not primitives, excluding Date)
export type ObjectKeys<T> = {
  [K in keyof T]: T[K] extends object
    ? T[K] extends Date
      ? never
      : K
    : T[K] extends object | undefined
    ? T[K] extends Date | undefined
      ? never
      : K
    : never;
}[keyof T] &
  string;

// utility type to extract keys of properties that are strings
export type StringKeys<T> = {
  [K in keyof T]: T[K] extends string
    ? K
    : T[K] extends string | undefined
    ? K
    : never;
}[keyof T] &
  string;

// Nested path typing helpers (depth-limited recursive) for optional leaves

// Treat these as primitives for path derivation
export type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp;

// Depth-limited recursive optional leaf paths (max depth 4)
// Includes both root optional keys and nested paths where the leaf property is optional

type Decrease<D> = D extends 4
  ? 3
  : D extends 3
  ? 2
  : D extends 2
  ? 1
  : D extends 1
  ? 0
  : never;

export type OptionalPath<
  T,
  Prefix extends string = '',
  Depth extends number = 4
> = Depth extends never
  ? never
  : T extends Primitive
  ? never
  : T extends ReadonlyArray<any> | any[]
  ? never
  : T extends { [K in keyof T]: T[K] }
  ? {
      [K in Extract<keyof T, string>]:
        | (undefined extends T[K]
            ? Prefix extends ''
              ? K
              : `${Prefix}.${K}`
            : never)
        | OptionalPath<
            T[K],
            Prefix extends '' ? K : `${Prefix}.${K}`,
            Decrease<Depth>
          >;
    }[Extract<keyof T, string>]
  : never;
