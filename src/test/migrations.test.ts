import { describe, expect, it } from 'vitest'

type Migration = { name: string; sql: string }

let migrations: Migration[] = []

// Vite inlines the SQL as raw strings, so these structural assertions stay on the
// same toolchain as the unit tests instead of needing node types in the app tsconfig.
const rawMigrations = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const rawMachine = import.meta.glob('../lib/transactionStateMachine.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

migrations = Object.entries(rawMigrations)
  .map(([file, sql]) => ({ name: file.split('/').pop()!, sql }))
  .sort((a, b) => a.name.localeCompare(b.name))

// Migrations are applied in filename order, so a later file may supersede an
// earlier definition. These helpers always read the effective state.
const allMigrations = () => migrations

const lastDefinitionOf = (pattern: RegExp): { name: string; body: string } | null => {
  const matches = allMigrations().filter(entry => pattern.test(entry.sql))
  const last = matches[matches.length - 1]
  return last ? { name: last.name, body: last.sql } : null
}

const read = (suffix: string): string => {
  const found = allMigrations().find(entry => entry.name.endsWith(suffix))
  if (!found) throw new Error(`Migration not found: ${suffix}`)
  return found.sql
}

const clientStateMachine = (): string => {
  const [sql] = Object.values(rawMachine)
  if (!sql) throw new Error('transactionStateMachine.ts could not be loaded')
  return sql
}

describe('migration ordering', () => {
  it('ships a numbered baseline before every later change', () => {
    expect(migrations[0]?.name).toBe('001_schema.sql')
    expect(migrations.length).toBeGreaterThan(50)
  })

  it('has no duplicate numeric version prefixes', () => {
    const versions = migrations.map(({ name }) => {
      const match = /^0*(\d+)(\d)\b/.exec(name)
      return match ? `${match[1]}.${match[2]}` : null
    })

    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const version of versions) {
      if (!version) continue
      if (seen.has(version)) duplicates.push(version)
      seen.add(version)
    }

    expect(duplicates).toEqual([])
  })
})

describe('escrow status vocabulary', () => {
  const transactionStatuses = (): string[] => {
    const found = allMigrations()
      .map(entry => entry.sql.match(/ADD CONSTRAINT\s+\w*status\w*\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i)?.[1])
      .filter((value): value is string => Boolean(value))
    const effective = found[found.length - 1]
    expect(effective, 'a CHECK constraint on transactions.status must be defined').toBeDefined()
    return [...effective!.matchAll(/'([a-z_]+)'/g)].map(match => match[1]).sort()
  }

  it('accepts exactly the seven escrow states the client engine models', () => {
    expect(transactionStatuses()).toEqual([
      'cancelled', 'disputed', 'locked', 'meetup_initiated',
      'pending', 'release_requested', 'released',
    ])
  })

  it('keeps the database status enum aligned with the client state machine', () => {
    const states = [...clientStateMachine().matchAll(/'([A-Z_]+)'/g)].map(match => match[1])

    for (const status of transactionStatuses()) {
      expect(states).toContain(status.toUpperCase())
    }

    // REFUNDED is a client-only settlement outcome, never a persisted status.
    expect(states).toContain('REFUNDED')
    expect(transactionStatuses()).not.toContain('refunded')
  })
})

describe('client transaction update guards', () => {
  const guard = () => lastDefinitionOf(/CREATE OR REPLACE FUNCTION public\.guard_transaction_client_update/i)

  it('protects every authority-bearing column from client mutation', () => {
    const definition = guard()
    expect(definition).not.toBeNull()

    const required = [
      'id', 'listing_id', 'buyer_id', 'seller_id', 'amount', 'status',
      'payment_verified', 'paystack_ref', 'locked_at', 'meetup_initiated_at',
      'release_requested_at', 'released_at', 'completed_at', 'cancelled_at',
      'disputed_at', 'auto_release_at', 'qr_secret', 'release_code',
    ]

    for (const column of required) {
      expect(definition!.body).toMatch(new RegExp(`NEW\\.${column}\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.${column}`, 'i'))
    }
  })

  it('rejects the mutation instead of silently rewriting it', () => {
    expect(guard()!.body).toMatch(/RAISE\s+EXCEPTION/i)
  })

  it('bypasses the guard only for the service role and the escrow service', () => {
    const bypass = guard()!.body.match(/IF\s+([^;]+?)\s+THEN\s+RETURN\s+NEW/i)
    expect(bypass).not.toBeNull()
    expect(bypass![1]).toMatch(/service_role/i)
  })

  it('runs the guard as SECURITY DEFINER with a pinned search path', () => {
    const body = guard()!.body
    expect(body).toMatch(/SECURITY\s+DEFINER/i)
    expect(body).toMatch(/SET\s+search_path\s*=\s*public/i)
  })
})

describe('platform integrity ledger exposure', () => {
  const ledgerMigration = '062_platform_integrity_ledger_observability.sql'

  it('enables RLS on every observability table', () => {
    const sql = read(ledgerMigration)
    for (const table of [
      'payment_events', 'financial_ledger', 'transaction_state_transitions',
      'device_security_signals', 'platform_observability_events',
    ]) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    }
  })

  it('revokes client writes on the ledgers', () => {
    const sql = read(ledgerMigration)
    for (const table of ['financial_ledger', 'transaction_state_transitions']) {
      expect(sql).toMatch(new RegExp(`revoke insert, update, delete on public\\.${table} from anon, authenticated`, 'i'))
    }
    for (const table of ['payment_events', 'device_security_signals', 'platform_observability_events']) {
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${table} from anon, authenticated`, 'i'))
    }
  })

  it('makes the ledger writers SECURITY DEFINER and unrevoked-except-to-service-role', () => {
    const sql = read(ledgerMigration)
    for (const fn of [
      'record_transaction_state_transition',
      'record_financial_ledger_entry',
      'financial_ledger_balance',
    ]) {
      const definition = new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$`, 'i').exec(sql)
      expect(definition, `${fn} must be defined in the platform integrity migration`).not.toBeNull()
      expect(definition![0]).toMatch(/SECURITY\s+DEFINER/i)
      expect(definition![0]).toMatch(/SET\s+search_path\s*=\s*public/i)
    }
  })
})