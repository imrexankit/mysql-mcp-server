# MySQL MCP Server

A secure, multi-client MCP (Model Context Protocol) server that connects Claude Desktop to any MySQL database. Ask business questions in plain English — get real-time answers from your live data.

Built using AI. Production-ready.

---

## What It Does

Connect Claude AI to your MySQL/MariaDB database and let your team query data through natural conversation instead of writing SQL or building dashboards.

**Before:** "What were our sales last month?" → Email finance → Wait 2 days → Get a spreadsheet.

**After:** Ask Claude → Get the answer in 3 seconds. With tables, charts, and context.

---

## Features

- **7 read-only query tools** — execute SQL, list tables, describe schemas, show indexes, view DDL, list databases, get table stats
- **Strict DQL enforcement** — blocks all write operations (INSERT, UPDATE, DELETE, DROP, etc.)
- **Multi-client support** — multiple Claude Desktop users can connect simultaneously
- **API key authentication** — only authorized users can access the database
- **SSL/TLS support** — secure connection to cloud-hosted MySQL databases
- **SSE transport** — works with Cloudflare Tunnel for remote access

---

## Architecture

```
MySQL Database (Cloud/On-Prem)
        ↑ SSL/TLS
MCP Server (this project, running on a server)
        ↑ SSE over HTTPS
Cloudflare Tunnel (free, no open ports)
        ↑
Claude Desktop (via mcp-remote)
```

---

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/imrexankit/mysql-mcp-server.git
cd mysql-mcp-server
npm install
```

### 2. Configure Environment

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
MYSQL_HOST=your-mysql-host
MYSQL_PORT=3306
MYSQL_USER=your-readonly-user
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=your-database
MYSQL_CA_CERT_PATH=/path/to/ca-cert.pem
PORT=3000
MCP_API_KEY=your-secret-api-key
```

**Important:** Use a read-only database user. This server enforces read-only queries at the application level, but defense in depth is always better.

### 3. Build and Run

```bash
npm run build
node dist/index.js
```

You should see:
```
MySQL MCP Server running (SSE) on port 3000
```

### 4. Test Locally

Open a browser and go to `http://localhost:3000/sse`. You should see:
```
event: endpoint
data: /messages?sessionId=some-random-id
```

---

## Connect Claude Desktop

### Prerequisites
- [Claude Desktop](https://claude.ai/download) installed
- [Node.js](https://nodejs.org) installed (for `npx mcp-remote`)

### Local Connection (same machine)

Add to your Claude Desktop config at `~/.config/claude/claude_desktop_config.json` (Mac/Linux) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://localhost:3000/sse",
        "--header", "x-api-key:your-secret-api-key"
      ]
    }
  }
}
```

### Remote Connection (via Cloudflare Tunnel)

If the server is hosted remotely with a Cloudflare Tunnel:

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp.yourdomain.com/sse",
        "--header", "x-api-key:your-secret-api-key"
      ]
    }
  }
}
```

Restart Claude Desktop after updating the config.

---

## Deploy with Cloudflare Tunnel (Free)

To make the server accessible from anywhere without opening ports:

### 1. Install Cloudflared

Download from [Cloudflare releases](https://github.com/cloudflare/cloudflared/releases/latest).

### 2. Create a Tunnel

Option A — Via Cloudflare Dashboard (recommended):
1. Go to [Cloudflare Zero Trust](https://dash.cloudflare.com) → Networks → Tunnels
2. Create a tunnel
3. Add public hostname: `mcp.yourdomain.com` → `http://localhost:3000`
4. Install the connector on your server

Option B — Via CLI:
```bash
cloudflared tunnel create mysql-mcp
cloudflared tunnel route dns mysql-mcp mcp.yourdomain.com
cloudflared tunnel run mysql-mcp
```

### 3. Install as Service (auto-start on reboot)

```bash
cloudflared service install
```

---

## Available Tools

| Tool | Description |
|------|-------------|
| `mysql_execute_query` | Run any read-only SQL (SELECT, SHOW, DESCRIBE, EXPLAIN) |
| `mysql_list_tables` | List all tables with row counts and metadata |
| `mysql_describe_table` | Show column definitions for a table |
| `mysql_show_indexes` | List all indexes on a table |
| `mysql_show_create_table` | Show the full CREATE TABLE DDL |
| `mysql_list_databases` | List all accessible databases |
| `mysql_get_table_stats` | Get row count, storage size, engine info |

---

## Security

### Built-in Protections

- **DQL-only enforcement** — only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH (CTEs) are allowed
- **Keyword blocking** — INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, REPLACE, CALL, EXEC, GRANT, REVOKE are explicitly blocked
- **API key authentication** — every request requires a valid `x-api-key` header
- **SSL/TLS** — database connection uses CA certificate verification
- **No open ports** — Cloudflare Tunnel means no inbound ports on your server

### Recommendations

- Use a **read-only MySQL user** with access only to the database/tables needed
- Use a **strong, random API key** and rotate periodically
- Keep the `.env` file secure — never commit it to version control
- If certain tables should be restricted, add query-level filtering in the server code

---

## Keep It Running

### Using PM2

```bash
npm install -g pm2
pm2 start dist/index.js --name mysql-mcp
pm2 startup
pm2 save
```

### Using NSSM (Windows)

```bash
nssm install mysql-mcp "C:\Program Files\nodejs\node.exe" "C:\mysql-mcp-server\dist\index.js"
```

---

## Project Structure

```
mysql-mcp-server/
├── src/
│   └── index.ts          # Main server code
├── dist/                  # Compiled JavaScript (generated)
├── .env                   # Environment variables (not committed)
├── .env.example           # Template for environment variables
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Already connected to a transport" | Server uses factory pattern — each connection gets its own instance. If you see this, rebuild. |
| "stream is not readable" | Don't use `express.json()` on the `/messages` route |
| Claude Desktop shows "could not be loaded" | Use `mcp-remote` with `command`/`args` format, not `type`/`url` |
| Connection timeout | Check that both MCP server and Cloudflare tunnel are running |
| "ENOTFOUND" in logs | DNS issue — try `nslookup your-domain 8.8.8.8` to verify |

---

## How This Was Built

This entire project was using Claude AI. Every line of code was written by AI. Every architecture and security decision was made by a human.
Feel free to share any possible improvements and upgrades.

LinkedIn: https://www.linkedin.com/in/ankitm93/

---

## License

MIT

---

## Contributing

Contributions welcome. Please open an issue first to discuss what you'd like to change.
