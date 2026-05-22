import { createConnection } from "mysql2/promise";
import { config } from "dotenv";

config();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await createConnection(url);

const migrations = [
  // 0002: isBanned fields
  "ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `isBanned` boolean DEFAULT false NOT NULL",
  "ALTER TABLE `users` ADD COLUMN IF NOT EXISTS `banReason` text",
  // 0003: admin_action_logs table
  `CREATE TABLE IF NOT EXISTS \`admin_action_logs\` (
    \`id\` bigint AUTO_INCREMENT NOT NULL,
    \`adminId\` int NOT NULL,
    \`adminName\` varchar(128),
    \`action\` varchar(64) NOT NULL,
    \`targetType\` varchar(32),
    \`targetId\` varchar(64),
    \`before\` json,
    \`after\` json,
    \`note\` text,
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    CONSTRAINT \`admin_action_logs_id\` PRIMARY KEY(\`id\`)
  )`,
  "CREATE INDEX IF NOT EXISTS `admin_logs_admin_idx` ON `admin_action_logs` (`adminId`,`createdAt`)",
  "CREATE INDEX IF NOT EXISTS `admin_logs_action_idx` ON `admin_action_logs` (`action`,`createdAt`)",
];

for (const sql of migrations) {
  try {
    await conn.execute(sql);
    console.log("✓", sql.slice(0, 80).replace(/\n/g, " ").trim());
  } catch (e) {
    if (e.code === "ER_DUP_FIELDNAME" || e.code === "ER_TABLE_EXISTS_ERROR" || e.code === "ER_DUP_KEYNAME") {
      console.log("⏭  already exists:", sql.slice(0, 60).replace(/\n/g, " ").trim());
    } else {
      console.error("✗", e.message);
    }
  }
}

await conn.end();
console.log("Migration complete.");
