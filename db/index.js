import pg from "pg";

const { Pool } = pg;

let _pool = null;

export function pool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL not set — required for wallet bindings");
  }
  _pool = new Pool({
    connectionString,
    ssl: connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  return _pool;
}

export async function setWallet({ tgUserId, tgUsername, wallet }) {
  const result = await pool().query(
    `INSERT INTO wallet_bindings (tg_user_id, tg_username, wallet, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tg_user_id) DO UPDATE
       SET wallet = EXCLUDED.wallet,
           tg_username = EXCLUDED.tg_username,
           updated_at = NOW()
     RETURNING *`,
    [tgUserId, tgUsername ?? null, wallet],
  );
  return result.rows[0];
}

export async function getWallet(tgUserId) {
  const result = await pool().query(
    `SELECT * FROM wallet_bindings WHERE tg_user_id = $1`,
    [tgUserId],
  );
  return result.rows[0] ?? null;
}

export async function deleteWallet(tgUserId) {
  await pool().query(`DELETE FROM wallet_bindings WHERE tg_user_id = $1`, [tgUserId]);
}

export async function markOnboarded(tgUserId) {
  await pool().query(
    `UPDATE wallet_bindings SET onboarded_at = NOW()
     WHERE tg_user_id = $1 AND onboarded_at IS NULL`,
    [tgUserId],
  );
}

export async function getRuntimeSettings() {
  const result = await pool().query(`SELECT key, value FROM runtime_settings ORDER BY key`);
  return Object.fromEntries(result.rows.map(r => [r.key, r.value]));
}

export async function setRuntimeSetting(key, value) {
  await pool().query(
    `INSERT INTO runtime_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)],
  );
}
