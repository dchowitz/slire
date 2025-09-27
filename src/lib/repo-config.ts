// utility type to expand complex types for better IDE tooltips
type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

// projection type: { field1: true, field2: true }
export type Projection<T> = Partial<Record<keyof T, true>>;

// mapped type for projected result
export type Projected<T, P extends Projection<T> | undefined> = Prettify<
  P extends Projection<T>
    ? { [K in keyof P]: K extends keyof T ? T[K] : never }
    : T
>;

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

// timestamp configuration type
export type TimestampConfig<T> = {
  createdAt?: DateKeys<T>;
  updatedAt?: DateKeys<T>;
  deletedAt?: DateKeys<T>;
};

export type UpdateOperation<T> =
  | { set: Partial<T>; unset?: never }
  | { set?: never; unset: OptionalKeys<T>[] }
  | { set: Partial<T>; unset: OptionalKeys<T>[] };

export type RepositoryConfig<T> = {
  generateId?: () => string;
  softDelete?: boolean;
  traceTimestamps?: true | 'server' | (() => Date);
  timestampKeys?: TimestampConfig<T>;
  version?: true | NumberKeys<T>;
  identity?: 'synced' | 'detached';
  traceKey?: ObjectKeys<T>;
  traceStrategy?: 'latest' | 'bounded';
  traceLimit?: number;
};

// Repo-managed fields part of T (based on repo config and scope).
export type ManagedFields<
  T,
  Config extends RepositoryConfig<T>,
  Scope extends Partial<T>
> =
  | 'id'
  | Extract<keyof Scope, keyof T>
  | (Config['softDelete'] extends true
      ? Extract<typeof SOFT_DELETE_KEY, keyof T>
      : never)
  | (Config['traceTimestamps'] extends undefined
      ? never
      : Extract<
          | typeof DEFAULT_CREATED_AT_KEY
          | typeof DEFAULT_UPDATED_AT_KEY
          | typeof DEFAULT_DELETED_AT_KEY,
          keyof T
        >)
  | (Config['timestampKeys'] extends undefined
      ? never
      : Extract<
          Config['timestampKeys'][keyof Config['timestampKeys']],
          keyof T
        >)
  | (Config['version'] extends true
      ? Extract<typeof DEFAULT_VERSION_KEY, keyof T>
      : never)
  | (Config['version'] extends keyof T
      ? Extract<Config['version'], keyof T>
      : never)
  | (Config['traceKey'] extends string
      ? Extract<Config['traceKey'], keyof T>
      : Extract<typeof DEFAULT_TRACE_KEY, keyof T>);

// Constants that can be shared across implementations
const SOFT_DELETE_KEY = '_deleted';
const DEFAULT_VERSION_KEY = '_version';
const DEFAULT_CREATED_AT_KEY = '_createdAt';
const DEFAULT_UPDATED_AT_KEY = '_updatedAt';
const DEFAULT_DELETED_AT_KEY = '_deletedAt';
const DEFAULT_TRACE_KEY = '_trace';

// Write operation types for shared logic
export type WriteOp = 'create' | 'update' | 'delete';

