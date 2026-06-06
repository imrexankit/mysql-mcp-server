#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { z } from "zod";

// ─── Config & Connection Pool ────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function createPool(): mysql.Pool {
  const caPath = requireEnv("MYSQL_CA_CERT_PATH");
  let caCert: Buffer;
  try {
    caCert = readFileSync(caPath);
  } catch (err) {
    throw new Error(`Cannot read CA certificate at "${caPath}": ${err}`);
  }

  return mysql.createPool({
    host: requireEnv("MYSQL_HOST"),
    port: parseInt(process.env["MYSQL_PORT"] ?? "3306", 10),
    user: requireEnv("MYSQL_USER"),
    password: requireEnv("MYSQL_PASSWORD"),
    database: requireEnv("MYSQL_DATABASE"),
    ssl: {
      ca: caCert,
      rejectUnauthorized: true,
    },
    connectionLimit: 10,
    connectTimeout: 10_000,
  });
}

const pool = createPool();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Validates that a SQL string is strictly a DQL statement. */
function assertDQL(sql: string): void {
  const trimmed = sql.trim().toUpperCase();
  const allowed = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"];
  if (!allowed.some((kw) => trimmed.startsWith(kw))) {
    throw new Error(
      `Only read-only DQL statements are permitted (SELECT, SHOW, DESCRIBE, EXPLAIN). Received: "${sql.trim().substring(0, 60)}"`
    );
  }
  const forbidden = [
    /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bDROP\b/i,
    /\bTRUNCATE\b/i, /\bALTER\b/i, /\bCREATE\b/i, /\bREPLACE\b/i,
    /\bCALL\b/i, /\bEXEC\b/i, /\bGRANT\b/i, /\bREVOKE\b/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sql)) {
      throw new Error(`Forbidden keyword detected. Only DQL is allowed.`);
    }
  }
}

