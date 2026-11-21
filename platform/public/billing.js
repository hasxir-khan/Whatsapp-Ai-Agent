import { formatMinor } from './billing-money.js';
// All remote values enter the DOM as text, never HTML. Same-origin requests only.
(() => {
  const root = document.querySelector('#billing'),
    view = document.querySelector('#content'),
    notice = document.querySelector('#notice'),
    op = root.dataset.operator === '1',
    slug = root.dataset.slug,
    base = op ? '/api/platform/operator/billing' : '/api/platform/tenants/' + slug + '/billing';
  let state,
    filter = 'all',
    page = 1;
  const say = (t) => (notice.textContent = t);
  const el = (tag, text, parent) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (parent) parent.append(n);
    return n;
  };
  const section = (title, tag = 'section', parent = view) => {
    const n = el(tag, null, parent);
    el(tag === 'details' ? 'summary' : 'h2', title, n);
    return n;
  };
  const btn = (box, text, fn) => {
    const b = el('button', text, box);
    b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        say(e.message);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  function field(box, title, type = 'text', value = '') {
    const l = el('label', title, box),
      n = el(type === 'textarea' ? 'textarea' : 'input', null, l);
    if (type !== 'textarea') n.type = type;
    n.value = value;
    return n;
  }
  function select(box, title, list) {
    const n = el('select', null, el('label', title, box));
    n.setAttribute('aria-label', title);
    for (const [value, label] of list) {
      const o = el('option', label, n);
      o.value = value;
    }
    return n;
  }
  const link = (box, text, url) => {
    const a = el('a', text, box);
    a.href = url;
    return a;
  };
  const label = (k) => k.replaceAll('_', ' '),
    badge = (p, t) => (el('span', label(t), p).className = 'badge');
  const cash = (n, c) => (n == null ? 'not yet priced' : formatMinor(n, c));
  function date(t, zone = state.zone || 'UTC') {
    try {
      return (
        new Intl.DateTimeFormat(undefined, {
          timeZone: zone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(t)) +
        ' ' +
        zone
      );
    } catch {
      return new Date(t).toISOString();
    }
  }
  async function api(path = '', data) {
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      if (op) headers['X-Operator-CSRF'] = state.csrf;
      else
        headers['X-Platform-CSRF'] =
          (document.cookie.split('; ').find((x) => /^(?:__Host-)?wa_platform_csrf=/.test(x)) || '').split(
            '='
          )[1] || '';
    }
    const r = await fetch(base + path, {
      headers,
      method: data ? 'POST' : 'GET',
      body: data ? JSON.stringify(data) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw Error(label(j.error || 'request failed'));
    return j;
  }
  async function mutate(path, data) {
    await api(path, data);
    await load();
    say('Saved.');
  }
  async function load() {
    state = await api(op ? '?filter=' + filter + '&page=' + page : '');
    view.replaceChildren();
    (op ? operator : customer)();
  }
  const names = {
    conversations_month: 'Monthly conversations',
    videos_month: 'Monthly videos',
    voice_minutes: 'Voice minutes',
    team_members: 'Team seats (besides owner)',
    agents: 'Agents',
    numbers: 'WhatsApp numbers',
    tenants: 'Assistants',
    history_days: 'History (days)',
    dashboard_days: 'Dashboard range (days)',
    llm_calls_day: 'Daily AI calls',
  };
  function customer() {
    const e = state.entitlement,
      main = section(e.name + ' · version ' + e.revision);
    badge(main, e.state);
    el('p', 'Term ends ' + date(e.end) + '.', main);
    if (e.next) el('p', 'Scheduled plan version ' + e.next.version + ' from ' + date(e.next.start), main);
    if (!e.canRun)
      el('p', 'The assistant is paused. You can still review billing and export your data.', main);
    if (e.state === 'grace') el('p', 'Access continues until ' + date(e.until), main);
    if (e.deleteAt)
      el(
        'p',
        'Cancellation retention ends ' +
          date(e.pendingAt) +
          '; permanent deletion on ' +
          date(e.deleteAt) +
          '.',
        main
      );
    const caps = section('Usage and limits'),
      dl = el('dl', null, caps);
    for (const [k, limit] of Object.entries(e.limits)) {
      el('dt', names[k] || label(k), dl);
      const used = k === 'voice_minutes' ? Math.ceil(state.usage.voice_seconds / 60) : state.usage[k];
      el('dd', used == null ? limit : used + ' / ' + limit, dl);
    }
    el(
      'small',
      state.usage.reported
        ? 'Worker usage · ' + state.usage.month + ' UTC'
        : 'No worker usage reported for this UTC month yet.',
      caps
    );
    el(
      'p',
      'Enabled by plan: ' + (e.features.join(', ') || 'none') + '. Other optional features are locked.',
      caps
    );
    const terms = section('Plans and terms');
    el('p', state.policy, terms);
    el('p', state.timing, terms);
    el('small', state.terms + ' ' + state.refunds, terms);
    if (!state.owner) el('p', 'View only. Ask the owner to make billing changes.', terms);
    for (const p of state.catalog) {
      const card = el('article', null, terms);
      el('strong', p.name + ' · v' + p.revision, card);
      if (p.plan === 'free') {
        el('p', p.trialDays + ' free days once per account and number. No automatic charge.', card);
        continue;
      }
      const opts = Object.entries(p.offers).map(([n, v]) => [n, n + ' month(s) — ' + cash(v, p.currency)]);
      const term = select(card, 'Duration for ' + p.name, opts);
      if (!state.owner) continue;
      if (e.hasTerm && e.canRun && p.rank < e.rank && e.next?.version !== p.version) {
        btn(card, 'Schedule downgrade', () => mutate('/downgrade', { version: p.version }));
        continue;
      }
      const upgrade = e.hasTerm && e.canRun && p.rank > e.rank;
      btn(card, upgrade ? 'Request upgrade quote' : 'Choose ' + p.name, () =>
        mutate('/checkout', {
          version: p.version,
          months: Number(term.value),
          requestId: crypto.randomUUID(),
        })
      );
    }
    const items = section('Invoices, proofs and receipts');
    if (!state.invoices.length) el('p', 'No invoices yet.', items);
    for (const i of state.invoices) {
      const line = el('article', null, items);
      el('strong', i.plan + ' · ' + cash(i.total, i.currency), line);
      el('p', 'Balance: ' + cash(i.due, i.currency), line);
      badge(line, i.status);
      if (!state.owner) continue;
      if (i.quote) link(line, 'Quote ' + i.quote, base + '/quotes/' + i.id);
      if (i.number) link(line, 'Invoice ' + i.number, base + '/invoices/' + i.id);
      if (i.kind === 'upgrade')
        el(
          'p',
          i.total == null
            ? 'Wait for the operator to price the difference. Do not pay yet.'
            : 'Upgrade difference only; your period end does not change.',
          line
        );
      for (const p of i.payments) {
        el(
          'p',
          p.state === 'review'
            ? 'Thank you. Your proof is under review.'
            : label(p.state) + (p.message ? ' · ' + p.message : ''),
          line
        );
        if (p.receipt) link(line, 'Receipt ' + p.receipt, base + '/receipts/' + p.id);
        if (p.refunds.length) el('small', 'Refund recorded (no funds moved by this system).', line);
      }
      if (i.due > 0) {
        el('p', 'Transfer reference: ' + i.ref, line);
        for (const m of i.methods)
          el(
            'p',
            [m.method, m.receiver, m.alias, m.tail ? 'ending ' + m.tail : ''].filter(Boolean).join(' · '),
            line
          );
        if (i.tax) el('small', i.taxLabel + ': ' + cash(i.tax, i.currency), line);
        const tx = field(
          line,
          'Redacted proof text (include amount, currency, receiver, date and bank reference)',
          'textarea'
        );
        const f = field(line, 'Optional redacted image or PDF (2 MiB max)', 'file');
        f.accept = 'image/png,image/jpeg,application/pdf';
        el(
          'small',
          'First-page PDF text or local image OCR is used if readable. Otherwise transcribe the visible fields. Only a masked evidence copy and fingerprint are retained. Never send card details.',
          line
        );
        btn(line, 'Submit proof', async () => {
          let file;
          if (f.files[0]) {
            if (f.files[0].size > 2097152) throw Error('File is too large.');
            file = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result.split(',')[1]);
              r.onerror = () => reject(Error('Could not read file.'));
              r.readAsDataURL(f.files[0]);
            });
          }
          await mutate('/invoices/' + i.id + '/proof', { text: tx.value, file });
          say('Thank you. Your payment is under review.');
        });
      }
    }
    const access = section('Cancellation and data');
    if (state.owner) {
      if (!e.canceling) {
        const r = select(
          access,
          'Optional cancellation reason',
          ['unspecified', 'price', 'not_needed', 'missing_feature', 'other'].map((v) => [v, label(v)])
        );
        btn(
          access,
          e.end > new Date().toISOString() ? 'Cancel at period end' : 'Cancel and start retention',
          () => mutate('/cancel', { reason: r.value })
        );
      }
      if (e.state === 'cancel_at_period_end') btn(access, 'Resume subscription', () => mutate('/resume', {}));
      btn(
        access,
        e.pausedReply ? 'Make paused assistant silent' : 'Allow a brief handover while paused',
        () => mutate('/paused_reply', { enabled: !e.pausedReply })
      );
      link(access, 'Account data export', '/platform/app#account-data');
      if (e.state === 'pending_deletion') {
        const confirm = field(access, 'Export first. Type ' + slug + ' to permanently delete this assistant');
        btn(access, 'Permanently delete', async () => {
          await api('/delete', { confirm: confirm.value });
          location.assign('/platform/app');
        });
      }
    }
    for (const t of state.transitions) el('p', date(t.at) + ' · ' + label(t.after_state), access);
  }
  function reasons(box, values) {
    return select(box, 'Reason', [
      ['', 'Choose a reason'],
      ...values.map((x) => (typeof x === 'string' ? [x, label(x)] : [x.code, x.label])),
    ]);
  }
  function operator() {
    const queue = section('Manual review queue');
    el('p', 'Check the receiving bank ledger yourself. A matching proof is not confirmation.', queue);
    for (const q of state.quotes) {
      const row = el('article', null, queue);
      el('strong', q.slug + ' · ' + q.quote_no + ' · ' + q.plan, row);
      const diff = field(row, 'Upgrade difference (' + q.currency + ' minor units)', 'number');
      btn(row, 'Issue upgrade invoice', () =>
        mutate('/' + q.slug + '/invoices/' + q.id + '/price', { difference: Number(diff.value) })
      );
    }
    if (!state.cards.length) el('p', 'No submitted payments.', queue);
    for (const p of state.cards) {
      const card = el('article', null, queue),
        prefix = '/' + p.slug + '/payments/' + p.id + '/';
      el('strong', p.slug + ' · ' + p.invoice_no, card);
      el('p', 'Reference ' + p.ref + ' · balance ' + cash(p.due, p.currency), card);
      badge(card, p.state);
      if (p.overdue) badge(card, 'review overdue');
      if (p.risk) el('p', 'Checks: ' + label(p.risk), card);
      for (const c of p.checks) el('small', c.label + ' — ' + c.status + '; ', card);
      if (p.proof && !p.purged) {
        btn(card, 'Read masked proof', async () => {
          const proof = await api('/' + p.slug + '/proofs/' + p.proof);
          el('pre', JSON.stringify(proof, null, 2), card);
        });
        btn(card, 'Recheck', () => mutate('/' + p.slug + '/proofs/' + p.proof + '/recheck', {}));
      }
      if (p.state === 'review' || p.state === 'more') {
        const amount = field(card, 'Confirmed amount (' + p.currency + ' minor units)', 'number'),
          r = reasons(card, state.reasons);
        btn(card, 'Confirm received money', () =>
          mutate(prefix + 'accept', { amount: Number(amount.value), currency: p.currency })
        );
        btn(card, 'Request more information', () => mutate(prefix + 'more', { reason: r.value }));
        btn(card, 'Reject with next step', () => mutate(prefix + 'reject', { reason: r.value }));
      }
      if (p.receipt) {
        el('p', 'Confirmed: ' + cash(p.amount, p.currency) + ' · ' + p.receipt, card);
        const r = reasons(card, state.opsReasons);
        if (p.state === 'accepted')
          btn(card, 'Reverse confirmation', () => mutate(prefix + 'reverse', { reason: r.value }));
        const amount = field(card, 'Refund record (minor units)', 'number');
        btn(card, 'Record refund only', () =>
          mutate(prefix + 'refund', {
            reason: r.value,
            amount: Number(amount.value),
            currency: p.currency,
            requestId: crypto.randomUUID(),
          })
        );
      }
    }
    if (page > 1)
      btn(queue, 'Previous review page', async () => {
        page--;
        await load();
      });
    if (state.more)
      btn(queue, 'Next review page', async () => {
        page++;
        await load();
      });
    const subs = section('Subscriptions'),
      f = select(
        subs,
        'Filter',
        ['all', 'expiring', 'trial-ending', 'grace', 'paused', 'pending_deletion'].map((v) => [v, label(v)])
      );
    f.value = filter;
    f.onchange = () => {
      filter = f.value;
      load().catch((e) => say(e.message));
    };
    for (const s of state.subscriptions) {
      const row = section(s.slug + ' · ' + s.name + ' · ' + label(s.state), 'details', subs);
      el('p', 'Term ends ' + date(s.end, 'UTC'), row);
      const r = reasons(row, state.opsReasons),
        v = select(
          row,
          'Plan version',
          state.catalog.map((p) => [p.version, p.name + ' v' + p.revision])
        ),
        n = field(row, 'Days to extend, or months to comp', 'number');
      for (const [act, title] of [
        ['extend', 'Extend days'],
        ['comp', 'Comp term'],
        ['change', 'Change plan now'],
      ])
        btn(row, title, () =>
          mutate('/' + s.slug + '/subscriptions/' + act, {
            units: Number(n.value),
            version: Number(v.value),
            reason: r.value,
            requestId: crypto.randomUUID(),
          })
        );
    }
    const reports = section('Revenue and cancellations');
    if (!state.revenue.length) el('p', 'No confirmed revenue.', reports);
    for (const r of state.revenue)
      el('p', r.month + ' · ' + cash(r.confirmed, r.currency) + ' confirmed, excluding reversals.', reports);
    for (const r of state.churn) el('p', r.month + ' · ' + label(r.after_state) + ': ' + r.n, reports);
    const plans = section('Publish a plan version', 'details');
    el(
      'p',
      'Clone a version below. Use a new plan key and a positive rank for a paid plan. Each offer maps a number of calendar months to a positive integer minor-unit price. Publishing does not edit purchased versions.',
      plans
    );
    const sel = select(
      plans,
      'Copy plan',
      state.catalog.map((p) => [p.version, p.name])
    );
    const editor = field(plans, 'Plan specification', 'textarea');
    function fill() {
      const { version, revision, ...spec } = state.catalog.find((p) => p.version === +sel.value);
      editor.value = JSON.stringify(spec, null, 2);
    }
    fill();
    sel.onchange = fill;
    el('small', 'Available features: ' + state.featureKeys.join(', '), plans);
    btn(plans, 'Publish immutable version', () => mutate('/plans', JSON.parse(editor.value)));
    const cfg = section('Payment instructions and policy', 'details');
    el(
      'p',
      'Methods contain method, receiver, payment alias and last four (tail) only. Never enter a full account or card number. Tax is optional, not tax advice.',
      cfg
    );
    const conf = field(cfg, 'Billing configuration', 'textarea', JSON.stringify(state.settings, null, 2));
    btn(cfg, 'Save policy', () => mutate('/settings', JSON.parse(conf.value)));
    const aud = section('Billing audit', 'details');
    for (const a of state.audit)
      el(
        'p',
        date(a.created_at, 'UTC') +
          ' · ' +
          a.action +
          (a.tenant ? ' · ' + a.tenant : '') +
          (a.detail ? ' · ' + a.detail : ''),
        aud
      );
  }
  load().catch((e) => say(e.message));
})();
