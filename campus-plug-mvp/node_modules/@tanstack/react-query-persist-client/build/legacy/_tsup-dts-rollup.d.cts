import { AsyncStorage } from '@tanstack/query-persist-client-core';
import { experimental_createQueryPersister } from '@tanstack/query-persist-client-core';
import { MaybePromise } from '@tanstack/query-persist-client-core';
import type { OmitKeyof } from '@tanstack/react-query';
import { PersistedClient } from '@tanstack/query-persist-client-core';
import { PersistedQuery } from '@tanstack/query-persist-client-core';
import { PersistedQueryClientRestoreOptions } from '@tanstack/query-persist-client-core';
import { PersistedQueryClientSaveOptions } from '@tanstack/query-persist-client-core';
import { Persister } from '@tanstack/query-persist-client-core';
import { PERSISTER_KEY_PREFIX } from '@tanstack/query-persist-client-core';
import { persistQueryClient } from '@tanstack/query-persist-client-core';
import { PersistQueryClientOptions } from '@tanstack/query-persist-client-core';
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core';
import { PersistQueryClientRootOptions } from '@tanstack/query-persist-client-core';
import { persistQueryClientSave } from '@tanstack/query-persist-client-core';
import { persistQueryClientSubscribe } from '@tanstack/query-persist-client-core';
import { PersistRetryer } from '@tanstack/query-persist-client-core';
import { Promisable } from '@tanstack/query-persist-client-core';
import type { QueryClientProviderProps } from '@tanstack/react-query';
import * as React_2 from 'react';
import { removeOldestQuery } from '@tanstack/query-persist-client-core';
import { StoragePersisterOptions } from '@tanstack/query-persist-client-core';

export { AsyncStorage }

export { experimental_createQueryPersister }

export { MaybePromise }

export { PersistedClient }

export { PersistedQuery }

export { PersistedQueryClientRestoreOptions }

export { PersistedQueryClientSaveOptions }

export { Persister }

export { PERSISTER_KEY_PREFIX }

export { persistQueryClient }

export { PersistQueryClientOptions }

declare const PersistQueryClientProvider: ({ children, persistOptions, onSuccess, onError, ...props }: PersistQueryClientProviderProps) => React_2.JSX.Element;
export { PersistQueryClientProvider }
export { PersistQueryClientProvider as PersistQueryClientProvider_alias_1 }

declare type PersistQueryClientProviderProps = QueryClientProviderProps & {
    persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>;
    onSuccess?: () => Promise<unknown> | unknown;
    onError?: () => Promise<unknown> | unknown;
};
export { PersistQueryClientProviderProps }
export { PersistQueryClientProviderProps as PersistQueryClientProviderProps_alias_1 }

export { persistQueryClientRestore }

export { PersistQueryClientRootOptions }

export { persistQueryClientSave }

export { persistQueryClientSubscribe }

export { PersistRetryer }

export { Promisable }

export { removeOldestQuery }

export { StoragePersisterOptions }

export { }
