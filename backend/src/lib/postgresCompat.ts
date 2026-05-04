import { Pool, type QueryResult, type QueryResultRow } from "pg";

type QueryError = { message: string };
type QueryResponse<T = any> = {
  data: T | null;
  error: QueryError | null;
  count?: number | null;
};

type Filter =
  | { kind: "eq" | "neq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "is"; column: string; value: unknown }
  | { kind: "not"; column: string; operator: string; value: unknown }
  | { kind: "contains"; column: string; value: unknown };

type Order = {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
};

type SelectOptions = {
  count?: "exact" | null;
  head?: boolean;
};

type UpsertOptions = {
  onConflict?: string;
  ignoreDuplicates?: boolean;
};

const pools = new Map<string, Pool>();

export function getPostgresPool(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error("DATABASE_URL is required when using Postgres persistence.");
  }
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 10 });
    pools.set(url, pool);
  }
  return pool;
}

export function createPostgresCompat(connectionString?: string) {
  const pool = getPostgresPool(connectionString);
  return new PostgresCompatClient(pool);
}

function quoteIdent(identifier: string): string {
  const trimmed = identifier.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function quoteTable(table: string): string {
  return table
    .split(".")
    .map((part) => quoteIdent(part))
    .join(".");
}

function normalizeSelectColumns(columns: string | undefined): string[] {
  if (!columns || columns.trim() === "*") return ["*"];
  return columns
    .replace(/\s+/g, " ")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function selectSql(columns: string | undefined): string {
  const normalized = normalizeSelectColumns(columns);
  if (normalized.length === 1 && normalized[0] === "*") return "*";
  return normalized.map((column) => quoteIdent(column)).join(", ");
}

function normalizeRows(values: Record<string, unknown> | Record<string, unknown>[]) {
  return Array.isArray(values) ? values : [values];
}

function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of input) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function parseOrFilter(raw: string): Filter[] {
  return splitTopLevel(raw).flatMap<Filter>((part) => {
    const [column, operator, ...rest] = part.split(".");
    const value = rest.join(".");
    if (!column || !operator) return [];
    if (operator === "eq") return [{ kind: "eq", column, value }];
    if (operator === "neq") return [{ kind: "neq", column, value }];
    if (operator === "in") {
      const body = value.replace(/^\(/, "").replace(/\)$/, "");
      return [{ kind: "in", column, values: splitTopLevel(body) }];
    }
    if (operator === "is") {
      return [{ kind: "is", column, value: value === "null" ? null : value }];
    }
    return [];
  });
}

function valueForJsonbContains(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify([value]);
    }
  }
  return JSON.stringify(value);
}

class SqlBuilder {
  values: unknown[] = [];

  param(value: unknown) {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  condition(filter: Filter): string {
    if (filter.kind === "eq") {
      return `${quoteIdent(filter.column)} = ${this.param(filter.value)}`;
    }
    if (filter.kind === "neq") {
      return `${quoteIdent(filter.column)} <> ${this.param(filter.value)}`;
    }
    if (filter.kind === "in") {
      if (!filter.values.length) return "false";
      return `${quoteIdent(filter.column)} in (${filter.values
        .map((value) => this.param(value))
        .join(", ")})`;
    }
    if (filter.kind === "is") {
      return filter.value === null
        ? `${quoteIdent(filter.column)} is null`
        : `${quoteIdent(filter.column)} is ${String(filter.value)}`;
    }
    if (filter.kind === "not") {
      if (filter.operator === "is" && filter.value === null) {
        return `${quoteIdent(filter.column)} is not null`;
      }
      return `not (${quoteIdent(filter.column)} ${filter.operator} ${this.param(
        filter.value,
      )})`;
    }
    return `${quoteIdent(filter.column)} @> ${this.param(
      valueForJsonbContains(filter.value),
    )}::jsonb`;
  }
}

class PostgresQueryBuilder implements PromiseLike<QueryResponse> {
  private operation: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private selected = "*";
  private selectOptions: SelectOptions = {};
  private filters: Filter[] = [];
  private orFilters: Filter[][] = [];
  private orders: Order[] = [];
  private limitCount: number | null = null;
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private upsertOptions: UpsertOptions = {};
  private expect: "many" | "single" | "maybeSingle" = "many";
  private returning = false;

