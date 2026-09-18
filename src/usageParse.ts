/**
 * Pure usage parsing + threshold helpers (no vscode, no network).
 * Used by usage.ts and unit tests.
 */

export interface ModelLimit {
  name: string;
  percent: number;
  resetsAt: string | null;
  kind: string;
}

export interface UsageSnapshot {
  sessionPercent: number;
  sessionResetsAt: string | null;
  weeklyPercent: number;
  weeklyResetsAt: string | null;
  opusPercent: number | null;
  opusResetsAt: string | null;
  sonnetPercent: number | null;
  sonnetResetsAt: string | null;
  modelLimits: ModelLimit[];
  overagePercent: number | null;
  email: string | null;
  orgName: string | null;
  planLabel: string | null;
  fetchedAt: number;
  configDir: string;
  /**
   * How many buckets the response behind this snapshot actually carried a
   * utilization for — the 5h one, the 7d one and the model-scoped ones. A
   * bucket the response left out is stored as 0 above, so the figures alone
   * cannot tell a fetch that recovered nothing from an account that has used
   * nothing. Optional: snapshots written before this field existed have none.
   */
  bucketsSeen?: number;
}

export interface FailoverThresholds {
  session: number;
  weekly: number;
  fable: number;
}

/**
 * Which pressure dimensions should trigger account failover.
 * When a dimension is false, we still surface it in the meter, but do NOT
 * switch accounts for it alone — e.g. Fable-only pressure can be left to
 * Claude Code's model fallback.
 */
export interface FailoverTriggers {
  /** 5-hour session bucket */
  session: boolean;
  /** 7-day all-models bucket */
  weekly: boolean;
  /** Fable model-scoped weekly bucket */
  fable: boolean;
}

export const DEFAULT_THRESHOLDS: FailoverThresholds = {
  session: 90,
  weekly: 90,
  fable: 90,
};

/** Defaults: fail over on session + weekly; leave Fable to model switch. */
export const DEFAULT_TRIGGERS: FailoverTriggers = {
  session: true,
  weekly: true,
  fable: false,
};

function pct(v: unknown): number | null {
  if (v == null || typeof v !== 'number' || Number.isNaN(v)) return null;
  return Math.round(v);
}

function bucket(obj: unknown): { utilization: number | null; resets_at: string | null } {
  if (!obj || typeof obj !== 'object') return { utilization: null, resets_at: null };
  const o = obj as { utilization?: number; resets_at?: string };
  return {
    utilization: typeof o.utilization === 'number' ? o.utilization : null,
    resets_at: typeof o.resets_at === 'string' ? o.resets_at : null,
  };
}

export function parseModelLimits(limits: unknown): ModelLimit[] {
  if (!Array.isArray(limits)) return [];
  const out: ModelLimit[] = [];
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const L = item as {
      kind?: string;
      percent?: number;
      resets_at?: string;
      is_active?: boolean;
      scope?: { model?: { display_name?: string; id?: string } };
    };
    if (L.kind !== 'weekly_scoped' && L.kind !== 'model') continue;
    const name =
      L.scope?.model?.display_name ||
      L.scope?.model?.id ||
      (L.kind === 'weekly_scoped' ? 'Model' : null);
    if (!name || typeof L.percent !== 'number') continue;
    if (L.is_active === false && L.percent === 0) continue;
    out.push({
      name,
      percent: Math.round(L.percent),
      resetsAt: L.resets_at ?? null,
      kind: L.kind ?? 'weekly_scoped',
    });
  }
  const byName = new Map<string, ModelLimit>();
  for (const m of out) {
    const prev = byName.get(m.name);
    if (!prev || m.percent > prev.percent) byName.set(m.name, m);
  }
  return [...byName.values()].sort((a, b) => b.percent - a.percent);
}

