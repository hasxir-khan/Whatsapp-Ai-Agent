// Identical reduction on tenant SQL rows and on masked contact/day rollups.
// Group across the whole period *before* computing distinct conversations or
// attribution. A human reply tomorrow can change attribution for today's sale.
export const savedHours = (conversations, minutesPerChat) => Math.round((conversations * minutesPerChat) / 6) / 10;
export function impactTotals(readOne, relation, params, { hoursKnown = true, emptyRate = null } = {}) {
  const row = readOne(
    `WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER(PARTITION BY who ORDER BY first_at IS NULL,first_at) AS first_row FROM (${relation})
  ), contacts AS (
    SELECT who, MAX(first_at IS NOT NULL) inbound, MAX(owner) owner, MAX(bot) bot,
      MAX(CASE WHEN first_row=1 THEN response_ms END) response_ms,
      MAX(CASE WHEN first_row=1 THEN outside END) outside,
      SUM(bookings) bookings, SUM(orders) orders, SUM(revenue) revenue
    FROM ranked GROUP BY who
  ) SELECT SUM(inbound) conversations, SUM(inbound*(1-owner)) handledByBot, SUM(inbound*owner) ownerTouched,
    SUM(bot) botReplied, ROUND(AVG(response_ms)/60000,1) firstResponseMinutes, SUM(outside) afterHoursCovered,
    SUM(bookings) bookings, SUM(bookings*(1-owner)) botBookings, SUM(orders) orders, SUM(orders*(1-owner)) botOrders,
    SUM(revenue) revenue, SUM(revenue*(1-owner)) botRevenue FROM contacts`,
    params,
  );
  const out = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, k === 'firstResponseMinutes' ? v : v || 0]),
  );
  out.automationRate = out.conversations ? Math.round((out.handledByBot * 100) / out.conversations) : emptyRate;
  if (!hoursKnown) out.afterHoursCovered = null;
  return out;
}