  constructor(
    private readonly pool: Pool,
    private readonly table: string,
  ) {}

  select(columns = "*", options: SelectOptions = {}) {
    this.selected = columns;
    this.selectOptions = options;
    this.returning = this.operation !== "select";
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.operation = "insert";
    this.payload = values;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.payload = values;
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options: UpsertOptions = {},
  ) {
    this.operation = "upsert";
    this.payload = values;
    this.upsertOptions = options;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ kind: "in", column, values });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.filters.push({ kind: "not", column, operator, value });
    return this;
  }

  contains(column: string, value: unknown) {
    this.filters.push({ kind: "contains", column, value });
    return this;
  }

  or(raw: string) {
    const parsed = parseOrFilter(raw);
    if (parsed.length) this.orFilters.push(parsed);
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this.orders.push({
      column,
      ascending: options.ascending !== false,
      nullsFirst: options.nullsFirst,
    });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.expect = "single";
    return this;
  }

  maybeSingle() {
    this.expect = "maybeSingle";
    return this;
  }

  then<TResult1 = QueryResponse, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ) {
    return this.execute().catch(onrejected);
  }

  private whereSql(builder: SqlBuilder) {
    const parts = this.filters.map((filter) => builder.condition(filter));
    for (const filters of this.orFilters) {
      parts.push(`(${filters.map((filter) => builder.condition(filter)).join(" or ")})`);
    }
    return parts.length ? ` where ${parts.join(" and ")}` : "";
  }

  private orderSql() {
    if (!this.orders.length) return "";
    return ` order by ${this.orders
      .map((order) => {
        const nulls =
          order.nullsFirst === undefined
            ? ""
            : order.nullsFirst
              ? " nulls first"
              : " nulls last";
        return `${quoteIdent(order.column)} ${
          order.ascending ? "asc" : "desc"
        }${nulls}`;
      })
      .join(", ")}`;
  }

  private limitSql(builder: SqlBuilder) {
    return this.limitCount === null ? "" : ` limit ${builder.param(this.limitCount)}`;
  }

  private async execute(): Promise<QueryResponse> {
    try {
      const builder = new SqlBuilder();
      let result: QueryResult;
      if (this.operation === "select") {
        result = await this.executeSelect(builder);
      } else if (this.operation === "insert") {
        result = await this.executeInsert(builder);
      } else if (this.operation === "update") {
        result = await this.executeUpdate(builder);
      } else if (this.operation === "delete") {
        result = await this.executeDelete(builder);
      } else {
        result = await this.executeUpsert(builder);
      }
      return this.formatResult(result);
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private async executeSelect(builder: SqlBuilder) {
    if (this.selectOptions.count === "exact" && this.selectOptions.head) {
      const sql = `select count(*)::int as count from ${quoteTable(
        this.table,
      )}${this.whereSql(builder)}`;
      return this.pool.query(sql, builder.values);
    }
    const sql = `select ${selectSql(this.selected)} from ${quoteTable(
      this.table,
    )}${this.whereSql(builder)}${this.orderSql()}${this.limitSql(builder)}`;
    return this.pool.query(sql, builder.values);
  }

  private async executeInsert(builder: SqlBuilder) {
    const rows = normalizeRows(this.payload as Record<string, unknown>[]);
    if (!rows.length) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    const columns = Object.keys(rows[0]);
    const valuesSql = rows
      .map(
        (row) =>
          `(${columns.map((column) => builder.param(row[column])).join(", ")})`,
      )
      .join(", ");
    const returning = this.returning ? ` returning ${selectSql(this.selected)}` : "";
    const sql = `insert into ${quoteTable(this.table)} (${columns
      .map(quoteIdent)
      .join(", ")}) values ${valuesSql}${returning}`;
    return this.pool.query(sql, builder.values);
  }

  private async executeUpdate(builder: SqlBuilder) {
    const values = (this.payload ?? {}) as Record<string, unknown>;
    const columns = Object.keys(values);
    const setSql = columns
      .map((column) => `${quoteIdent(column)} = ${builder.param(values[column])}`)
      .join(", ");
    const returning = this.returning ? ` returning ${selectSql(this.selected)}` : "";
    const sql = `update ${quoteTable(this.table)} set ${setSql}${this.whereSql(
      builder,
    )}${returning}`;
    return this.pool.query(sql, builder.values);
  }

  private async executeDelete(builder: SqlBuilder) {
    const returning = this.returning ? ` returning ${selectSql(this.selected)}` : "";
    const sql = `delete from ${quoteTable(this.table)}${this.whereSql(
      builder,
    )}${returning}`;
    return this.pool.query(sql, builder.values);
  }

  private async executeUpsert(builder: SqlBuilder) {
    const rows = normalizeRows(this.payload as Record<string, unknown>[]);
    if (!rows.length) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    const columns = Object.keys(rows[0]);
    const conflictColumns = (this.upsertOptions.onConflict ?? "id")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    const valuesSql = rows
      .map(
        (row) =>
          `(${columns.map((column) => builder.param(row[column])).join(", ")})`,
      )
      .join(", ");
    const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
    const conflictAction =
      this.upsertOptions.ignoreDuplicates || !updateColumns.length
        ? "do nothing"
        : `do update set ${updateColumns
            .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
            .join(", ")}`;
    const returning = this.returning ? ` returning ${selectSql(this.selected)}` : "";
    const sql = `insert into ${quoteTable(this.table)} (${columns
      .map(quoteIdent)
      .join(", ")}) values ${valuesSql} on conflict (${conflictColumns
      .map(quoteIdent)
      .join(", ")}) ${conflictAction}${returning}`;
    return this.pool.query(sql, builder.values);
  }

  private formatResult(result: QueryResult): QueryResponse {
    if (this.selectOptions.count === "exact" && this.selectOptions.head) {
      return { data: null, error: null, count: result.rows[0]?.count ?? 0 };
    }
    if (!this.returning && this.operation !== "select") {
      return { data: null, error: null, count: result.rowCount };
    }
    if (this.expect === "single") {
      const row = result.rows[0] ?? null;
      return row
        ? { data: row, error: null }
        : { data: null, error: { message: "Row not found" } };
    }
    if (this.expect === "maybeSingle") {
      return { data: result.rows[0] ?? null, error: null };
    }
    return { data: result.rows, error: null, count: result.rowCount };
  }
}

class PostgresCompatAuthAdmin {
  constructor(private readonly pool: Pool) {}

  async listUsers(_options?: unknown): Promise<QueryResponse<{ users: any[] }>> {
    try {
      const { rows } = await this.pool.query(
        `select id, email, name, "emailVerified", image, "createdAt", "updatedAt" from "user" order by "createdAt" desc`,
      );
      return { data: { users: rows }, error: null };
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async listUsersByEmails(emails: string[]): Promise<QueryResponse<{ users: any[] }>> {
    const normalized = [
      ...new Set(
        emails
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (!normalized.length) return { data: { users: [] }, error: null };
    try {
      const { rows } = await this.pool.query(
        `select id, email, name, "emailVerified", image, "createdAt", "updatedAt"
         from "user"
         where lower(email) = any($1::text[])
         order by "createdAt" desc`,
        [normalized],
      );
      return { data: { users: rows }, error: null };
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async listUsersByIds(ids: string[]): Promise<QueryResponse<{ users: any[] }>> {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) return { data: { users: [] }, error: null };
    try {
      const { rows } = await this.pool.query(
        `select id, email, name, "emailVerified", image, "createdAt", "updatedAt"
         from "user"
         where id = any($1::text[])
         order by "createdAt" desc`,
        [unique],
      );
      return { data: { users: rows }, error: null };
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async deleteUser(userId: string): Promise<QueryResponse<null>> {
    try {
      await this.pool.query(`delete from "user" where id = $1`, [userId]);
      return { data: null, error: null };
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}

export class PostgresCompatClient {
  auth: { admin: PostgresCompatAuthAdmin };

  constructor(private readonly pool: Pool) {
    this.auth = { admin: new PostgresCompatAuthAdmin(pool) };
  }

  from(table: string) {
    return new PostgresQueryBuilder(this.pool, table);
  }

  query<T extends QueryResultRow = any>(sql: string, values?: unknown[]) {
    return this.pool.query<T>(sql, values);
  }
}
