// Managed-inference quota store.
//
// Contract (identical for the Redis and in-memory stores):
//   acquire({ ownerId, requestId, reserveOutputTokens, reserveMicroUsd })
//     reserveMicroUsd is the estimated cost held against the monthly cap until finish.
//     -> { allowed, reason, day }. `day` is the calendar day the reservation is
//     attributed to and must be passed back to finish as `quotaDay`.
//   finish({ ownerId, requestId, quotaDay, promptTokens, completionTokens, totalTokens })
//     -> releases the reservation and charges usage at most once per request /
//     reservation id, against the day recorded at acquire. Both stores return
//     [releasedTokens, chargedOutputTokens]; a duplicate settlement returns [0, 0].
//
// The active-request set is deliberately day-independent: a midnight boundary must
// not reset concurrent-request accounting (which would double the available
// concurrency). Reservations, charged output and detailed usage stay day-scoped.
// Crashed requests are reconciled on the next acquire once they are older than
// activeTimeoutMs: the stale active entry is dropped and a still-live reservation is
// released, so a dead request neither blocks concurrency forever nor permanently
// exhausts the daily token budget.

// Calendar month (UTC) a quota day belongs to, e.g. "2026-10". The monthly
// allowance is attributed to the month of the reservation's day.
export function monthOfDay(day) {
  return new Date(day * 86_400_000).toISOString().slice(0, 7);
}

// Default per-account monthly allowance in micro-USD (1e-6 USD) on the
// operator-funded path: $2.00. Override with HEADMASTER_INFERENCE_USD_PER_MONTH.
export const DEFAULT_MICRO_USD_PER_MONTH = 2_000_000;
const MONTH_TTL_SECONDS = 40 * 24 * 60 * 60;

const ACQUIRE_SCRIPT = `
local requestCount = tonumber(redis.call('GET', KEYS[1]) or '0')
if requestCount >= tonumber(ARGV[4]) then return {0, 'request_budget'} end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[2]))
for _, requestId in ipairs(expired) do
  local staleReservation = tonumber(redis.call('HGET', KEYS[5], requestId) or '0')
  if staleReservation > 0 then
    redis.call('HDEL', KEYS[5], requestId)
    local reservedTotal = tonumber(redis.call('GET', KEYS[3]) or '0')
    if reservedTotal >= staleReservation then
      redis.call('DECRBY', KEYS[3], staleReservation)
    else
      redis.call('SET', KEYS[3], '0')
      redis.call('EXPIRE', KEYS[3], tonumber(ARGV[9]))
    end
  end
  local staleCost = tonumber(redis.call('HGET', KEYS[9], requestId) or '0')
  if staleCost > 0 then
    redis.call('HDEL', KEYS[9], requestId)
    local costTotal = tonumber(redis.call('GET', KEYS[8]) or '0')
    if costTotal >= staleCost then redis.call('DECRBY', KEYS[8], staleCost) else redis.call('SET', KEYS[8], '0') end
  end
  redis.call('ZREM', KEYS[2], requestId)
end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return {0, 'concurrency'} end
local used = tonumber(redis.call('GET', KEYS[4]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[3]) or '0')
local reserve = tonumber(ARGV[5])
if used + reserved + reserve > tonumber(ARGV[6]) then return {0, 'token_budget'} end
local monthSpent = tonumber(redis.call('GET', KEYS[7]) or '0')
local monthReserved = tonumber(redis.call('GET', KEYS[8]) or '0')
local reserveCost = tonumber(ARGV[11] or '0')
if monthSpent >= tonumber(ARGV[10]) then return {0, 'monthly_budget'} end
if monthSpent + monthReserved + reserveCost > tonumber(ARGV[10]) then return {0, 'monthly_budget'} end
redis.call('INCR', KEYS[1])
if requestCount == 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[8])) end
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]), ARGV[7])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[9]))
redis.call('HSET', KEYS[5], ARGV[7], reserve)
redis.call('INCRBY', KEYS[3], reserve)
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[9]))
redis.call('EXPIRE', KEYS[5], tonumber(ARGV[9]))
if reserveCost > 0 then
  redis.call('HSET', KEYS[9], ARGV[7], reserveCost)
  redis.call('INCRBY', KEYS[8], reserveCost)
  redis.call('EXPIRE', KEYS[8], tonumber(ARGV[12]))
  redis.call('EXPIRE', KEYS[9], tonumber(ARGV[12]))
end
redis.call('HDEL', KEYS[6], ARGV[7])
return {1, 'ok'}
`;