export function planFromProfile(profile: unknown): {
  email: string | null;
  orgName: string | null;
  planLabel: string | null;
} {
  if (!profile || typeof profile !== 'object') {
    return { email: null, orgName: null, planLabel: null };
  }
  const p = profile as {
    account?: {
      email?: string;
      has_claude_max?: boolean;
      has_claude_pro?: boolean;
    };
    organization?: {
      name?: string;
      organization_type?: string;
      rate_limit_tier?: string;
    };
  };
  const acc = p.account || {};
  const org = p.organization || {};
  let planLabel: string | null = null;
  const tier = org.rate_limit_tier || '';
  const m = tier.match(/default_claude_(\w+?)(?:_(\d+x))?$/);
  if (m) {
    const plan = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    planLabel = m[2] ? `${plan} ${m[2]}` : plan;
  } else if (org.organization_type) {
    planLabel = org.organization_type.replace(/^claude_/, '').replace(/_/g, ' ');
  } else if (acc.has_claude_max) planLabel = 'Max';
  else if (acc.has_claude_pro) planLabel = 'Pro';
  return {
    email: acc.email ?? null,
    orgName: org.name ?? null,
    planLabel,
  };
}

/** Map raw /api/oauth/usage (+ optional profile) into a snapshot. */
export function buildSnapshot(
  usage: Record<string, unknown>,
  profile: unknown,
  configDir: string,
  fetchedAt = Date.now()
): UsageSnapshot {
  const five = bucket(usage.five_hour);
  const week = bucket(usage.seven_day);
  const opus = bucket(usage.seven_day_opus);
  const sonnet = bucket(usage.seven_day_sonnet);
  const extra = usage.extra_usage as { utilization?: number; is_enabled?: boolean } | null;
  const modelLimits = parseModelLimits(usage.limits);
  const plan = planFromProfile(profile);

  for (const [key, val] of Object.entries(usage)) {
    if (!key.startsWith('seven_day_') && !/fable/i.test(key)) continue;
    if (key === 'seven_day_opus' || key === 'seven_day_sonnet' || key === 'seven_day_oauth_apps')
      continue;
    const b = bucket(val);
    if (b.utilization == null) continue;
    let name = key.replace(/^seven_day_/, '').replace(/_/g, ' ');
    if (/fable|omelette/i.test(key)) name = 'Fable';
    if (!modelLimits.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      modelLimits.push({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        percent: Math.round(b.utilization),
        resetsAt: b.resets_at,
        kind: key,
      });
    }
  }

  // Counted after the loop above so the model buckets it appends are included.
  const bucketsSeen =
    (pct(five.utilization) == null ? 0 : 1) +
    (pct(week.utilization) == null ? 0 : 1) +
    modelLimits.length;

  return {
    sessionPercent: pct(five.utilization) ?? 0,
    sessionResetsAt: five.resets_at,
    weeklyPercent: pct(week.utilization) ?? 0,
    weeklyResetsAt: week.resets_at,
    opusPercent: pct(opus.utilization),
    opusResetsAt: opus.resets_at,
    sonnetPercent: pct(sonnet.utilization),
    sonnetResetsAt: sonnet.resets_at,
    modelLimits,
    overagePercent:
      extra?.is_enabled && typeof extra.utilization === 'number'
        ? Math.round(extra.utilization)
        : null,
    email: plan.email,
    orgName: plan.orgName,
    planLabel: plan.planLabel,
    fetchedAt,
    configDir,
    bucketsSeen,
  };
}

export function fablePercent(u: UsageSnapshot): number | null {
  const m = u.modelLimits.find((x) => /fable/i.test(x.name));
  return m ? m.percent : null;
}

/** All dimensions over threshold (for meter coloring / info). */
export function pressureReasons(
  u: UsageSnapshot,
  t: FailoverThresholds = DEFAULT_THRESHOLDS
): string[] {
  const reasons: string[] = [];
  if (u.sessionPercent >= t.session) reasons.push(`5h ${u.sessionPercent}%≥${t.session}%`);
  if (u.weeklyPercent >= t.weekly) reasons.push(`7d ${u.weeklyPercent}%≥${t.weekly}%`);
  const f = fablePercent(u);
  if (f != null && f >= t.fable) reasons.push(`Fable ${f}%≥${t.fable}%`);
  return reasons;
}

/**
 * Reasons that should trigger account failover, given which dimensions are enabled.
 * Fable-only pressure with triggers.fable=false → empty (stay; let Claude Code change models).
 */
