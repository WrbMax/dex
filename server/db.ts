import { eq } from "drizzle-orm";
import { drizzle, MySql2Database } from "drizzle-orm/mysql2";
import mysql, { Pool } from "mysql2/promise";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: MySql2Database | null = null;
let _pool: Pool | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
// Uses explicit pool options to prevent ECONNRESET on idle connections.
// Handles SSL properly for both TiDB Cloud and standard MySQL.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const rawUrl = process.env.DATABASE_URL;
      // Parse the URL to extract ssl param before passing to mysql2
      const url = new URL(rawUrl);
      const sslParam = url.searchParams.get('ssl');
      // Remove ssl from URL params — we handle it via pool config
      url.searchParams.delete('ssl');
      // Determine SSL config: TiDB Cloud requires SSL
      // mysql2 SslOptions accepts object with rejectUnauthorized, not boolean
      let sslConfig: { rejectUnauthorized: boolean } | undefined;
      if (sslParam === 'true' || sslParam === '1') {
        sslConfig = { rejectUnauthorized: false };
      } else if (sslParam && sslParam.includes('rejectUnauthorized')) {
        sslConfig = { rejectUnauthorized: true };
      } else if (url.hostname.includes('tidbcloud.com') || url.hostname.includes('tidb.cloud')) {
        // TiDB Cloud always requires SSL
        sslConfig = { rejectUnauthorized: false };
      }
      const pool = mysql.createPool({
        uri: url.toString(),
        connectionLimit: 10,
        enableKeepAlive: true,
        keepAliveInitialDelay: 30000,
        connectTimeout: 10000,
        // Keep multi-statement execution disabled. Ledger mutations use
        // parameterized statements inside an explicit transaction instead of
        // concatenated SQL batches, which is safer for exchange-grade accounting.
        multipleStatements: false,
        ...(sslConfig ? { ssl: sslConfig } : {}),
      });
      _pool = pool;
      _db = drizzle(pool);
      console.log("[Database] Connection pool created with keepAlive enabled");
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
      _pool = null;
    }
  }
  return _db;
}

/**
 * Returns the raw mysql2 Pool instance for direct multi-statement batch execution.
 * Used by the ledger module for high-performance balance mutations.
 * Must call getDb() first to ensure the pool is initialized.
 */
export async function getRawPool(): Promise<Pool | null> {
  if (!_pool) await getDb();
  return _pool;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerAddress) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }
    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }
    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }
    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
// TODO: add feature queries here as your schema grows.
