import type { Queryable } from '../client.js';
import type { SessionRow, UserRow } from '../types.js';

/**
 * Sessions are stored by hash only. A database dump therefore yields no usable session
 * credentials — the same reason password hashes exist.
 */

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ipHash: string | null;
  userAgent: string | null;
}

export async function createSession(
  sql: Queryable,
  input: CreateSessionInput,
): Promise<SessionRow> {
  const rows = await sql<SessionRow[]>`
    INSERT INTO sessions (user_id, token_hash, expires_at, ip_hash, user_agent)
    VALUES (${input.userId}, ${input.tokenHash}, ${input.expiresAt}, ${input.ipHash}, ${input.userAgent})
    RETURNING *
  `;
  const row = rows[0];
  if (!row) throw new Error('createSession: no row returned');
  return row;
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/**
 * Look a session up by token hash and return it with its user, in one round trip.
 *
 * Runs unbound: this is the query that *establishes* identity, so it cannot itself be
 * filtered by identity. Everything downstream of it is bound and RLS-constrained.
 */
export async function resolveSession(
  sql: Queryable,
  tokenHash: string,
  now: Date = new Date(),
): Promise<ResolvedSession | null> {
  const rows = await sql<Array<SessionRow & { user: UserRow }>>`
    SELECT
      s.*,
      to_jsonb(u.*) AS user
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > ${now}
      AND u.deleted_at IS NULL
      AND u.is_active
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const { user, ...session } = row;
  return { session: session as SessionRow, user };
}

export async function touchSession(sql: Queryable, sessionId: string): Promise<void> {
  await sql`UPDATE sessions SET last_used_at = now() WHERE id = ${sessionId}`;
}

export async function revokeSession(sql: Queryable, sessionId: string): Promise<void> {
  await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${sessionId} AND revoked_at IS NULL`;
}

/** Revoke every live session for a user — used on PIN change and on security events. */
export async function revokeAllSessions(
  sql: Queryable,
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE sessions SET revoked_at = now()
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
      AND expires_at > now()
      ${options.exceptSessionId ? sql`AND id <> ${options.exceptSessionId}` : sql``}
    RETURNING id
  `;
  return rows.length;
}
