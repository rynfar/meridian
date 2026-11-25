import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "libsql"
import { createSqliteStores } from "../telemetry/sqlite"

it("preserves request attribution and legacy rows when a migrated database is reopened", () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-telemetry-attribution-"))
  const dbPath = join(dir, "telemetry.db")
  try {
    const legacy = new Database(dbPath)
    try {
      // An on-disk schema from before attribution, independent of today's initializer.
      legacy.exec(`
        CREATE TABLE metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
          adapter TEXT, model TEXT NOT NULL, request_model TEXT, mode TEXT NOT NULL,
          is_resume INTEGER NOT NULL, is_passthrough INTEGER NOT NULL, lineage_type TEXT,
          has_deferred_tools INTEGER, deferred_tool_count INTEGER, tool_count INTEGER, discovered_tools TEXT,
          session_discovered_count INTEGER, message_count INTEGER, sdk_session_id TEXT,
          status INTEGER NOT NULL, queue_wait_ms REAL NOT NULL, proxy_overhead_ms REAL NOT NULL, ttfb_ms REAL,
          upstream_duration_ms REAL NOT NULL, total_duration_ms REAL NOT NULL, content_blocks INTEGER NOT NULL,
          text_events INTEGER NOT NULL, error TEXT, input_tokens INTEGER, output_tokens INTEGER,
          cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_hit_rate REAL
        );
        INSERT INTO metrics (
          request_id, timestamp, adapter, model, mode, is_resume, is_passthrough, status, queue_wait_ms,
          proxy_overhead_ms, upstream_duration_ms, total_duration_ms, content_blocks, text_events, input_tokens
        ) VALUES ('legacy', 1000, 'opencode', 'sonnet', 'stream', 0, 0, 200, 5, 12, 800, 850, 3, 10, 123);
      `)
    } finally {
      legacy.close()
    }

    const client = { name: "voice-ai", version: "0.9.3", installation: "test-install", device: "Test phone" }
    const attribution = { client, purpose: "chat" }
    const namedClient = { client: { name: "meridian" } }
    const onlyPurpose = { purpose: "other" }
    const metric = {
      model: "sonnet", mode: "stream", isResume: false, isPassthrough: false, status: 200,
      queueWaitMs: 5, proxyOverheadMs: 12, ttfbMs: 120, upstreamDurationMs: 800,
      totalDurationMs: 850, contentBlocks: 3, textEvents: 10, error: null,
    } as const

    const migrated = createSqliteStores(dbPath, 7)
    try {
      migrated.telemetry.record({ ...metric, requestId: "attributed", timestamp: 2000, ...attribution })
      migrated.telemetry.record({ ...metric, requestId: "name-only", timestamp: 3000, ...namedClient })
      migrated.telemetry.record({ ...metric, requestId: "purpose-only", timestamp: 4000, ...onlyPurpose })
    } finally {
      migrated.close()
    }

    const reopened = createSqliteStores(dbPath, 7)
    try {
      const rows = new Map(reopened.telemetry.getRecent().map(row => [row.requestId, row]))
      expect(rows.get("legacy")).toMatchObject({ adapter: "opencode", status: 200, inputTokens: 123 })
      expect(rows.get("legacy")).not.toHaveProperty("client")
      expect(rows.get("legacy")).not.toHaveProperty("purpose")
      expect(rows.get("attributed")).toMatchObject(attribution)
      expect(rows.get("name-only")).toHaveProperty("client", { name: "meridian" })
      expect(rows.get("name-only")).not.toHaveProperty("purpose")
      expect(rows.get("purpose-only")).toHaveProperty("purpose", "other")
      expect(rows.get("purpose-only")).not.toHaveProperty("client")
    } finally {
      reopened.close()
    }

    const raw = new Database(dbPath, { readonly: true })
    try {
      expect(raw.prepare(`
        SELECT client_name, client_version, client_installation, client_device, purpose
        FROM metrics WHERE request_id = ?
      `).get("attributed")).toMatchObject({
        client_name: "voice-ai", client_version: "0.9.3", client_installation: "test-install",
        client_device: "Test phone", purpose: "chat",
      })
    } finally {
      raw.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
