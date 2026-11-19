// Lua scripts run inside Redis. Redis executes each script as a single atomic step, so two
// visitors clicking at the same instant can never both pass a check that only one should pass.
//
// Accounting rule the scripts keep true at all times:
//   monthly counter = credits reserved by audits still running + credits actually spent by finished audits
// A running audit therefore always counts at its full reservation, which is what prevents overspending.

/**
 * RESERVE: check the daily, visitor and monthly limits and claim all three, or write nothing.
 * KEYS: day counter, visitor counter, month counter, reservation hash, active-reservations zset
 * ARGV: dayLimit, visitorLimit, monthCeiling, dayTtl, monthTtl, reservationTtl, nowMs, jobId,
 *       then one or more credit amounts in order of preference (largest first)
 * Returns {1,'ok',indexOfChosenAmount,credits} or {0,reason,currentValue,0}
 */
export const RESERVE_SCRIPT = `
if redis.call('EXISTS', KEYS[4]) == 1 then return {0, 'duplicate', 0, 0} end
local day = tonumber(redis.call('GET', KEYS[1]) or '0')
if day >= tonumber(ARGV[1]) then return {0, 'daily', day, 0} end
local vis = tonumber(redis.call('GET', KEYS[2]) or '0')
if vis >= tonumber(ARGV[2]) then return {0, 'visitor', vis, 0} end
local month = tonumber(redis.call('GET', KEYS[3]) or '0')
local ceiling = tonumber(ARGV[3])
local chosen = -1
local credits = 0
for i = 9, #ARGV do
  local c = tonumber(ARGV[i])
  if month + c <= ceiling then
    chosen = i - 9
    credits = c
    break
  end
end
if chosen < 0 then return {0, 'monthly', month, 0} end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
redis.call('INCRBY', KEYS[3], credits)
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5]))
redis.call('HSET', KEYS[4], 'reserved', credits, 'spent', 0, 'state', 'active', 'created', ARGV[7],
  'k_day', KEYS[1], 'k_visitor', KEYS[2], 'k_month', KEYS[3])
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[6]))
redis.call('ZADD', KEYS[5], tonumber(ARGV[7]), ARGV[8])
return {1, 'ok', chosen, credits}
`;

/**
 * SPEND: take n credits out of one audit's reservation. Refuses if that would exceed it.
 * KEYS: reservation hash   ARGV: n
 * Returns {1,'ok',remaining} or {0,reason,remaining}
 */
export const SPEND_SCRIPT = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return {0, 'inactive', 0} end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
local n = tonumber(ARGV[1])
if spent + n > reserved then return {0, 'exceeds', reserved - spent} end
redis.call('HINCRBY', KEYS[1], 'spent', n)
return {1, 'ok', reserved - spent - n}
`;

/**
 * UNSPEND: give back credits for a search the provider definitely did not charge for.
 * KEYS: reservation hash   ARGV: n   Returns the number of credits given back.
 */
export const UNSPEND_SCRIPT = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return 0 end
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
local n = tonumber(ARGV[1])
if n > spent then n = spent end
if n > 0 then redis.call('HINCRBY', KEYS[1], 'spent', -n) end
return n
`;

/**
 * OVERAGE: the provider reported charging more than planned. Record reality immediately,
 * raising the monthly counter if the audit has now spent more than it reserved.
 * KEYS: reservation hash, month counter   ARGV: extra credits
 */
export const OVERAGE_SCRIPT = `
local extra = tonumber(ARGV[1])
if extra <= 0 then return 0 end
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then
  redis.call('INCRBY', KEYS[2], extra)
  return extra
end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0') + extra
redis.call('HSET', KEYS[1], 'spent', spent)
if spent > reserved then
  redis.call('INCRBY', KEYS[2], spent - reserved)
  redis.call('HSET', KEYS[1], 'reserved', spent)
end
return extra
`;

/**
 * SETTLE: close a reservation exactly once and return its unused credits to the month.
 * When nothing was spent and refundSlots is '1', the daily and visitor slots are returned too.
 * KEYS: reservation hash, month counter, day counter, visitor counter, active-reservations zset
 * ARGV: refundSlots ('1' or '0'), jobId
 * Returns {1,unusedCreditsReturned,slotsReturned} or {0,0,0} if it was already settled.
 */
export const SETTLE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then
  redis.call('ZREM', KEYS[5], ARGV[2])
  return {0, 0, 0}
end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
local unused = reserved - spent
if unused < 0 then unused = 0 end
local month = tonumber(redis.call('GET', KEYS[2]) or '0')
if unused > month then unused = month end
if unused > 0 then redis.call('DECRBY', KEYS[2], unused) end
local slots = 0
if ARGV[1] == '1' and spent == 0 then
  if tonumber(redis.call('GET', KEYS[3]) or '0') > 0 then redis.call('DECR', KEYS[3]) end
  if tonumber(redis.call('GET', KEYS[4]) or '0') > 0 then redis.call('DECR', KEYS[4]) end
  slots = 1
end
redis.call('HSET', KEYS[1], 'state', 'settled', 'refunded', unused)
redis.call('ZREM', KEYS[5], ARGV[2])
return {1, unused, slots}
`;

/**
 * GEMINI_SLOT: decide whether one outbound Gemini request may be sent now, and count it, in one atomic step.
 * Every limit is checked before anything is written, so a refused request writes nothing and there is
 * nothing to undo. A grant increments the minute, day and per-audit counters.
 * KEYS: 1 current-minute counter, 2 previous-minute counter, 3 day counter, 4 this audit's counter,
 *       5 cooldown marker (ms timestamp), 6 provider-daily-exhausted marker
 * ARGV: 1 nowMs, 2 dayLimit (0 = none), 3 allowedPerMinute (0 = none), 4 per-audit ceiling (0 = none),
 *       5 minute-counter ttl, 6 day-counter ttl, 7 audit-counter ttl (all seconds)
 * Returns {1,'ok',auditCount,dayCount} or {0,'ceiling'|'cooldown'|'daily'|'pace',value,0}
 */
export const GEMINI_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
local v = redis.call('MGET', KEYS[4], KEYS[5], KEYS[6], KEYS[3], KEYS[1], KEYS[2])
local audit = tonumber(v[1]) or 0
local cooldown = tonumber(v[2]) or 0
local exhausted = v[3]
local day = tonumber(v[4]) or 0
local cur = tonumber(v[5]) or 0
local prev = tonumber(v[6]) or 0
local ceil = tonumber(ARGV[4])
if ceil > 0 and audit >= ceil then return {0, 'ceiling', audit, 0} end
if cooldown > now then return {0, 'cooldown', cooldown, 0} end
if exhausted then return {0, 'daily', day, 0} end
local dayLimit = tonumber(ARGV[2])
if dayLimit > 0 and day >= dayLimit then return {0, 'daily', day, 0} end
local allowed = tonumber(ARGV[3])
if allowed > 0 then
  local frac = (now % 60000) / 60000
  if prev * (1 - frac) + cur + 1 > allowed then return {0, 'pace', cur + 1, 0} end
end
local m = redis.call('INCR', KEYS[1]); if m == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5])) end
local d = redis.call('INCR', KEYS[3]); if d == 1 then redis.call('EXPIRE', KEYS[3], tonumber(ARGV[6])) end
local a = redis.call('INCR', KEYS[4]); if a == 1 then redis.call('EXPIRE', KEYS[4], tonumber(ARGV[7])) end
return {1, 'ok', a, d}
`;