// Factory function that creates database-agnostic helper functions
export function repoConfig<T extends { id: string }>(
  config: RepositoryConfig<T>,
  traceContext?: any
) {
  // Extract configuration values with defaults
  const softDeleteEnabled = config.softDelete === true;
  const versionConfig = config.version;
  const versionEnabled = versionConfig !== undefined;
  const VERSION_KEY =
    versionConfig === true ? DEFAULT_VERSION_KEY : (versionConfig as string);

  const timestampConfig = config.timestampKeys;
  const traceTimestampConfig = config.traceTimestamps;
  const effectiveTraceTimestamps =
    traceTimestampConfig ?? (timestampConfig ? true : undefined);

  const traceEnabled = traceContext !== undefined;
  const traceKey = config.traceKey ?? DEFAULT_TRACE_KEY;
  const traceStrategy = config.traceStrategy ?? 'latest';
  const traceLimit = config.traceLimit;

  // Build readonly and managed field sets
  const READONLY_KEYS = new Set<string>(['id', '_id']);
  const HIDDEN_META_KEYS = new Set<string>();
  const configuredKeys: string[] = [];

  // Add timestamp keys to readonly
  if (effectiveTraceTimestamps) {
    const createdAtKey = timestampConfig?.createdAt ?? DEFAULT_CREATED_AT_KEY;
    const updatedAtKey = timestampConfig?.updatedAt ?? DEFAULT_UPDATED_AT_KEY;
    const deletedAtKey = timestampConfig?.deletedAt ?? DEFAULT_DELETED_AT_KEY;

    READONLY_KEYS.add(createdAtKey as string);
    READONLY_KEYS.add(updatedAtKey as string);
    READONLY_KEYS.add(deletedAtKey as string);
    configuredKeys.push(
      createdAtKey as string,
      updatedAtKey as string,
      deletedAtKey as string
    );

    // Add to hidden meta keys if using defaults
    if (!timestampConfig?.createdAt) {
      HIDDEN_META_KEYS.add(createdAtKey as string);
    }
    if (!timestampConfig?.updatedAt) {
      HIDDEN_META_KEYS.add(updatedAtKey as string);
    }
    if (!timestampConfig?.deletedAt) {
      HIDDEN_META_KEYS.add(deletedAtKey as string);
    }
  }

  // Add soft delete key to readonly
  if (softDeleteEnabled) {
    READONLY_KEYS.add(SOFT_DELETE_KEY);
    HIDDEN_META_KEYS.add(SOFT_DELETE_KEY);
    configuredKeys.push(SOFT_DELETE_KEY);
  }

  // Add version key to readonly
  if (versionEnabled) {
    READONLY_KEYS.add(VERSION_KEY);
    configuredKeys.push(VERSION_KEY);
    if (versionConfig === true) {
      HIDDEN_META_KEYS.add(VERSION_KEY);
    }
  }

  // Add trace key to readonly
  if (traceEnabled) {
    READONLY_KEYS.add(traceKey);
    configuredKeys.push(traceKey);
    if (traceKey === DEFAULT_TRACE_KEY) {
      HIDDEN_META_KEYS.add(traceKey);
    }
  }

  // Validation - ensure no duplicate keys
  const duplicates = configuredKeys.filter(
    (item, index) => configuredKeys.indexOf(item) !== index
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate keys found in repository configuration: ${duplicates.join(
        ', '
      )}. ` +
        'All keys for timestamps, versioning, and soft-delete must be unique to prevent undefined behavior.'
    );
  }

  return {
    // Configuration getters
    get softDeleteEnabled() {
      return softDeleteEnabled;
    },
    get versionEnabled() {
      return versionEnabled;
    },
    get traceEnabled() {
      return traceEnabled;
    },
    get timestampsEnabled() {
      return effectiveTraceTimestamps;
    },

    // Field management
    isReadOnlyField: (fieldName: string): boolean => {
      return READONLY_KEYS.has(fieldName);
    },

    isHiddenField: (fieldName: string): boolean => {
      return HIDDEN_META_KEYS.has(fieldName);
    },

    isManagedField: (fieldName: string): boolean => {
      return READONLY_KEYS.has(fieldName);
    },

    // Entity field filtering
    filterManagedFields: (entity: Partial<T>): Partial<T> => {
      const filtered: any = {};
      for (const [key, value] of Object.entries(entity)) {
        if (!READONLY_KEYS.has(key)) {
          filtered[key] = value;
        }
      }
      return filtered;
    },

    // Trace context building
    buildTraceContext: (op: WriteOp, mergeContext?: any): any => {
      if (!traceEnabled) return undefined;

      const context = mergeContext
        ? { ...traceContext, ...mergeContext }
        : traceContext;

      if (!context) return undefined;

      return {
        ...context,
        _op: op,
        _at: new Date(),
      };
    },

    // Trace strategy access
    getTraceStrategy: () => traceStrategy,
    getTraceLimit: () => traceLimit,
    getTraceKey: () => traceKey,

    // Update validation
    validateUpdateOperation: (update: UpdateOperation<any>): void => {
      const allFields = [
        ...Object.keys(update.set || {}),
        ...(update.unset || []),
      ];
      const readOnlyFields = allFields.filter((field) =>
        READONLY_KEYS.has(field)
      );

      if (readOnlyFields.length > 0) {
        throw new Error(
          `Cannot modify read-only fields: ${readOnlyFields.join(', ')}`
        );
      }
    },

    // Timestamp handling
    getTimestamp: (): Date | undefined => {
      if (!effectiveTraceTimestamps) return undefined;

      if (effectiveTraceTimestamps === true) {
        return new Date();
      } else if (typeof effectiveTraceTimestamps === 'function') {
        return effectiveTraceTimestamps();
      }

      return undefined;
    },

    shouldUseServerTimestamp: (): boolean => {
      return effectiveTraceTimestamps === 'server';
    },

    getTimestampKeys: () => {
      return {
        createdAt: timestampConfig?.createdAt ?? DEFAULT_CREATED_AT_KEY,
        updatedAt: timestampConfig?.updatedAt ?? DEFAULT_UPDATED_AT_KEY,
        deletedAt: timestampConfig?.deletedAt ?? DEFAULT_DELETED_AT_KEY,
      };
    },

    // Soft delete key access
    getSoftDeleteKey: () => SOFT_DELETE_KEY,

    // Version handling
    shouldIncrementVersion: (): boolean => {
      return versionEnabled;
    },

    getVersionKey: (): string => {
      return VERSION_KEY;
    },
  };
}
