import { PostgrestFilterBuilder } from '@supabase/postgrest-js'
declare module '@supabase/supabase-js' {
  interface SupabaseQueryBuilder<Schema, Table, Relationships> {
    update(values: Record<string, any>): PostgrestFilterBuilder<any, any, any, any>;
    insert(values: Record<string, any> | Record<string, any>[]): PostgrestFilterBuilder<any, any, any, any>;
  }
}
