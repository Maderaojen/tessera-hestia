// Metadata-only CLI analytics. Dates are local YYYY-MM-DD in `timezone`;
// timestamps are UTC ISO. This contract has no runtime dependencies.
export type UsageQuery = {
  from: string;
  to: string;
  timezone: string;
  accountId?: string;
  provider?: string;
  projectId?: string;
  tmuxId?: string;
};

export type UsageTotals = {
  /** Noncached input; cached input is counted separately below. */
  inputTokens: number;
  /** Includes reasoning tokens; reasoning must never be added again. */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** input + output + cache read + cache write (nonoverlapping buckets). */
  totalTokens: number;
  /** Deduplicated positive-usage model requests, not user prompts. */
  requestCount: number;
  /** Distinct provider + CLI session identities within this scope. */
  sessionCount: number;
  /** API-equivalent estimate; null if ANY request is unpriced. Empty scope is 0. */
  costUsd: number | null;
  unpricedRequests: number;
};

export type UsageDay = UsageTotals & { date: string };
export type UsageGroup = UsageTotals & { id: string; label: string; provider?: string };
export type UsageScanStatus = {
  state: 'idle' | 'scanning' | 'error';
  revision: number;
  updatedAt: string | null;
  lastError: string | null;
  filesScanned: number;
};
export type UsageCoverage = {
  /** Observed event span, not proof that earlier dates had zero usage. */
  firstEventAt: string | null;
  lastEventAt: string | null;
  unattributedRequests: number;
  warnings: string[];
};
export type UsageFacets = {
  accounts: {
    id: string;
    label: string;
    provider: string;
    source: 'native' | 'janus';
    /** False for a historical source no longer currently discoverable. */
    available: boolean;
  }[];
  providers: string[];
  projects: { id: string; label: string }[];
  tmuxSessions: { id: string; label: string; projectId: string | null }[];
  capabilities: {
    costs: boolean;
    projectFilter: boolean;
    tmuxFilter: boolean;
    /** False unless a quota adapter is actually implemented. */
    quota: boolean;
  };
  status: UsageScanStatus;
};
export type UsageSummary = {
  from: string;
  to: string;
  timezone: string;
  totals: UsageTotals;
  /** Every date in [from, to), including zero-use dates. */
  days: UsageDay[];
  models: UsageGroup[];
  accounts: UsageGroup[];
  coverage: UsageCoverage;
  status: UsageScanStatus;
};
export type UsageDayDetail = {
  date: string;
  timezone: string;
  totals: UsageTotals;
  models: UsageGroup[];
  accounts: UsageGroup[];
  /** At most 100 sessions, ordered by descending total tokens. */
  sessions: (UsageGroup & {
    accountId: string;
    projectId: string | null;
    tmuxId: string | null;
  })[];
  sessionsTruncated: boolean;
  coverage: UsageCoverage;
  status: UsageScanStatus;
};