export function failoverReasons(
  u: UsageSnapshot,
  t: FailoverThresholds = DEFAULT_THRESHOLDS,
  triggers: FailoverTriggers = DEFAULT_TRIGGERS
): string[] {
  const reasons: string[] = [];
  if (triggers.session && u.sessionPercent >= t.session) {
    reasons.push(`5h ${u.sessionPercent}%≥${t.session}%`);
  }
  if (triggers.weekly && u.weeklyPercent >= t.weekly) {
    reasons.push(`7d ${u.weeklyPercent}%≥${t.weekly}%`);
  }
  const f = fablePercent(u);
  if (triggers.fable && f != null && f >= t.fable) {
    reasons.push(`Fable ${f}%≥${t.fable}%`);
  }
  return reasons;
}

export function needsFailover(
  u: UsageSnapshot,
  t: FailoverThresholds = DEFAULT_THRESHOLDS,
  triggers: FailoverTriggers = DEFAULT_TRIGGERS
): boolean {
  return failoverReasons(u, t, triggers).length > 0;
}

/** Any meter pressure (including non-failover dimensions). */
export function isHot(u: UsageSnapshot, t: FailoverThresholds = DEFAULT_THRESHOLDS): boolean {
  return pressureReasons(u, t).length > 0;
}

/** How to pick among N accounts when no workspace route applies. */
export type FailoverStrategy = 'lowestUsage' | 'ordered';

export const DEFAULT_STRATEGY: FailoverStrategy = 'lowestUsage';

/** Minimal account row used by selection (policy + tests). */
export interface SelectableAccount {
  /** Stable id: email preferred; may be account name */
  id: string;
  email?: string;
  name?: string;
  dir: string;
  sessionPercent: number;
  weeklyPercent: number;
  fablePercent: number | null;
}

/**
 * Load score for ranking: max of the dimensions that are failover-enabled.
 * Lower is better. Dimensions with trigger=false are ignored (so Fable-only
 * burn does not push score when onFable=false).
 */
export function usageScore(
  a: SelectableAccount,
  triggers: FailoverTriggers = DEFAULT_TRIGGERS
): number {
  const parts: number[] = [];
  if (triggers.session) parts.push(a.sessionPercent ?? 0);
  if (triggers.weekly) parts.push(a.weeklyPercent ?? 0);
  if (triggers.fable) parts.push(a.fablePercent ?? 0);
  if (parts.length === 0) {
    // No failover dimensions — still prefer lower overall pressure for lowestUsage
    return Math.max(a.sessionPercent ?? 0, a.weeklyPercent ?? 0, a.fablePercent ?? 0);
  }
  return Math.max(...parts);
}

export function accountIsCool(
  a: SelectableAccount,
  t: FailoverThresholds = DEFAULT_THRESHOLDS,
  triggers: FailoverTriggers = DEFAULT_TRIGGERS
): boolean {
  if (triggers.session && (a.sessionPercent ?? 0) >= t.session) return false;
  if (triggers.weekly && (a.weeklyPercent ?? 0) >= t.weekly) return false;
  if (triggers.fable && a.fablePercent != null && a.fablePercent >= t.fable) return false;
  return true;
}

function idOf(a: SelectableAccount): string {
  return (a.email || a.id || a.name || '').toLowerCase();
}

/**
 * Pick an account for failover among candidates.
 *
 * - strategy `lowestUsage`: among cool accounts prefer lowest usageScore;
 *   if none cool, pick lowest score overall (least bad).
 * - strategy `ordered`: walk `order` ids (emails or names); first cool wins;
 *   if none cool, first existing in order, else lowestUsage fallback.
 * - `order` empty → all accounts are candidates (for lowestUsage) or no-op ordered.
 */