// ARGV: 1=requestId, 2=output tokens, 3=prompt tokens, 4=total tokens,
//       5=usage ttl seconds, 6=active ttl seconds, 7=monthly ttl seconds,
//       8=cost of this request in micro-USD.
// KEYS[7] is the account's calendar-month spend counter (micro-USD); KEYS[8] and
// KEYS[9] are the month's outstanding cost reservations (total, per request), which
// FINISH releases before adding the settled cost, so concurrent requests cannot
// together overshoot the monthly cap.
// The settled marker (KEYS[6]) makes settlement idempotent per request id: the whole
// script is atomic, so a duplicate finish is a no-op and cannot charge usage twice.
const FINISH_SCRIPT = `
if redis.call('HSETNX', KEYS[6], ARGV[1], 1) == 0 then return {0, 0} end
local reserved = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if reserved > 0 then
  redis.call('HDEL', KEYS[2], ARGV[1])
  local reservedTotal = tonumber(redis.call('GET', KEYS[3]) or '0')
  if reservedTotal >= reserved then
    redis.call('DECRBY', KEYS[3], reserved)
  else
    redis.call('SET', KEYS[3], '0')
    redis.call('EXPIRE', KEYS[3], tonumber(ARGV[6]))
  end
end
local reservedCost = tonumber(redis.call('HGET', KEYS[9], ARGV[1]) or '0')
if reservedCost > 0 then
  redis.call('HDEL', KEYS[9], ARGV[1])
  local costTotal = tonumber(redis.call('GET', KEYS[8]) or '0')
  if costTotal >= reservedCost then redis.call('DECRBY', KEYS[8], reservedCost) else redis.call('SET', KEYS[8], '0') end
end
redis.call('ZREM', KEYS[1], ARGV[1])
local output = tonumber(ARGV[2])
local prompt = tonumber(ARGV[3])
local total = tonumber(ARGV[4])
if output > 0 then redis.call('INCRBY', KEYS[4], output) end
if prompt > 0 then redis.call('HINCRBY', KEYS[5], 'prompt_tokens', prompt) end
if output > 0 then redis.call('HINCRBY', KEYS[5], 'completion_tokens', output) end
if total > 0 then redis.call('HINCRBY', KEYS[5], 'total_tokens', total) end
local monthly = tonumber(ARGV[8])
if monthly > 0 then
  redis.call('INCRBY', KEYS[7], monthly)
  redis.call('EXPIRE', KEYS[7], tonumber(ARGV[7]))
end
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[5], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[5]))
return {reserved, output}
`;

