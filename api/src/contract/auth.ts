/** Login session management, capability `auth_sessions`. No credential material. */
export type LoginSession = {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
};
export type LoginSessionsResponse = { sessions: LoginSession[] };
export type RevokeLoginSessionResponse = { ok: true; revoked: boolean };