export function selectFailoverAccount(
  accounts: SelectableAccount[],
  opts: {
    strategy?: FailoverStrategy;
    /** Preference / pool ids (emails or account names). Empty = all. */
    order?: string[];
    thresholds?: FailoverThresholds;
    triggers?: FailoverTriggers;
  } = {}
): SelectableAccount | null {
  if (!accounts.length) return null;
  const strategy = opts.strategy ?? DEFAULT_STRATEGY;
  const thr = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const trig = opts.triggers ?? DEFAULT_TRIGGERS;
  const order = (opts.order || []).map((x) => x.trim().toLowerCase()).filter(Boolean);

  let pool = accounts.filter((a) => a.dir);
  if (order.length) {
    const byId = new Map<string, SelectableAccount>();
    for (const a of pool) {
      byId.set(idOf(a), a);
      if (a.email) byId.set(a.email.toLowerCase(), a);
      if (a.name) byId.set(a.name.toLowerCase(), a);
      if (a.id) byId.set(a.id.toLowerCase(), a);
    }
    if (strategy === 'ordered') {
      // Walk preference list
      for (const id of order) {
        const a = byId.get(id);
        if (a && accountIsCool(a, thr, trig)) return a;
      }
      for (const id of order) {
        const a = byId.get(id);
        if (a) return a; // least-bad: first in list even if hot
      }
      // fall through to lowest among all
    } else {
      // lowestUsage but restricted to ordered pool if provided
      const restricted = order.map((id) => byId.get(id)).filter(Boolean) as SelectableAccount[];
      if (restricted.length) pool = restricted;
    }
  }

  const cool = pool.filter((a) => accountIsCool(a, thr, trig));
  const rank = (list: SelectableAccount[]) =>
    [...list].sort((a, b) => {
      const d = usageScore(a, trig) - usageScore(b, trig);
      if (d !== 0) return d;
      return idOf(a).localeCompare(idOf(b));
    });

  if (cool.length) return rank(cool)[0];
  if (pool.length) return rank(pool)[0];
  return null;
}

/**
 * Countdown to a bucket's reset. `compact` collapses it to a single decimal
 * figure ("8.8h", "45m", "2.1d") for places that append it to a percent — one
 * formatter, two widths, so a duration never gets a second implementation.
 */
export function formatReset(iso: string | null | undefined, compact = false): string {
  if (!iso) return '';
  try {
    const at = new Date(iso).getTime();
    // An unparseable timestamp gives NaN, which compares false against every
    // bound below and would print "NaNm". No time is better than a fake one.
    if (!Number.isFinite(at)) return '';
    const diff = at - Date.now();
    if (diff <= 0) return 'soon';
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (compact) {
      if (diff >= 86_400_000) return `${trimZero(diff / 86_400_000)}d`;
      if (diff >= 3_600_000) return `${trimZero(diff / 3_600_000)}h`;
      return `${Math.max(1, Math.round(diff / 60_000))}m`;
    }
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  } catch {
    return '';
  }
}

/** One decimal, with a bare "9h" rather than "9.0h". */
function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * A bucket this full is what the user is waiting on, so its cell always carries
 * the countdown rather than just the number.
 */
const EXHAUSTED_PERCENT = 80;

/**
 * Smallest percentage drop that means anything: a fall of this many points or
 * more is headroom, anything smaller is noise. Usage only rises with use, so any
 * fall is headroom returning, but both figures are rounded, so two readings of
 * one unchanged bucket can differ by up to 2 points on rounding alone.
 */
export const HEADROOM_MIN_DROP = 3;

/**
 * A bucket landing this low came back because its window rolled over. Anything
 * higher is a partial move — an allowance change or a credit — which no clock
 * predicts: measured over 13 days of logs, 117 of 130 downward moves landed at
 * ~0% at untidy times (18:30, 23:31, 04:13), and the clearest of the rest was
 * two accounts going Fable 100% → ~70% six seconds apart, neither near its
 * resetsAt.
 */
const HEADROOM_RESET_MAX = 5;

/** One bucket whose usage percentage fell between two snapshots. */
export interface HeadroomEvent {
  /** `5h`, `7d`, or the model bucket's name (`Fable`). */
  label: string;
  from: number;
  to: number;
  kind: 'reset' | 'raise';
}

/**
 * Buckets that gained headroom between two snapshots of one account.
 *
 * Silent by design when it cannot know: no previous snapshot (a window that has
 * just started), a never-fetched snapshot on either side (`fetchedAt === 0`, so
 * its zeros are placeholders, not readings), a reading no newer than the one it
 * is compared against, or a model bucket that only appears in `next` (Anthropic
 * adding a bucket is not a drop).
 */
