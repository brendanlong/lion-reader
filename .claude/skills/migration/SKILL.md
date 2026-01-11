---
name: migration
description: Write database migrations. Use when creating schema changes, adding tables, columns, indexes, or modifying database structure.
---

# Database Migrations

## Before Writing a Migration

**Always read the current schema first:**

```bash
cat drizzle/schema.sql
```

This file contains a `pg_dump` of the current database schema. Review it to understand existing tables, columns, constraints, and indexes before making changes.

## Writing Migrations

Migrations are written as raw SQL files in the `drizzle/` folder. We do NOT use `drizzle-kit generate`.

### File Naming

Use an incrementing numeric prefix followed by a descriptive name:

```
0035_add_user_preferences.sql
```

Check existing migrations to find the next available number:

```bash
ls drizzle/*.sql | tail -5
```

### SQL Format

Separate statements with `--> statement-breakpoint`:

```sql
-- Description of what this migration does

CREATE TABLE example (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX idx_example_user ON example(user_id);
```

### PostgreSQL Conventions

- **IDs**: Use `uuid` with UUIDv7 (time-ordered)
- **Timestamps**: Always use `timestamptz`, never `timestamp`
- **Foreign keys**: Include `ON DELETE CASCADE` for user-owned data
- **Case-insensitive text**: Use `citext` extension when needed

## Registering Migrations

**Migrations won't run unless registered in the journal.**

Edit `drizzle/meta/_journal.json` and add an entry:

```json
{
  "idx": 35,
  "version": "7",
  "when": 1767500000000,
  "tag": "0035_add_user_preferences",
  "breakpoints": true
}
```

- `idx`: Next sequential index
- `when`: Unix timestamp in milliseconds (use current time)
- `tag`: Filename without `.sql` extension
- `breakpoints`: Always `true`

## Enum Changes

**Enum additions MUST be in their own migration file.**

PostgreSQL doesn't allow using new enum values in the same transaction they were added. If you need to add an enum value and use it:

1. Migration 1: Add the enum value
2. Migration 2: Use the new enum value

## Running Migrations

```bash
# Run migrations on development database
pnpm db:migrate

# Run migrations on test database
pnpm db:migrate:test
```

## Updating the Schema Dump

After migrations are applied, regenerate the schema dump:

```bash
pnpm db:schema
```

This updates `drizzle/schema.sql` with the current database state.
