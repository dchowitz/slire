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