export function headroomEvents(
  prev: UsageSnapshot | null | undefined,
  next: UsageSnapshot | null | undefined
): HeadroomEvent[] {
  if (!prev || !next) return [];
  if (!prev.fetchedAt || !next.fetchedAt) return [];
  // Only a genuinely newer reading can show a drop, and that single test is what
  // keeps a degraded snapshot out: every path that serves one without a live
  // fetch carries the ORIGINAL fetch time rather than stamping a new one. A 429
  // or a failed call falls back to the last cached snapshot exactly as it was
  // stored; the policy.json fallback carries the poll time of the row it reads;
  // the never-fetched placeholder carries 0, which the line above already
  // rejects. So a best-effort snapshot served during a backoff is never newer
  // than what this window already holds, and its figures never reach the
  // comparison below — while an all-zero reading that IS newer is a real reset.
  if (next.fetchedAt <= prev.fetchedAt) return [];
  const events: HeadroomEvent[] = [];
  // One bucket speaks once: a name that differs only in case is the same bucket,
  // and a second event for it would double-count in the fleet-wide collapse.
  const spoken = new Set<string>();
  const consider = (label: string, from: unknown, to: unknown) => {
    if (typeof from !== 'number' || typeof to !== 'number') return;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    // A bucket cannot be less than empty or more than spent, so a figure outside
    // 0–100 is not a reading at all — and one bad figure on either side would
    // manufacture a drop of any size. Silence beats a cue built on a number the
    // API's own contract does not allow.
    if (from < 0 || from > 100 || to < 0 || to > 100) return;
    if (from - to < HEADROOM_MIN_DROP) return;
    if (spoken.has(label.toLowerCase())) return;
    spoken.add(label.toLowerCase());
    events.push({ label, from, to, kind: to <= HEADROOM_RESET_MAX ? 'reset' : 'raise' });
  };
  consider('5h', prev.sessionPercent, next.sessionPercent);
  consider('7d', prev.weeklyPercent, next.weeklyPercent);
  const before = new Map<string, number>();
  for (const m of Array.isArray(prev.modelLimits) ? prev.modelLimits : []) {
    if (m && typeof m.name === 'string') before.set(m.name.toLowerCase(), m.percent);
  }
  for (const m of Array.isArray(next.modelLimits) ? next.modelLimits : []) {
    if (!m || typeof m.name !== 'string') continue;
    const from = before.get(m.name.toLowerCase());
    if (from == null) continue;
    consider(m.name, from, m.percent);
  }
  return events;
}

/**
 * One tooltip line for an account's headroom: which buckets came back, and
 * whether the window rolled over or the allowance itself moved. Several buckets
 * for one account collapse into the same line — this is a quiet cue, not a list.
 */
export function describeHeadroom(events: HeadroomEvent[], accountLabel: string): string {
  if (!events.length) return '';
  const who = escapeTableCell(accountLabel);
  // The bucket name is an API display name and lands in the same trusted
  // markdown as the account name, so it gets the same escaping.
  const what = (e: HeadroomEvent) => escapeTableCell(e.label);
  if (events.length === 1) {
    const e = events[0];
    return e.kind === 'reset'
      ? `${what(e)} reset for ${who} — ${e.to}% used`
      : `${what(e)} allowance went up for ${who} — ${e.from}% → ${e.to}%`;
  }
  const clauses = events.map((e) =>
    e.kind === 'reset'
      ? `${what(e)} reset — ${e.to}% used`
      : `${what(e)} allowance went up — ${e.from}% → ${e.to}%`
  );
  return `${who}: ${clauses.join(' · ')}`;
}

export function formatUsageBar(u: UsageSnapshot | null | undefined): string {
  if (!u) return '';
  const parts = [`5h ${u.sessionPercent}%`, `7d ${u.weeklyPercent}%`];
  for (const m of u.modelLimits) {
    if (/fable/i.test(m.name) || m.percent > 0) {
      parts.push(`${m.name} ${m.percent}%`);
    }
  }
  if (u.opusPercent != null) parts.push(`Opus ${u.opusPercent}%`);
  if (u.sonnetPercent != null) parts.push(`Sonnet ${u.sonnetPercent}%`);
  return parts.join(' · ');
}

/** One tooltip-table row: an account's label and its last-known snapshot. */
export interface AccountUsageRow {
  /** Registry short name (falls back to email). */
  label: string;
  /** True for the window's own account — bolded and marked in the table. */
  active: boolean;
  /** Last-known snapshot, or null when nothing has been fetched yet. */
  snap: UsageSnapshot | null;
  /** Render a staleness hint next to the label (data older than its tier). */
  stale?: boolean;
  /** Identity to switch to when the row is clicked. Absent → plain text. */
  email?: string;
}

