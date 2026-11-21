// Shared copy, not a message template supplied by a lease or a customer.
export const handoverLine = 'Thanks for your message. A team member will need to help you directly.';
export function pausedBehaviour(enabled) {
  return enabled
    ? 'While paused, each contact can receive one automatic handover per UTC day. No AI replies are sent.'
    : 'While paused, customers receive no automatic replies (silent mode).';
}
export function termNotice(kind, end, enabled) {
  const days = { remind_7: 7, remind_3: 3, remind_1: 1 }[kind];
  const status = days
    ? `Your assistant term ends on ${new Date(end).toISOString().slice(0, 10)} UTC (within ${days} ${days === 1 ? 'day' : 'days'}). Open Billing to review it.`
    : 'Your assistant is paused. Open Billing to review your subscription.';
  return `${status} ${pausedBehaviour(enabled)}`;
}
