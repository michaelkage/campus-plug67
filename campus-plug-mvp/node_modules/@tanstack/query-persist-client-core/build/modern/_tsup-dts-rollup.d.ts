import type { DehydratedState } from '@tanstack/query-core';
import type { DehydrateOptions } from '@tanstack/query-core';
import type { HydrateOptions } from '@tanstack/query-core';
import type { Query } from '@tanstack/query-core';
import type { QueryClient } from '@tanstack/query-core';
import type { QueryFilters } from '@tanstack/query-core';
import type { QueryFunctionContext } from '@tanstack/query-core';
import type { QueryKey } from '@tanstack/query-core';
import type { QueryState } from '@tanstack/query-core';

declare interface AsyncStorage<TStorageValue = string> {
    getItem: (key: string) => MaybePromise<TStorageValue | undefined | null>;
    setItem: (key: string, value: TStorageValue) => MaybePromise<unknown>;
    removeItem: (key: string) => MaybePromise<void>;
    entries?: () => MaybePromise<Array<[key: string, value: TStorageValue]>>;
}
export { AsyncStorage }
export { AsyncStorage as AsyncStorage_alias_1 }

/**
 * Warning: experimental feature.
 * This utility function enables fine-grained query persistence.
 * Simple add it as a `persister` parameter to `useQuery` or `defaultOptions` on `queryClient`.
 *
 * ```
 * useQuery({
 queryKey: ['myKey'],
 queryFn: fetcher,
 persister: createPersister({
 storage: localStorage,
 }),
 })
 ```
 */
declare function experimental_createQueryPersister<TStorageValue = string>({ storage, buster, maxAge, serialize, deserialize, prefix, refetchOnRestore, filters, }: StoragePersisterOptions<TStorageValue>): {
    persisterFn: <T, TQueryKey extends QueryKey>(queryFn: (context: QueryFunctionContext<TQueryKey>) => T | Promise<T>, ctx: QueryFunctionContext<TQueryKey>, query: Query) => Promise<T>;
    persistQuery: (query: Query) => Promise<void>;
    persistQueryByKey: (queryKey: QueryKey, queryClient: QueryClient) => Promise<void>;
    retrieveQuery: <T>(queryHash: string, afterRestoreMacroTask?: (persistedQuery: PersistedQuery) => void) => Promise<T | undefined>;
    persisterGc: () => Promise<void>;
    restoreQueries: (queryClient: QueryClient, filters?: Pick<QueryFilters, "queryKey" | "exact">) => Promise<void>;
    removeQueries: (filters?: Pick<QueryFilters, "queryKey" | "exact">) => Promise<void>;
};
export { experimental_createQueryPersister }
export { experimental_createQueryPersister as experimental_createQueryPersister_alias_1 }

declare type MaybePromise<T> = T | Promise<T>;
export { MaybePromise }
export { MaybePromise as MaybePromise_alias_1 }

declare interface PersistedClient {
    timestamp: number;
    buster: string;
    clientState: DehydratedState;
}
export { PersistedClient }
export { PersistedClient as PersistedClient_alias_1 }

declare interface PersistedQuery {
    buster: string;
    queryHash: string;
    queryKey: QueryKey;
    state: QueryState;
}
export { PersistedQuery }
export { PersistedQuery as PersistedQuery_alias_1 }

declare interface PersistedQueryClientRestoreOptions extends PersistQueryClientRootOptions {
    /** The max-allowed age of the cache in milliseconds.
     * If a persisted cache is found that is older than this
     * time, it will be discarded */
    maxAge?: number;
    /** The options passed to the hydrate function */
    hydrateOptions?: HydrateOptions;
}
export { PersistedQueryClientRestoreOptions }
export { PersistedQueryClientRestoreOptions as PersistedQueryClientRestoreOptions_alias_1 }

declare interface PersistedQueryClientSaveOptions extends PersistQueryClientRootOptions {
    /** The options passed to the dehydrate function */
    dehydrateOptions?: DehydrateOptions;
}
export { PersistedQueryClientSaveOptions }
export { PersistedQueryClientSaveOptions as PersistedQueryClientSaveOptions_alias_1 }

declare interface Persister {
    persistClient: (persistClient: PersistedClient) => Promisable<void>;
    restoreClient: () => Promisable<PersistedClient | undefined>;
    removeClient: () => Promisable<void>;
}
export { Persister }
export { Persister as Persister_alias_1 }

declare const PERSISTER_KEY_PREFIX = "tanstack-query";
export { PERSISTER_KEY_PREFIX }
export { PERSISTER_KEY_PREFIX as PERSISTER_KEY_PREFIX_alias_1 }