export function createRedisQuotaStore(
  redis,
  {
    prefix = "headmaster-inference",
    maxConcurrentPerAccount = 3,
    maxRequestsPerHour = 120,
    maxCompletionTokensPerDay = 120_000,
    maxMicroUsdPerMonth = DEFAULT_MICRO_USD_PER_MONTH,
    activeTimeoutMs = 15 * 60_000,
    usageTtlSeconds = 90 * 24 * 60 * 60,
    now = () => Date.now(),
  } = {},
) {
  const key = (ownerId, suffix) => `${prefix}:${ownerId}:${suffix}`;
  const activeTtlSeconds = Math.ceil(activeTimeoutMs / 1000) + 60;
  return {
    async acquire({ ownerId, requestId, reserveOutputTokens, reserveMicroUsd = 0 }) {
      const at = now();
      const hour = Math.floor(at / 3_600_000);
      const day = Math.floor(at / 86_400_000);
      const month = monthOfDay(day);
      const result = await redis.eval(
        ACQUIRE_SCRIPT,
        9,
        key(ownerId, `requests:${hour}`),
        key(ownerId, "active"),
        key(ownerId, `reserved:${day}`),
        key(ownerId, `output:${day}`),
        key(ownerId, `reservations:${day}`),
        key(ownerId, `settled:${day}`),
        key(ownerId, `month:${month}`),
        key(ownerId, `month-reserved:${month}`),
        key(ownerId, `month-reservations:${month}`),
        at,
        at - activeTimeoutMs,
        maxConcurrentPerAccount,
        maxRequestsPerHour,
        reserveOutputTokens,
        maxCompletionTokensPerDay,
        requestId,
        3_700,
        activeTtlSeconds,
        maxMicroUsdPerMonth,
        Number.isSafeInteger(reserveMicroUsd) && reserveMicroUsd > 0 ? reserveMicroUsd : 0,
        MONTH_TTL_SECONDS,
      );
      return {
        allowed: Number(result?.[0]) === 1,
        reason: String(result?.[1] || "quota_unavailable"),
        day,
      };
    },
    async finish({
      ownerId,
      requestId,
      quotaDay,
      promptTokens = 0,
      completionTokens = 0,
      totalTokens = 0,
      costMicroUsd = 0,
    }) {
      const day = Number.isSafeInteger(quotaDay) ? quotaDay : Math.floor(now() / 86_400_000);
      const month = monthOfDay(day);
      return redis.eval(
        FINISH_SCRIPT,
        9,
        key(ownerId, "active"),
        key(ownerId, `reservations:${day}`),
        key(ownerId, `reserved:${day}`),
        key(ownerId, `output:${day}`),
        key(ownerId, `usage:${day}`),
        key(ownerId, `settled:${day}`),
        key(ownerId, `month:${month}`),
        key(ownerId, `month-reserved:${month}`),
        key(ownerId, `month-reservations:${month}`),
        requestId,
        completionTokens,
        promptTokens,
        totalTokens,
        usageTtlSeconds,
        activeTtlSeconds,
        MONTH_TTL_SECONDS,
        Number.isSafeInteger(costMicroUsd) && costMicroUsd > 0 ? costMicroUsd : 0,
      );
    },
  };
}

