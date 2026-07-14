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
}

export interface FailoverThresholds {
  session: number;
  weekly: number;
  fable: number;
}

/**
 * Which pressure dimensions should trigger account failover (CLI/notify).
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
 * Pick an account for CLI failover among candidates.
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

export function formatReset(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'soon';
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
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
