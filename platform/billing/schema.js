// Kept outside tenant databases. Only b_sub maps a random ledger ID to a tenant.
// Histories cannot be rewritten; scoped privacy erasure unlinks b_sub before purging.
export const billingSchema = [
  `CREATE TABLE IF NOT EXISTS b_plan (version INTEGER PRIMARY KEY AUTOINCREMENT, plan TEXT NOT NULL, revision INTEGER NOT NULL, spec TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(plan,revision))`,
  `CREATE TABLE IF NOT EXISTS b_config (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS b_sub (sid TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, opened TEXT NOT NULL, trial_end TEXT NOT NULL, opening_version INTEGER NOT NULL, observed TEXT NOT NULL, paused_reply INTEGER NOT NULL DEFAULT 0,wired INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS b_event (id INTEGER PRIMARY KEY AUTOINCREMENT,sid TEXT NOT NULL,at TEXT NOT NULL,op TEXT NOT NULL, version INTEGER,units INTEGER,source TEXT UNIQUE,undo INTEGER UNIQUE,wait_days INTEGER,reason TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS b_event_sid ON b_event(sid,id)`,
  `CREATE TABLE IF NOT EXISTS b_transition(id INTEGER PRIMARY KEY AUTOINCREMENT,sid TEXT NOT NULL,at TEXT NOT NULL,before_state TEXT,after_state TEXT NOT NULL,reason TEXT NOT NULL)`,
  ...['b_plan', 'b_event', 'b_transition'].flatMap((t) =>
    ['UPDATE', 'DELETE'].map(
      (op) =>
        `CREATE TRIGGER IF NOT EXISTS ${t}_${op} BEFORE ${op} ON ${t} ${op === 'DELETE' && t !== 'b_plan' ? 'WHEN EXISTS(SELECT 1 FROM b_sub WHERE sid=OLD.sid)' : ''} BEGIN SELECT RAISE(ABORT,'immutable'); END`
    )
  ),
  `CREATE TABLE IF NOT EXISTS b_sequence(year INTEGER,kind TEXT,last INTEGER NOT NULL,PRIMARY KEY(year,kind))`,
  `CREATE TABLE IF NOT EXISTS b_invoice(id TEXT PRIMARY KEY,sid TEXT NOT NULL,version INTEGER NOT NULL,months INTEGER NOT NULL,kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE,currency TEXT NOT NULL,subtotal INTEGER,tax_bps INTEGER NOT NULL,tax_label TEXT NOT NULL,total INTEGER,invoice_no TEXT UNIQUE,quote_no TEXT UNIQUE,at TEXT NOT NULL,grant_id INTEGER,request_id TEXT NOT NULL,basis TEXT,methods TEXT NOT NULL,UNIQUE(sid,request_id))`,
  `CREATE INDEX IF NOT EXISTS b_invoice_sid ON b_invoice(sid,at)`,
  // A submission/card is a claim, not money. Only confirmation inserts b_payment.
  `CREATE TABLE IF NOT EXISTS b_review(id TEXT PRIMARY KEY,invoice TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('review','more','rejected')),currency TEXT NOT NULL,reason TEXT,at TEXT NOT NULL,provider TEXT NOT NULL,external TEXT,UNIQUE(provider,external))`,
  `CREATE INDEX IF NOT EXISTS b_review_invoice ON b_review(invoice)`,
  `CREATE TABLE IF NOT EXISTS b_payment(id TEXT PRIMARY KEY,invoice TEXT NOT NULL,currency TEXT NOT NULL,amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),confirmed TEXT NOT NULL,receipt TEXT NOT NULL UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS b_payment_invoice ON b_payment(invoice)`,
  `CREATE TABLE IF NOT EXISTS b_reversal(payment TEXT PRIMARY KEY,at TEXT NOT NULL,reason TEXT NOT NULL)`,
  `CREATE VIEW IF NOT EXISTS b_confirmed AS SELECT p.* FROM b_payment p WHERE NOT EXISTS (SELECT 1 FROM b_reversal x WHERE x.payment=p.id)`,
  `CREATE VIEW IF NOT EXISTS b_card AS SELECT r.id,r.invoice,r.at,r.currency,r.provider,r.external,r.rowid seq,COALESCE(p.amount,0) amount,p.confirmed,p.receipt,x.at reversed,
    CASE WHEN x.payment IS NOT NULL THEN 'reversed' WHEN p.id IS NOT NULL THEN 'accepted' ELSE r.state END state,
    CASE WHEN x.payment IS NOT NULL THEN x.reason WHEN p.id IS NULL THEN r.reason END reason
    FROM b_review r LEFT JOIN b_payment p ON p.id=r.id LEFT JOIN b_reversal x ON x.payment=p.id`,
  `CREATE TRIGGER IF NOT EXISTS b_payment_fixed BEFORE UPDATE ON b_payment BEGIN SELECT RAISE(ABORT,'immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS b_payment_forget_only BEFORE DELETE ON b_payment WHEN EXISTS(SELECT 1 FROM b_invoice i JOIN b_sub s ON s.sid=i.sid WHERE i.id=OLD.invoice) BEGIN SELECT RAISE(ABORT,'immutable'); END`,
  `CREATE TABLE IF NOT EXISTS b_proof(id TEXT PRIMARY KEY,payment TEXT NOT NULL UNIQUE,sid TEXT NOT NULL,at TEXT NOT NULL,expires TEXT NOT NULL,digest TEXT NOT NULL,reference TEXT,fields TEXT NOT NULL,checks TEXT NOT NULL,risk TEXT NOT NULL,kind TEXT NOT NULL,purged INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS b_proof_hash ON b_proof(digest)`,
  `CREATE INDEX IF NOT EXISTS b_proof_ref ON b_proof(reference)`,
  `CREATE TABLE IF NOT EXISTS b_refund(id TEXT PRIMARY KEY,payment TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS b_delivery(id TEXT PRIMARY KEY,sid TEXT NOT NULL,kind TEXT NOT NULL,channel TEXT NOT NULL,object TEXT NOT NULL,state TEXT DEFAULT 'queued',lease TEXT,at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS b_delivery_state ON b_delivery(state,lease)`,
  `CREATE TABLE IF NOT EXISTS b_provider_event(provider TEXT,id TEXT,sid TEXT NOT NULL,PRIMARY KEY(provider,id))`,
  `CREATE TABLE IF NOT EXISTS b_churn(month TEXT,state TEXT,n INTEGER NOT NULL,PRIMARY KEY(month,state))`,
  `CREATE TABLE IF NOT EXISTS b_anonymous(month TEXT,currency TEXT,confirmed INTEGER NOT NULL DEFAULT 0,refunded INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(month,currency))`,
];
