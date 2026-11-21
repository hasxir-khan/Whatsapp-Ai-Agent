// Also rendered into the README by scripts/dashboard-definitions.js. One public
// vocabulary for metric links, keyboard-accessible help, and documentation.
export const definitions = {
  conversations: [
    'Conversations',
    'Distinct contacts with an inbound message in the selected business dates, counted once across midnight.',
  ],
  handledByBot: [
    'Without an owner turn',
    'Inbound conversations with no owner message in the range. This does not guarantee the bot replied.',
  ],
  ownerTouched: ['With an owner turn', 'Inbound conversations that also had an owner message in the range.'],
  botReplied: [
    'Bot replied',
    'Distinct contacts with an assistant reply in the range, even if their question preceded it.',
  ],
  automationRate: [
    'Automation (%)',
    '100 × without an owner turn / conversations; a small denominator is flagged.',
  ],
  firstResponseMinutes: [
    'First response (min)',
    'Mean time from each contact’s first inbound in range to its first assistant reply after that, excluding waits of 24 hours or more. No pair = unavailable.',
  ],
  afterHoursCovered: [
    'After-hours coverage',
    'Contacts whose first assistant response came outside configured business opening hours; requires known hours.',
  ],
  leads: ['New leads', 'Lead rows first created in the selected range, not every returning contact.'],
  bookings: ['Bookings', 'Booking records created in the range.'],
  botBookings: [
    'Attributed bookings',
    'Bookings for contacts with no owner message in the selected range. Attribution is an estimate, not causality.',
  ],
  orders: ['Paid orders', 'Orders created in range now paid, delivered or completed.'],
  botOrders: ['Attributed orders', 'Paid orders with no owner message in the range (estimated attribution).'],
  revenue: ['Paid order value', 'Sum of those order totals, in the business currency; not bank settlement.'],
  botRevenue: [
    'Attributed revenue',
    'Value of paid orders without an owner message in the range (estimated attribution).',
  ],
  hoursSaved: [
    'Time saved · estimated (h)',
    'Distinct conversations × configured minutes per conversation / 60; not measured labour time.',
  ],
  pending: [
    'Pending now',
    'Open payment reviews marked pending or escalated; excludes rechecks. All queue counts are as of the snapshot.',
  ],
  recheck: ['Recheck now', 'Open payment reviews explicitly marked recheck.'],
  overdue: ['Overdue now', 'Open payment reviews whose deadline was before the snapshot.'],
  acceptedToday: ['Accepted today', 'Payments resolved on the snapshot’s local date as accepted or partial.'],
  rejectedToday: ['Rejected today', 'Payment decisions resolved as rejected on the snapshot’s local date.'],
  pendingAmount: [
    'Outstanding claims',
    'Sum of unpaid order balances (or recorded due without an order) on open payment requests, including rechecks. Not money received.',
  ],
  avgDecisionMinutes: [
    'Decision time (min)',
    'Mean elapsed minutes from opening to resolution across payment requests resolved in the last 30 business dates.',
  ],
  oldest: ['Oldest pending', 'Time the oldest currently pending or escalated payment was opened.'],
  growthSentToday: ['Proactive sends today', 'Successful growth-agent sends on the snapshot’s local date.'],
  growthCap: ['Daily growth cap', 'Configured proactive-send cap used by .growth.'],
  optOuts: ['Opt-outs now', 'Contacts currently opted out of proactive growth, not a period total.'],
  monthlyConversations: [
    'Monthly metered chats',
    'Distinct masked conversations on model usage attempts this business month; not the inbound conversation metric.',
  ],
  quotaLeft: [
    'Chats left this month',
    'Plan conversation limit minus distinct metered chats, floored at zero. Unlimited if plan limit is zero.',
  ],
  quotaLimit: ['Monthly chat allowance', 'Conversation entitlement of the assigned plan; zero means unlimited.'],
  callsToday: ['Calls today', 'Journaled model attempts on the current local date, including recorded failures.'],
  callsLeft: [
    'Daily call budget left',
    'The live worker’s enforced tenantBudget cap minus its successful LLM calls, at snapshot time. This pre-existing quota resets at UTC midnight; it is not the business-date attempt total. A zero cap is unlimited.',
  ],
  calls: [
    'Model calls',
    'Recorded provider attempts, including failures and fallbacks. No provider billing statement is imported.',
  ],
  tokens: [
    'Tokens',
    'Input plus output tokens; estimated when token counts are missing. Voice minutes and image bytes are not tokens.',
  ],
  inputTokens: ['Input tokens', 'Provider prompt tokens or the recorded estimate.'],
  outputTokens: ['Output tokens', 'Provider completion tokens or the recorded estimate.'],
  estimated: [
    'Estimated calls',
    'Attempts whose usage is estimated or not supplied by the provider. Zero tokens may mean unreported.',
  ],
  errors: ['Provider errors', 'Recorded failed provider attempts, not necessarily failed customer conversations.'],
  messages: ['Messages', 'Stored user, assistant and owner message rows in selected dates.'],
  voiceMinutes: [
    'Voice minutes',
    'Transcribed seconds reported by speech-to-text / 60, since instrumentation. Not a TTS duration estimate.',
  ],
  voiceMinutesLeft: [
    'Voice allowance left',
    'Monthly plan minutes less measured transcribed minutes this business month, floored at zero.',
  ],
  reviewDrafts: [
    'Review queue now',
    'Count of local review drafts awaiting approval. Notes and drafts never leave the worker.',
  ],
  connection: ['WhatsApp link', 'Last recorded tenant connection state, not a live device probe.'],
  status: ['Worker status', 'Current control-plane lifecycle state.'],
  incidents: [
    'Open incidents',
    'Unresolved tenant incident rows at snapshot time. The dated list shows kind, severity and current status for incidents opened in range.',
  ],
  lastMessage: ['Last message', 'Latest stored message timestamp, without sender or content.'],
  badMac: ['Bad decrypt MACs'],
  sessionReset: ['Session resets'],
  absentMessage: ['Absent messages'],
  retryFailed: ['Failed retries'],
  outboundSent: ['Outbound sent'],
  outboundDelivered: ['Delivery acknowledgements'],
  unacked: ['Awaiting acknowledgement', 'Tracked sends without delivery acknowledgement for at least 60 seconds.'],
  retentionDays: [
    'Retention (days)',
    'Plan entitlement in business calendar dates, including today. Older materialisations and usage-event replay rows are purged.',
  ],
  oldestAllowed: ['Earliest allowed date', 'Beginning of the plan retention window.'],
  coveredDays: [
    'Published dates',
    'Number of selected business dates published by the worker, including observed empty dates.',
  ],
  followUpsSent: ['Follow-ups sent', 'Sent followup, follow-up, rebook, reactivation or quote sends in range.'],
  followUpsAnswered: ['Follow-ups answered', 'Those sends followed by a customer reply within 72 hours.'],
  reviewAsks: ['Review asks', 'Review asks created in range now asked or rated.'],
  reviewsReceived: ['Reviews received', 'Review asks created in range now rated.'],
  goals: [
    'Goal progress',
    'Active goals at the latest snapshot: actual DB count since creation, target, and capped percent complete.',
  ],
  week: [
    'Week over week',
    'Trailing 7 local dates ending on the selection end, versus 7 immediately before. Change = (current − previous) / previous. No baseline or incomplete history = unavailable.',
  ],
  growth: ['Growth outcomes', 'Counts of proactive attempts by sending agent and recorded result.'],
  agents: [
    'Agent performance',
    'Distinct routed contacts; handoffs count as escalations; order/booking completions count as resolutions. Latency = average observed first-reply duration in seconds; errors = provider failures attributed to agent.',
  ],
  decisions: ['Conversation decisions', 'Decisions grouped by recorded action and allowlisted reason.'],
  activity: [
    'Activity feed',
    'Hourly groups by type, agent, tenant-masked contact and outcome; timestamp is last occurrence, count includes repeated items.',
  ],
  analyst: [
    'Weekly analyst archive',
    'Numeric facts saved when the weekly report was sent. Older reports only recorded conversations. No generated prose.',
  ],
  pipeline: [
    'Lead pipeline',
    'Current stage of leads created in range. Paid outranks ordered, then cold/lost, quoted, engaged (qualified/negotiating/won), otherwise new.',
  ],
  leadList: [
    'Lead directory',
    'Current score (0–100), first-touch source, tags, recorded next action/why and assignee. Unrecognised advice is not exported. Unknown free-form labels get tenant-scoped aliases.',
  ],
  transitions: [
    'Payment transitions',
    'Recorded opens, decisions, escalations, reversals and expiries, on their original event dates and hours. Notifications are not decisions.',
  ],
  rejections: [
    'Rejections today',
    'Counts by fixed rejection reason on the snapshot date; free-text reasons are never included.',
  ],
  states: [
    'Decision states',
    'Requests opened in the selected range, grouped by current state and fixed reason code.',
  ],
  payments: [
    'Payment & decision register',
    'Current state of each request opened in range. Amount is outstanding balance, minutes is elapsed opening-to-resolution time.',
  ],
  history: [
    'Per-order history',
    'Recorded decision transitions and order status changes in range. Filter by order; no actors’ numbers, proofs or notes.',
  ],
  daily: [
    'Usage by day',
    'Attempts, input/output/total tokens, estimated attempts and failures, grouped by business date.',
  ],
  monthly: [
    'Usage by month',
    'Same measures grouped by business month within the selection. An incomplete month is not extrapolated.',
  ],
  providers: ['By provider'],
  models: ['By model'],
  keys: [
    'By key generation',
    'Provider slot, masked key ID and version. Different keys can reuse a slot and start at version 1. No key material; zero slot/version means unknown.',
  ],
  agentsUsage: ['By calling agent'],
  kinds: [
    'By call kind',
    'Chat, router, reasoning, voice (speech-to-text and TTS), vision and embeddings. Missing dimensions mean uninstrumented, not free.',
  ],
  funnel: [
    'Conversion funnel',
    'Distinct inbound contacts → new leads → quote_sent/quote_built events → non-cancelled orders → paid/delivered orders → rated review asks. Independent stage counts, not a tracked cohort; rates can exceed 100%. A zero denominator has no rate.',
  ],
  sources: [
    'Acquisition sources',
    'First source tag, then referral, tracked link or contact category. Count distinct inbound contacts, new leads, paid/delivered/completed orders and their value by source.',
  ],
  heatmap: [
    'Busiest hours',
    'Inbound message count by local weekday and wall-clock hour; the repeated DST hour combines both occurrences.',
  ],
  question: [
    'Top question topics',
    'Deterministic topic buckets for inbound messages with a question mark. Estimated topic classification, not question transcripts.',
  ],
  unanswered: [
    'Unanswered topics',
    'Topic buckets for recorded rag_miss events. Estimated categories; a retrieval miss is not proof no reply was sent.',
  ],
  intent: [
    'Routed intents',
    'Counts by the intent recorded by the tenant router; unrecognised labels become “other”.',
  ],
  objections: [
    'Repeated objections',
    'Objection attempts by fixed category (price, trust, timing, comparison); only categories occurring more than once in range.',
  ],
  experiments: [
    'Experiment results',
    'A/B sends and replies, sample target per arm, and the existing experimentResult verdict. Fewer than the target in either arm = too early.',
  ],
  accuracy: [
    'Accuracy scorecard',
    'Price mismatch, wrong language, forbidden text and cuts are guard detections; target zero. Blocked duplicates include superseded replies, not two messages sent. Handoffs, inbox owner replies and honesty disclosures count their recorded events. Owner edits/corrections are not instrumented.',
  ],
  review: [
    'Reply review votes',
    'Up/down vote rows in the selected range, separate from the current draft queue.',
  ],
  keyHealth: ['Key state', 'Active slot’s last recorded health and last use. No key or fingerprint.'],
  activeTenants: ['Active tenants', 'Count of tenant rows in active lifecycle state.'],
  tenants: [
    'Fleet health',
    'Per assistant: plan, lifecycle, worker snapshot age (overdue after 15 minutes), latest message or model attempt, monthly conversations left, unhealthy active keys, open incidents and trial end. Tenant handles cannot identify contacts.',
  ],
  providerTotals: [
    'Fleet usage',
    'Sum of retained tenant-local daily usage rollups by provider. Retention may differ by tenant.',
  ],
};
for (const k of ['badMac', 'sessionReset', 'absentMessage', 'retryFailed', 'outboundSent', 'outboundDelivered'])
  definitions[k][1] = 'Worker transport counter since process start; a restart resets the count.';
for (const k of ['providers', 'models', 'agentsUsage'])
  definitions[k][1] =
    'Calls, tokens, estimated calls and failures grouped by this recorded dimension over the selected dates.';
export const definitionFor = (page, key) => (page === 'leads' && key === 'leads' ? 'leadList' : key);