async function runQuery(sql: string, params: mysql.ExecuteValues = []): Promise<mysql.RowDataPacket[]> {
  assertDQL(sql);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

function formatRows(rows: mysql.RowDataPacket[]): string {
  if (rows.length === 0) return "(no rows returned)";
  return JSON.stringify(rows, null, 2);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ─── Server Factory (creates a new instance per connection) ──────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "mysql-mcp-server", version: "1.0.0" });

  // ── Tool 1: Execute a raw DQL query ────────────────────────────────────────
  server.registerTool(
    "mysql_execute_query",
    {
      title: "Execute SQL Query",
      description: `Run any read-only DQL SQL statement (SELECT, SHOW, DESCRIBE, EXPLAIN) against the MySQL database.
Allowed: SELECT, SHOW, DESCRIBE/DESC, EXPLAIN, CTEs (WITH ... SELECT).
Write operations are blocked.

Args:
  - sql (string): The SQL statement to execute
  - limit (number): Max rows to return (default 100, max 1000)

Returns: JSON array of result rows.`,
      inputSchema: z.object({
        sql: z.string().min(1).describe("SQL DQL statement to execute"),
        limit: z.number().int().min(1).max(1000).default(100).describe("Max rows to return"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, limit }) => {
      try {
        let safeSql = sql.trim();
        if (/^SELECT/i.test(safeSql) && !/\bLIMIT\b/i.test(safeSql)) {
          safeSql = `${safeSql} LIMIT ${limit}`;
        }
        const rows = await runQuery(safeSql);
        const truncated = rows.slice(0, limit);
        const note = rows.length > limit ? `\n\n⚠️ Results truncated to ${limit} rows.` : "";
        return textResult(formatRows(truncated) + note);
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 2: List all tables ────────────────────────────────────────────────
  server.registerTool(
    "mysql_list_tables",
    {
      title: "List Tables",
      description: `List all tables in the connected MySQL database with metadata (type, row count, created time).

Args:
  - database (string, optional): Database name. Defaults to the connected database.

Returns: Array of table metadata objects.`,
      inputSchema: z.object({
        database: z.string().optional().describe("Database name (defaults to connected DB)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ database }) => {
      try {
        const db = database ?? requireEnv("MYSQL_DATABASE");
        const rows = await runQuery(
          `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, CREATE_TIME
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ?
           ORDER BY TABLE_NAME`,
          [db]
        );
        return textResult(formatRows(rows));
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 3: Describe a table ───────────────────────────────────────────────
  server.registerTool(
    "mysql_describe_table",
    {
      title: "Describe Table",
      description: `Show column definitions (name, type, nullability, key, default, extra, comment) for a table.

Args:
  - table (string): Table name
  - database (string, optional): Database name. Defaults to connected database.

Returns: Column definitions.`,
      inputSchema: z.object({
        table: z.string().min(1).describe("Table name to describe"),
        database: z.string().optional().describe("Database name (defaults to connected DB)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table, database }) => {
      try {
        const db = database ?? requireEnv("MYSQL_DATABASE");
        const rows = await runQuery(
          `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
                  COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [db, table]
        );
        if (rows.length === 0) return textResult(`Table "${table}" not found in database "${db}".`);
        return textResult(formatRows(rows));
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 4: Show indexes ──────────────────────────────────────────────────
  server.registerTool(
    "mysql_show_indexes",
    {
      title: "Show Table Indexes",
      description: `List all indexes on a table (primary key, unique, foreign keys, composite indexes).

Args:
  - table (string): Table name
  - database (string, optional): Database name. Defaults to connected database.

Returns: Index definitions with key names, columns, and uniqueness flags.`,
      inputSchema: z.object({
        table: z.string().min(1).describe("Table name"),
        database: z.string().optional().describe("Database name (defaults to connected DB)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table, database }) => {
      try {
        const db = database ?? requireEnv("MYSQL_DATABASE");
        const rows = await runQuery(`SHOW INDEX FROM \`${db}\`.\`${table}\``);
        return textResult(formatRows(rows));
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 5: Show CREATE TABLE DDL ──────────────────────────────────────────
  server.registerTool(
    "mysql_show_create_table",
    {
      title: "Show CREATE TABLE Statement",
      description: `Return the full DDL (CREATE TABLE) for a table — useful for understanding schema, constraints, indexes, and engine settings.

Args:
  - table (string): Table name
  - database (string, optional): Database name. Defaults to connected database.

Returns: The full CREATE TABLE SQL statement.`,
      inputSchema: z.object({
        table: z.string().min(1).describe("Table name"),
        database: z.string().optional().describe("Database name (defaults to connected DB)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table, database }) => {
      try {
        const db = database ?? requireEnv("MYSQL_DATABASE");
        const rows = await runQuery(`SHOW CREATE TABLE \`${db}\`.\`${table}\``);
        if (rows.length === 0) return textResult("Table not found.");
        const row = rows[0] as Record<string, unknown>;
        const ddl = row["Create Table"] ?? row["Create View"] ?? JSON.stringify(row);
        return textResult(String(ddl));
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 6: List databases ─────────────────────────────────────────────────
  server.registerTool(
    "mysql_list_databases",
    {
      title: "List Databases",
      description: `List all databases (schemas) accessible to the current MySQL user.

Returns: Array of database names.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const rows = await runQuery("SHOW DATABASES");
        return textResult(formatRows(rows));
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Tool 7: Table statistics ───────────────────────────────────────────────
  server.registerTool(
    "mysql_get_table_stats",
    {
      title: "Get Table Statistics",
      description: `Retrieve row count estimates, storage size, engine, and collation for a table from information_schema.

Args:
  - table (string): Table name
  - database (string, optional): Database name. Defaults to connected database.

Returns: Row count, data size (MB), index size (MB), engine, collation, and timestamps.`,
      inputSchema: z.object({
        table: z.string().min(1).describe("Table name"),
        database: z.string().optional().describe("Database name (defaults to connected DB)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table, database }) => {
      try {
        const db = database ?? requireEnv("MYSQL_DATABASE");
        const rows = await runQuery(
          `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, AVG_ROW_LENGTH,
                  ROUND(DATA_LENGTH / 1024 / 1024, 2) AS data_size_mb,
                  ROUND(INDEX_LENGTH / 1024 / 1024, 2) AS index_size_mb,
                  TABLE_COLLATION, CREATE_TIME, UPDATE_TIME
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
          [db, table]
        );
        if (rows.length === 0) return textResult(`Table "${table}" not found in database "${db}".`);
        return textResult(formatRows(rows));
      } catch (err) {
        return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  return server;
}

// ─── Express + SSE (Multi-Client) ────────────────────────────────────────────

const app = express();
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const API_KEY = requireEnv("MCP_API_KEY");

// API Key protection
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    res.status(401).send("Unauthorized");
    return;
  }
  next();
});

const sessions: Record<string, { transport: SSEServerTransport; server: McpServer }> = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();

  sessions[transport.sessionId] = { transport, server };

  res.on("close", () => {
    delete sessions[transport.sessionId];
    server.close().catch(() => {});
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const session = sessions[sessionId];
  if (!session) {
    res.status(400).send("Unknown session");
    return;
  }
  await session.transport.handlePostMessage(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`MySQL MCP Server running (SSE) on port ${PORT}\n`);
});
