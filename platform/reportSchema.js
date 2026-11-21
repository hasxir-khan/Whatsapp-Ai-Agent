// Reporting has its own version and migration transaction. Core v2 DBs need no
// rebuild; materialisations can be regenerated without touching account data.
export const reportTables = [
  'r_days',
  'r_people',
  'r_facts',
  'r_cards',
  'r_state',
  'r_usage',
  'r_meter',
  'r_cursor',
];
export function migrateReports(db) {
  db.run('CREATE TABLE IF NOT EXISTS report_schema(version INTEGER PRIMARY KEY)');
  const version = db.exec('SELECT MAX(version) FROM report_schema')[0]?.values[0][0] || 0;
  if (version > 1) throw new Error('unsupported_report_schema');
  if (version === 1) return false;
  db.run(`CREATE TABLE r_days(slug TEXT,day TEXT,at TEXT,digest TEXT,events_complete INTEGER,PRIMARY KEY(slug,day));
  CREATE TABLE r_people(slug TEXT,day TEXT,who TEXT,first_at TEXT,owner INTEGER,bot INTEGER,bookings INTEGER,orders INTEGER,revenue REAL,response_ms REAL,outside INTEGER,source TEXT,PRIMARY KEY(slug,day,who));
  CREATE TABLE r_facts(slug TEXT,metric TEXT,day TEXT,hour INTEGER,a TEXT,b TEXT,n INTEGER,value REAL,PRIMARY KEY(slug,metric,day,hour,a,b));
  CREATE TABLE r_cards(slug TEXT,kind TEXT,day TEXT,at TEXT,contact TEXT,agent TEXT,type TEXT,outcome TEXT,order_ref INTEGER,data TEXT);
  CREATE INDEX r_cards_page ON r_cards(slug,kind,day,at);
  CREATE INDEX r_cards_contact ON r_cards(slug,kind,contact,day,at);
  CREATE INDEX r_cards_agent ON r_cards(slug,kind,agent,day,at);
  CREATE INDEX r_cards_outcome ON r_cards(slug,kind,outcome,day,at);
  CREATE INDEX r_cards_order ON r_cards(slug,kind,order_ref,day);
  CREATE TABLE r_state(slug TEXT PRIMARY KEY,zone TEXT,at TEXT,current TEXT);
  CREATE TABLE r_usage(slug TEXT,day TEXT,hour INTEGER,provider TEXT,model TEXT,agent TEXT,kind TEXT,slot INTEGER,version INTEGER,key_id TEXT,category TEXT,calls INTEGER,tokens INTEGER,estimated INTEGER,errors INTEGER,ms INTEGER,prompt INTEGER,completion INTEGER,last_error_at TEXT,PRIMARY KEY(slug,hour,day,provider,model,agent,kind,slot,version,key_id,category));
  CREATE TABLE r_meter(slug TEXT,day TEXT,who TEXT,PRIMARY KEY(slug,day,who));
  CREATE TABLE r_cursor(slug TEXT PRIMARY KEY,id INTEGER,zone TEXT,at TEXT,last_call TEXT,last_success TEXT);
  CREATE INDEX r_usage_provider ON r_usage(hour,day,provider);
  CREATE INDEX rpt_backfill ON usage_events(tenant,id);
  CREATE INDEX rpt_expire ON usage_events(tenant,created_at);
  CREATE INDEX r_facts_expire ON r_facts(slug,day);
  CREATE INDEX r_cards_expire ON r_cards(slug,day);
  CREATE INDEX r_usage_expire ON r_usage(slug,day);
  INSERT INTO report_schema VALUES(1);`);
  return true;
}
