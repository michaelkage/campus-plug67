import type { PersistedClient } from '@tanstack/query-persist-client-core';
import type { Persister } from '@tanstack/query-persist-client-core';
import type { PersistRetryer } from '@tanstack/query-persist-client-core';

/**
 * @deprecated use `createAsyncStoragePersister` from `@tanstack/query-async-storage-persister` instead.
 */
export declare function createSyncStoragePersister({ storage, key, throttleTime, serialize, deserialize, retry, }: CreateSyncStoragePersisterOptions): Persister;

declare interface CreateSyncStoragePersisterOptions {
    /** The storage client used for setting and retrieving items from cache.
     * For SSR pass in `undefined`. Note that window.localStorage can be
     * `null` in Android WebViews depending on how they are configured.
     */
    storage: Storage_2 | undefined | null;
    /** The key to use when storing the cache */
    key?: string;
    /** To avoid spamming,
     * pass a time in ms to throttle saving the cache to disk */
    throttleTime?: number;
    /**
     * How to serialize the data to storage.
     * @default `JSON.stringify`
     */
    serialize?: (client: PersistedClient) => string;
    /**
     * How to deserialize the data from storage.
     * @default `JSON.parse`
     */
    deserialize?: (cachedString: string) => PersistedClient;
    retry?: PersistRetryer;
}

export declare function noop(): void;

export declare function noop(): undefined;

declare interface Storage_2 {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
}

export { }