/**
 * Restores persisted data to QueryCache and persists further changes.
 */
declare function persistQueryClient(props: PersistQueryClientOptions): [() => void, Promise<void>];
export { persistQueryClient }
export { persistQueryClient as persistQueryClient_alias_1 }

declare interface PersistQueryClientOptions extends PersistedQueryClientRestoreOptions, PersistedQueryClientSaveOptions, PersistQueryClientRootOptions {
}
export { PersistQueryClientOptions }
export { PersistQueryClientOptions as PersistQueryClientOptions_alias_1 }

/**
 * Restores persisted data to the QueryCache
 *  - data obtained from persister.restoreClient
 *  - data is hydrated using hydrateOptions
 * If data is expired, busted, empty, or throws, it runs persister.removeClient
 */
declare function persistQueryClientRestore({ queryClient, persister, maxAge, buster, hydrateOptions, }: PersistedQueryClientRestoreOptions): Promise<void>;
export { persistQueryClientRestore }
export { persistQueryClientRestore as persistQueryClientRestore_alias_1 }

declare interface PersistQueryClientRootOptions {
    /** The QueryClient to persist */
    queryClient: QueryClient;
    /** The Persister interface for storing and restoring the cache
     * to/from a persisted location */
    persister: Persister;
    /** A unique string that can be used to forcefully
     * invalidate existing caches if they do not share the same buster string */
    buster?: string;
}
export { PersistQueryClientRootOptions }
export { PersistQueryClientRootOptions as PersistQueryClientRootOptions_alias_1 }

/**
 * Persists data from the QueryCache
 *  - data dehydrated using dehydrateOptions
 *  - data is persisted using persister.persistClient
 */
declare function persistQueryClientSave({ queryClient, persister, buster, dehydrateOptions, }: PersistedQueryClientSaveOptions): Promise<void>;
export { persistQueryClientSave }
export { persistQueryClientSave as persistQueryClientSave_alias_1 }

/**
 * Subscribe to QueryCache and MutationCache updates (for persisting)
 * @returns an unsubscribe function (to discontinue monitoring)
 */
declare function persistQueryClientSubscribe(props: PersistedQueryClientSaveOptions): () => void;
export { persistQueryClientSubscribe }
export { persistQueryClientSubscribe as persistQueryClientSubscribe_alias_1 }

declare type PersistRetryer = (props: {
    persistedClient: PersistedClient;
    error: Error;
    errorCount: number;
}) => PersistedClient | undefined;
export { PersistRetryer }
export { PersistRetryer as PersistRetryer_alias_1 }

declare type Promisable<T> = T | PromiseLike<T>;
export { Promisable }
export { Promisable as Promisable_alias_1 }

declare const removeOldestQuery: PersistRetryer;
export { removeOldestQuery }
export { removeOldestQuery as removeOldestQuery_alias_1 }

declare interface StoragePersisterOptions<TStorageValue = string> {
    /** The storage client used for setting and retrieving items from cache.
     * For SSR pass in `undefined`.
     */
    storage: AsyncStorage<TStorageValue> | undefined | null;
    /**
     * How to serialize the data to storage.
     * @default `JSON.stringify`
     */
    serialize?: (persistedQuery: PersistedQuery) => MaybePromise<TStorageValue>;
    /**
     * How to deserialize the data from storage.
     * @default `JSON.parse`
     */
    deserialize?: (cachedString: TStorageValue) => MaybePromise<PersistedQuery>;
    /**
     * A unique string that can be used to forcefully invalidate existing caches,
     * if they do not share the same buster string
     */
    buster?: string;
    /**
     * The max-allowed age of the cache in milliseconds.
     * If a persisted cache is found that is older than this
     * time, it will be discarded
     * @default 24 hours
     */
    maxAge?: number;
    /**
     * Prefix to be used for storage key.
     * Storage key is a combination of prefix and query hash in a form of `prefix-queryHash`.
     * @default 'tanstack-query'
     */
    prefix?: string;
    /**
     * If set to `true`, the query will refetch on successful query restoration if the data is stale.
     * If set to `false`, the query will not refetch on successful query restoration.
     * If set to `'always'`, the query will always refetch on successful query restoration.
     * Defaults to `true`.
     */
    refetchOnRestore?: boolean | 'always';
    /**
     * Filters to narrow down which Queries should be persisted.
     */
    filters?: QueryFilters;
}
export { StoragePersisterOptions }
export { StoragePersisterOptions as StoragePersisterOptions_alias_1 }

export { }
