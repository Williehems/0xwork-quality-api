import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pool } from "../db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "..", "db", "schema.sql");

async function main() {
  const sql = readFileSync(schemaPath, "utf-8");
  console.log(`[migrate] applying ${schemaPath}`);
  await pool().query(sql);
  console.log("[migrate] ok");
  await pool().end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
