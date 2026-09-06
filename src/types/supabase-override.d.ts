import { PostgrestFilterBuilder } from '@supabase/postgrest-js'

declare module '@supabase/supabase-js' {
  interface SupabaseQueryBuilder<Schema, Table, Relationships> {
    update(values: Record<string, any>): PostgrestFilterBuilder<any, any, any, any>;
    insert(values: Record<string, any> | Record<string, any>[]): PostgrestFilterBuilder<any, any, any, any>;
  }
}

declare module '@supabase/postgrest-js' {
  interface PostgrestQueryBuilder<ClientOptions, Schema, Relation, RelationName = unknown, Relationships = unknown> {
    update(values: Record<string, any>, options?: { count?: 'exact' | 'planned' | 'estimated' }): PostgrestFilterBuilder<any, any, any, any>;
    insert(values: Record<string, any>, options?: { count?: 'exact' | 'planned' | 'estimated' }): PostgrestFilterBuilder<any, any, any, any>;
    insert(values: Record<string, any>[], options?: { count?: 'exact' | 'planned' | 'estimated'; defaultToNull?: boolean }): PostgrestFilterBuilder<any, any, any, any>;
  }
}
