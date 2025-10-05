import {
  DateKeys,
  NumberKeys,
  ObjectKeys,
  OptionalKeys,
  Prettify,
  StringKeys,
} from './types';

// projection type: { field1: true, field2: true }
export type Projection<T> = Partial<Record<keyof T, true>>;

// mapped type for projected result
export type Projected<T, P extends Projection<T> | undefined> = Prettify<
  P extends Projection<T>
    ? { [K in keyof P]: K extends keyof T ? T[K] : never }
    : T
>;

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
  // Identity configuration
  generateId?: 'server' | (() => string);
  idKey?: StringKeys<T>; // default 'id'
  mirrorId?: boolean; // default false

  // Consistency configuration
  softDelete?: boolean;
  traceTimestamps?: true | 'server' | (() => Date);
  timestampKeys?: TimestampConfig<T>;
  version?: true | NumberKeys<T>;

  // Tracing configuration
  traceKey?: ObjectKeys<T>;
  traceStrategy?: 'latest' | 'bounded' | 'unbounded';
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
  traceContext?: any,
  scope?: Partial<T>
) {
  // Identity
  const idKey = (config.idKey ?? ('id' as const)) as string;
  const mirrorId = config.mirrorId === true;
  const idStrategy = config.generateId ?? 'server';
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

  // Validate trace configuration
  if (
    traceEnabled &&
    (traceStrategy === 'bounded' || traceStrategy === 'unbounded')
  ) {
    if (traceStrategy === 'bounded' && !traceLimit) {
      throw new Error('traceLimit is required when traceStrategy is "bounded"');
    }
    // Note: 'unbounded' strategy doesn't require traceLimit (it's unlimited by design)
  }

  const scopeObj = scope ?? ({} as Partial<T>);
  const SCOPE_KEYS = new Set<string>(Object.keys(scopeObj));
  const READONLY_KEYS = new Set<string>([idKey, '_id']);
  const HIDDEN_META_KEYS = new Set<string>();
  const configuredKeys: string[] = [];

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

  if (softDeleteEnabled) {
    READONLY_KEYS.add(SOFT_DELETE_KEY);
    HIDDEN_META_KEYS.add(SOFT_DELETE_KEY);
    configuredKeys.push(SOFT_DELETE_KEY);
  }

  if (versionEnabled) {
    READONLY_KEYS.add(VERSION_KEY);
    configuredKeys.push(VERSION_KEY);
    if (versionConfig === true) {
      HIDDEN_META_KEYS.add(VERSION_KEY);
    }
  }

  if (traceEnabled) {
    READONLY_KEYS.add(traceKey);
    configuredKeys.push(traceKey);
    if (traceKey === DEFAULT_TRACE_KEY) {
      HIDDEN_META_KEYS.add(traceKey);
    }
  }

  // Validate scope doesn't use readonly fields
  const readOnlyFieldsInScope = Object.keys(scopeObj).filter((f) =>
    READONLY_KEYS.has(f)
  );
  if (readOnlyFieldsInScope.length > 0) {
    throw new Error(
      `Readonly fields found in scope: ${readOnlyFieldsInScope.join(', ')}`
    );
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
    get idKey() {
      return idKey;
    },
    get mirrorId() {
      return mirrorId;
    },
    get idStrategy() {
      return idStrategy;
    },
    get softDeleteEnabled() {
      return softDeleteEnabled;
    },
    get traceEnabled() {
      return traceEnabled;
    },
    get timestampsEnabled() {
      return effectiveTraceTimestamps;
    },

    isReadOnlyField: (fieldName: string): boolean => {
      return READONLY_KEYS.has(fieldName);
    },

    isHiddenField: (fieldName: string): boolean => {
      return HIDDEN_META_KEYS.has(fieldName);
    },

    buildTraceContext: (
      op: WriteOp,
      mergeContext?: any,
      serverTimestamp?: any
    ): any => {
      if (!traceEnabled) return undefined;

      const context = mergeContext
        ? { ...traceContext, ...mergeContext }
        : traceContext;

      if (!context) return undefined;

      // Use configured timestamp strategy or fallback to new Date()
      let timestamp: any;
      if (effectiveTraceTimestamps === 'server') {
        timestamp = serverTimestamp;
      } else if (typeof effectiveTraceTimestamps === 'function') {
        timestamp = effectiveTraceTimestamps();
      } else {
        timestamp = new Date(); // Default for true, falsy, or any other value
      }

      return {
        ...context,
        _op: op,
        ...(timestamp ? { _at: timestamp } : {}),
      };
    },

    getTraceStrategy: () => traceStrategy,
    getTraceLimit: () => traceLimit,
    getTraceKey: () => traceKey,

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

    getSoftDeleteKey: () => SOFT_DELETE_KEY,

    shouldIncrementVersion: (): boolean => {
      return versionEnabled;
    },

    getVersionKey: (): string => {
      return VERSION_KEY;
    },

    validateNoReadonly: (
      keys: string[],
      operation: WriteOp | 'unset'
    ): void => {
      const readonlyKeys = keys.filter((key) => READONLY_KEYS.has(key));

      // For update and unset operations, also check scope keys are not being modified
      const scopeKeys =
        operation === 'update' || operation === 'unset'
          ? keys.filter((key) => SCOPE_KEYS.has(key))
          : [];

      const conflictingKeys = [...readonlyKeys, ...scopeKeys];

      if (conflictingKeys.length > 0) {
        throw new Error(
          `Cannot ${operation} readonly properties: ${conflictingKeys.join(
            ', '
          )}`
        );
      }
    },

    // TODO - check if still needed
    validateScopeProperties: (
      entity: any,
      operation: WriteOp | 'unset'
    ): void => {
      for (const [key, expectedValue] of Object.entries(scopeObj)) {
        if (key in entity && entity[key] !== expectedValue) {
          throw new Error(
            `Cannot ${operation} entity: scope property '${key}' must be '${expectedValue}', got '${entity[key]}'`
          );
        }
      }
    },

    scopeBreach: (input: any): boolean => {
      const data = input ?? {};
      return Object.entries(scopeObj).some(
        ([k, v]) => data[k] !== undefined && v !== data[k]
      );
    },

    softDeleted: (input: any): boolean => {
      return softDeleteEnabled && (input ?? {})[SOFT_DELETE_KEY] === true;
    },
  };
}
