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

export async function listAllBindings() {
  const result = await pool().query(
    `SELECT tg_user_id, tg_username, wallet FROM wallet_bindings WHERE wallet IS NOT NULL`,
  );
  return result.rows.map((r) => ({
    tgUserId: Number(r.tg_user_id),
    tgUsername: r.tg_username,
    wallet: r.wallet,
  }));
}

export async function getLastSeenCount(tgUserId, taskId) {
  const result = await pool().query(
    `SELECT last_count FROM comment_seen WHERE tg_user_id = $1 AND task_id = $2`,
    [tgUserId, taskId],
  );
  return result.rows[0]?.last_count ?? null;
}

export async function upsertLastSeenCount(tgUserId, taskId, count) {
  await pool().query(
    `INSERT INTO comment_seen (tg_user_id, task_id, last_count, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tg_user_id, task_id) DO UPDATE
       SET last_count = EXCLUDED.last_count, last_seen_at = NOW()`,
    [tgUserId, taskId, count],
  );
}

export async function getNotifiedTaskIds(tgUserId) {
  const result = await pool().query(
    `SELECT task_id FROM submission_notified WHERE tg_user_id = $1`,
    [tgUserId],
  );
  return new Set(result.rows.map((r) => Number(r.task_id)));
}

export async function markNotified(tgUserId, taskIds) {
  if (!taskIds.length) return;
  const values = taskIds.map((_, i) => `($1, $${i + 2}, NOW())`).join(", ");
  await pool().query(
    `INSERT INTO submission_notified (tg_user_id, task_id, notified_at)
     VALUES ${values}
     ON CONFLICT (tg_user_id, task_id) DO NOTHING`,
    [tgUserId, ...taskIds],
  );
}

export async function logGrade({ verdict, taskType, tier, confidence, usdcAmount, fallback }) {
  try {
    await pool().query(
      `INSERT INTO grade_log (verdict, task_type, tier, confidence, usdc_amount, fallback)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [verdict, taskType ?? null, tier ?? null, confidence ?? null, usdcAmount ?? 0, Boolean(fallback)],
    );
  } catch (err) {
    console.warn("[db] grade_log insert failed:", err.message);
  }
}

export async function getGradeStats() {
  const [totals, byType] = await Promise.all([
    pool().query(`
      SELECT
        COUNT(*)::int                                             AS total,
        COUNT(*) FILTER (WHERE verdict = 'approve')::int         AS approved,
        COUNT(*) FILTER (WHERE verdict = 'review')::int          AS review,
        COUNT(*) FILTER (WHERE verdict = 'reject')::int          AS rejected,
        ROUND(COALESCE(SUM(usdc_amount), 0)::numeric, 4)::float  AS usdc_collected,
        COUNT(*) FILTER (WHERE fallback = TRUE)::int             AS fallback_count,
        MAX(created_at)                                          AS last_graded_at,
        MIN(created_at)                                          AS first_graded_at
      FROM grade_log
    `),
    pool().query(`
      SELECT task_type, COUNT(*)::int AS count
      FROM grade_log
      WHERE task_type IS NOT NULL
      GROUP BY task_type
      ORDER BY count DESC
    `),
  ]);
  return { ...totals.rows[0], by_type: byType.rows };
}