/**
 * Markdown-table cells break on raw pipes, and stray emphasis characters in an
 * account name would mangle the row — escape everything markdown-active.
 */
export function escapeTableCell(s: string): string {
  return s.replace(/[\\|*_`[\]]/g, (c) => `\\${c}`);
}

/**
 * Positional command arguments as a `command:` URI query — the JSON array VS
 * Code expects, percent-encoded. The parentheses `encodeURIComponent` leaves
 * alone are encoded too: a `)` inside a markdown link's destination ends the
 * link, so an email carrying one would spill the rest of the URI into the cell.
 */
function encodeCommandArgs(args: unknown[]): string {
  return encodeURIComponent(JSON.stringify(args)).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * The all-accounts usage table for the status-bar tooltip: one row per saved
 * account — `| Account | 5h | 7d | Fable |` — percents bold with each bucket's
 * reset countdown inline. Compact by design: this replaces the old multi-
 * paragraph per-account block.
 *
 * Another account's name is a link that switches this window straight to it, so
 * the hover that says which account has headroom is also where you take it. The
 * active row has nowhere to go, so it stays plain text.
 */
export function formatAccountsTable(rows: AccountUsageRow[]): string {
  const cell = (percent: number | null | undefined, resetsAt: string | null | undefined) => {
    if (percent == null) return '—';
    // A hint is only worth the space while it names a time still to come: a
    // malformed or already-elapsed reset time gets the number on its own rather
    // than a countdown that has run out.
    const hint = (compact: boolean) => {
      const due = formatReset(resetsAt ?? null, compact);
      return due && due !== 'soon' ? due : '';
    };
    // A bucket at the top of its allowance is one the user is blocked on, so
    // say when it is due back in the shortest form that still reads: "100% · 8.8h".
    if (percent >= EXHAUSTED_PERCENT) {
      const due = hint(true);
      return `**${percent}%**${due ? ` · ${due}` : ''}`;
    }
    const reset = hint(false);
    return `**${percent}%**${reset ? ` ${reset}` : ''}`;
  };
  const lines = ['| Account | 5h | 7d | Fable |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    const name = escapeTableCell(row.label);
    const target =
      !row.active && row.email
        ? `[${name}](command:claudeProfiles.switchAccount?${encodeCommandArgs([row.email])})`
        : row.active
          ? `**${name}** •`
          : name;
    const label = `${target}${row.stale ? ' _(stale)_' : ''}`;
    if (!row.snap) {
      lines.push(`| ${label} | — | — | — |`);
      continue;
    }
    const s = row.snap;
    const fable = s.modelLimits.find((m) => /fable/i.test(m.name));
    lines.push(
      `| ${label} | ${cell(s.sessionPercent, s.sessionResetsAt)} | ${cell(
        s.weeklyPercent,
        s.weeklyResetsAt
      )} | ${fable ? cell(fable.percent, fable.resetsAt) : '—'} |`
    );
  }
  return lines.join('\n');
}

export function formatUsageTooltip(u: UsageSnapshot | null | undefined): string {
  if (!u) return '_Usage unavailable — sign in with Claude Code, or wait for refresh._';
  const lines: string[] = [];
  lines.push(`**Usage**${u.planLabel ? ` · ${u.planLabel}` : ''}`);
  const sReset = formatReset(u.sessionResetsAt);
  const wReset = formatReset(u.weeklyResetsAt);
  lines.push(`Session (5h): **${u.sessionPercent}%**${sReset ? ` · resets ${sReset}` : ''}`);
  lines.push(`Week (all models): **${u.weeklyPercent}%**${wReset ? ` · resets ${wReset}` : ''}`);
  for (const m of u.modelLimits) {
    const r = formatReset(m.resetsAt);
    lines.push(`${m.name}: **${m.percent}%**${r ? ` · resets ${r}` : ''}`);
  }
  if (u.opusPercent != null) lines.push(`Opus week: **${u.opusPercent}%**`);
  if (u.sonnetPercent != null) lines.push(`Sonnet week: **${u.sonnetPercent}%**`);
  if (u.overagePercent != null) lines.push(`Overage: **${u.overagePercent}%**`);
  lines.push(`_Refreshed ${new Date(u.fetchedAt).toLocaleTimeString()}_`);
  return lines.join('\n\n');
}