export function createMemoryQuotaStore({
  maxConcurrentPerAccount = 3,
  maxRequestsPerHour = 120,
  maxCompletionTokensPerDay = 120_000,
  maxMicroUsdPerMonth = DEFAULT_MICRO_USD_PER_MONTH,
  activeTimeoutMs = 15 * 60_000,
  now = () => Date.now(),
} = {}) {
  const accounts = new Map();
  const dayOf = (at) => Math.floor(at / 86_400_000);
  const get = (ownerId) => {
    if (!accounts.has(ownerId))
      accounts.set(ownerId, {
        active: new Map(), // requestId -> { at, day }
        reservations: new Map(), // requestId -> { reserve, day }
        settled: new Map(), // requestId -> day of the settled reservation
        requests: [], // hourly request buckets
        reservedByDay: new Map(), // day -> outstanding reserved output tokens
        usedByDay: new Map(), // day -> charged output tokens
        usageByDay: new Map(), // day -> { promptTokens, completionTokens, totalTokens }
        spentByMonth: new Map(), // "YYYY-MM" -> spend in micro-USD
        costReservations: new Map(), // requestId -> { cost, month }
      });
    return accounts.get(ownerId);
  };
  const release = (account, requestId) => {
    const reservation = account.reservations.get(requestId);
    if (!reservation) return 0;
    account.reservations.delete(requestId);
    const outstanding = account.reservedByDay.get(reservation.day) || 0;
    account.reservedByDay.set(reservation.day, Math.max(0, outstanding - reservation.reserve));
    return reservation.reserve;
  };
  const reservedCost = (account, month) => {
    let total = 0;
    for (const entry of account.costReservations.values()) if (entry.month === month) total += entry.cost;
    return total;
  };
  // Mirrors the short-lived day keys of the Redis store: keep yesterday for
  // reservations that settle just after a midnight boundary, drop older days.
  const prune = (account, day) => {
    for (const days of [account.reservedByDay, account.usedByDay, account.usageByDay]) {
      for (const recorded of days.keys()) if (recorded < day - 1) days.delete(recorded);
    }
    for (const [requestId, settledDay] of account.settled)
      if (settledDay < day - 1) account.settled.delete(requestId);
  };
  const usageFor = (account, day) =>
    account.usageByDay.get(day) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return {
    async acquire({ ownerId, requestId, reserveOutputTokens, reserveMicroUsd = 0 }) {
      const at = now();
      const hour = Math.floor(at / 3_600_000);
      const day = dayOf(at);
      const account = get(ownerId);
      prune(account, day);
      account.requests = account.requests.filter((bucket) => bucket.hour === hour);
      if (account.requests.length >= maxRequestsPerHour)
        return { allowed: false, reason: "request_budget" };
      for (const [id, entry] of account.active) {
        if (entry.at <= at - activeTimeoutMs) {
          release(account, id);
          account.costReservations.delete(id);
          account.active.delete(id);
        }
      }
      if (account.active.size >= maxConcurrentPerAccount)
        return { allowed: false, reason: "concurrency" };
      const used = account.usedByDay.get(day) || 0;
      const reserved = account.reservedByDay.get(day) || 0;
      if (used + reserved + reserveOutputTokens > maxCompletionTokensPerDay)
        return { allowed: false, reason: "token_budget" };
      const month = monthOfDay(day);
      const spent = account.spentByMonth.get(month) || 0;
      const reserveCost =
        Number.isSafeInteger(reserveMicroUsd) && reserveMicroUsd > 0 ? reserveMicroUsd : 0;
      if (spent >= maxMicroUsdPerMonth || spent + reservedCost(account, month) + reserveCost > maxMicroUsdPerMonth)
        return { allowed: false, reason: "monthly_budget" };
      if (reserveCost > 0) account.costReservations.set(requestId, { cost: reserveCost, month });
      account.requests.push({ hour });
      account.active.set(requestId, { at, day });
      account.settled.delete(requestId);
      account.reservations.set(requestId, { reserve: reserveOutputTokens, day });
      account.reservedByDay.set(day, reserved + reserveOutputTokens);
      return { allowed: true, reason: "ok", day };
    },
    async finish({
      ownerId,
      requestId,
      quotaDay,
      promptTokens = 0,
      completionTokens = 0,
      totalTokens = 0,
      costMicroUsd = 0,
    }) {
      const day = Number.isSafeInteger(quotaDay) ? quotaDay : dayOf(now());
      const account = get(ownerId);
      if (account.settled.get(requestId) === day) return [0, 0];
      account.settled.set(requestId, day);
      const released = release(account, requestId);
      account.costReservations.delete(requestId);
      account.active.delete(requestId);
      account.usedByDay.set(day, (account.usedByDay.get(day) || 0) + completionTokens);
      const usage = usageFor(account, day);
      usage.promptTokens += promptTokens;
      usage.completionTokens += completionTokens;
      usage.totalTokens += totalTokens;
      account.usageByDay.set(day, usage);
      const month = monthOfDay(day);
      const cost = Number.isSafeInteger(costMicroUsd) && costMicroUsd > 0 ? costMicroUsd : 0;
      account.spentByMonth.set(month, (account.spentByMonth.get(month) || 0) + cost);
      return [released, completionTokens];
    },
    inspect(ownerId) {
      const account = get(ownerId);
      const day = dayOf(now());
      return {
        active: account.active.size,
        reserved: account.reservedByDay.get(day) || 0,
        used: account.usedByDay.get(day) || 0,
        usage: { ...usageFor(account, day) },
      };
    },
  };
}

// Personal-provider-key ("byo") traffic uses its own counters so it can never
// consume, or be blocked by, the operator-funded token/request budgets. These
// stores reuse the operator implementation under a distinct key prefix, apply
// only concurrency and an hourly request cap, and reserve/charge no tokens
// (the user pays their own provider). Callers acquire with reserveOutputTokens 0.
const BYO_UNLIMITED_TOKENS = Number.MAX_SAFE_INTEGER;

export function createRedisByoQuotaStore(
  redis,
  {
    prefix = "headmaster-inference-byo",
    maxConcurrentPerAccount = 3,
    maxRequestsPerHour = 600,
    ...rest
  } = {},
) {
  return createRedisQuotaStore(redis, {
    ...rest,
    prefix,
    maxConcurrentPerAccount,
    maxRequestsPerHour,
    maxCompletionTokensPerDay: BYO_UNLIMITED_TOKENS,
    maxMicroUsdPerMonth: BYO_UNLIMITED_TOKENS,
  });
}

export function createMemoryByoQuotaStore({
  maxConcurrentPerAccount = 3,
  maxRequestsPerHour = 600,
  ...rest
} = {}) {
  return createMemoryQuotaStore({
    ...rest,
    maxConcurrentPerAccount,
    maxRequestsPerHour,
    maxCompletionTokensPerDay: BYO_UNLIMITED_TOKENS,
    maxMicroUsdPerMonth: BYO_UNLIMITED_TOKENS,
  });
}
