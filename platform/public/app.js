// platform/public/app.js
// Everything the customer's dashboard does, in plain DOM.
//
// The API is the contract: each function here calls one documented endpoint and
// renders the answer. No framework, no bundler, no external script — the page
// has to work on a phone, on a cheap host, with nothing installed.

(function () {
  'use strict';

  var app = document.getElementById('app');
  var who = document.getElementById('who');
  var state = { me: null, plans: [], slug: null, tab: 'setup', chat: [], poll: null };

  // ── tiny helpers ──────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'text') node.textContent = value;
        else if (key === 'class') node.className = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function csrf() {
    return (document.cookie.match(/(?:^|;\s*)wa_platform_csrf=([^;]*)/) || [])[1] || '';
  }

  async function call(path, options) {
    var opts = options || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign(
        { 'x-platform-csrf': decodeURIComponent(csrf()) },
        opts.body ? { 'content-type': 'application/json' } : {},
        opts.headers || {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      location.href = '/platform/login';
      return { status: 401, data: {} };
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    return { status: res.status, data: data };
  }

  function say(message, kind) {
    var box = document.getElementById('flash');
    if (!box) return;
    box.textContent = message || '';
    box.className = kind === 'bad' ? 'error' : 'ok';
    box.hidden = !message;
  }

  function errText(data, fallback) {
    if (!data) return fallback;
    if (data.message) return data.message;
    if (Array.isArray(data.errors) && data.errors.length) return data.errors.join('\n');
    if (data.error) return String(data.error).replace(/_/g, ' ');
    return fallback;
  }

  function tenant() {
    return (state.me && state.me.tenants || []).filter(function (t) {
      return t.slug === state.slug;
    })[0];
  }

  // ── data ──────────────────────────────────────────────────
  async function load() {
    var res = await call('/api/platform/me');
    if (res.status !== 200) {
      app.innerHTML = '';
      app.appendChild(el('p', { class: 'error', text: errText(res.data, 'Could not load your account.') }));
      return;
    }
    state.me = res.data;
    if (!state.slug && state.me.tenants.length) state.slug = state.me.tenants[0].slug;
    who.textContent = state.me.account.email;
    var plans = await call('/api/platform/plans');
    state.plans = plans.data.plans || [];
    render();
  }

  async function loadTenant() {
    if (!state.slug) return;
    var res = await call('/api/platform/tenants/' + encodeURIComponent(state.slug));
    state.detail = res.status === 200 ? res.data : null;
  }

  // ── render ────────────────────────────────────────────────
  function render() {
    app.innerHTML = '';
    app.appendChild(el('h1', { text: 'Your assistants' }));
    app.appendChild(
      el('p', { class: 'lede', text: 'Set one up once. It answers on WhatsApp from then on.' })
    );
    app.appendChild(el('p', { id: 'flash', class: 'ok', hidden: 'hidden' }));

    if (state.me.notifications && state.me.notifications.length) {
      var notes = el('div', { class: 'card' });
      notes.appendChild(el('h2', { text: 'From us' }));
      state.me.notifications.slice(0, 5).forEach(function (note) {
        notes.appendChild(el('div', { class: 'notice' }, [el('b', { text: note.title }), el('div', { class: 'small', text: note.body || '' })]));
      });
      app.appendChild(notes);
    }

    app.appendChild(tenantList());
    app.appendChild(newTenantCard());
    if (state.slug) app.appendChild(paymentsCard());
    if (state.slug) app.appendChild(detailCard());
    app.appendChild(accountCard());
  }

  // Payments review, read-only. The bot owns the decisions; this card shows the
  // counts it wrote into the tenant's data folder (mounted mode) and says so
  // plainly when there is nothing to read (hosted mode).
  function paymentsCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('h2', { text: 'Payments' }));
    var box = el('div', { class: 'muted', text: 'Reading…' });
    card.appendChild(box);
    card.appendChild(
      el('p', {
        class: 'small',
        text: 'Read-only. Accepting or rejecting a proof is a person\'s act, done in WhatsApp with .accept, .reject or .partial.',
      })
    );
    call('/api/platform/tenants/' + encodeURIComponent(state.slug) + '/payments').then(function (res) {
      if (res.status !== 200) {
        box.textContent = 'Could not read payments.';
        return;
      }
      var d = res.data;
      if (!d.available || !d.summary) {
        box.textContent = d.hint || 'No payments summary yet.';
        return;
      }
      var s = d.summary;
      box.textContent =
        (s.pending || 0) + ' waiting · ' +
        (s.recheck || 0) + ' recheck · ' +
        (s.overdue || 0) + ' overdue · ' +
        (s.acceptedToday || 0) + ' accepted today, ' + (s.rejectedToday || 0) + ' rejected · ' +
        'avg ' + (s.avgDecisionMinutes === null || s.avgDecisionMinutes === undefined ? 'n/a' : s.avgDecisionMinutes + ' min');
    });
    return card;
  }

  function tenantList() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('h2', { text: 'Accounts' }));
    if (!state.me.tenants.length) {
      card.appendChild(el('p', { class: 'muted', text: 'No assistant yet. Create one below — it takes a minute.' }));
      return card;
    }
    var list = el('div', { class: 'tenant-list' });
    state.me.tenants.forEach(function (t) {
      list.appendChild(
        el('button', {
          class: 'tenant-card',
          type: 'button',
          'aria-current': t.slug === state.slug ? 'true' : null,
          onclick: function () {
            state.slug = t.slug;
            state.tab = 'setup';
            state.chat = [];
            loadTenant().then(render);
          },
        }, [
          el('b', { text: t.name }),
          el('div', { class: 'small', text: t.slug + ' · ' + t.status + (t.plan_id ? ' · ' + t.plan_id : '') }),
        ])
      );
    });
    card.appendChild(list);
    return card;
  }

  function newTenantCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('h2', { text: 'New assistant' }));
    var name = el('input', { placeholder: 'Business name', autocomplete: 'organization' });
    var number = el('input', { placeholder: 'WhatsApp number, e.g. 923001112233', inputmode: 'numeric' });
    var template = el('select', {});
    [{ id: '', name: 'Choose a template (optional)' }]
      .concat((state.me.templates || []).map(function (t) {
        return { id: t.id, name: t.name || t.id };
      }))
      .forEach(function (t) {
        template.appendChild(el('option', { value: t.id, text: t.name }));
      });
    var button = el('button', { class: 'primary', type: 'button', text: 'Create' });
    button.addEventListener('click', async function () {
      button.disabled = true;
      var res = await call('/api/platform/tenants', { body: { name: name.value, number: number.value, template: template.value || null } });
      button.disabled = false;
      if (res.status === 200 || res.status === 201) {
        state.slug = res.data.slug;
        state.tab = 'setup';
        await load();
        await loadTenant();
        render();
        say('Created. Step 1: tell us what kind of business this is.');
        if (res.data.secrets && res.data.secrets.length) {
          say('Created. Copy these now — they are shown once: ' + res.data.secrets.map(function (s) { return s.name; }).join(', '));
        }
      } else {
        say(errText(res.data, 'Could not create the assistant.'), 'bad');
      }
    });
    card.appendChild(el('div', { class: 'grid2' }, [name, number, template]));
    card.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [button]));
    card.appendChild(el('p', { class: 'small', text: 'One WhatsApp number per assistant. A number already in use is refused, not silently reassigned.' }));
    return card;
  }

  function tabs(active, items) {
    var box = el('div', { class: 'tabs', role: 'tablist' });
    items.forEach(function (item) {
      box.appendChild(
        el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': active === item.id ? 'true' : 'false',
          text: item.label,
          onclick: function () {
            state.tab = item.id;
            render();
          },
        })
      );
    });
    return box;
  }

  function detailCard() {
    var t = tenant();
    var card = el('div', { class: 'card' });
    card.appendChild(el('h2', { text: t ? t.name : state.slug }));
    if (!state.detail) {
      card.appendChild(el('p', { class: 'muted', text: 'Loading…' }));
      loadTenant().then(render);
      return card;
    }
    var d = state.detail;
    card.appendChild(
      el('div', { class: 'row' }, [
        el('span', { class: 'pill', text: d.tenant.status }),
        el('span', { class: 'pill', text: 'WhatsApp: ' + d.tenant.link_status }),
        el('span', { class: 'pill', text: 'plan: ' + (d.tenant.plan_id || '—') }),
        d.tenant.trial_ends_at ? el('span', { class: 'pill', text: 'trial ends ' + d.tenant.trial_ends_at.slice(0, 10) }) : null,
      ])
    );
    if (d.tenant.provision_error) {
      card.appendChild(el('div', { class: 'notice', text: 'Setup stopped: ' + d.tenant.provision_error }));
      var retry = el('button', { type: 'button', text: 'Retry setup' });
      retry.addEventListener('click', async function () {
        retry.disabled = true;
        var res = await call('/api/platform/tenants/' + state.slug + '/provision', { body: {} });
        retry.disabled = false;
        say(res.status === 200 ? 'Setup resumed.' : errText(res.data, 'Retry failed.'), res.status === 200 ? 'ok' : 'bad');
        await loadTenant();
        render();
      });
      card.appendChild(el('div', { class: 'row' }, [retry]));
    }

    card.appendChild(
      tabs(state.tab, [
        { id: 'setup', label: 'Setup' },
        { id: 'connect', label: 'WhatsApp' },
        { id: 'test', label: 'Test chat' },
        { id: 'usage', label: 'Usage' },
        { id: 'plan', label: 'Plan' },
        { id: 'settings', label: 'Settings' },
      ])
    );

    if (state.tab === 'setup') card.appendChild(stepPanel(d));
    if (state.tab === 'connect') card.appendChild(connectPanel(d));
    if (state.tab === 'test') card.appendChild(testPanel());
    if (state.tab === 'usage') card.appendChild(usagePanel(d));
    if (state.tab === 'plan') card.appendChild(planPanel(d));
    if (state.tab === 'settings') card.appendChild(settingsPanel(d));
    return card;
  }

  // ── wizard ────────────────────────────────────────────────
  var STEP_FIELDS = {
    'business-type': [
      { key: 'template', label: 'Template', type: 'select', options: null },
    ],
    'business-details': [
      { key: 'business.name', label: 'Business name', help: 'Exactly as customers know it.' },
      { key: 'business.city', label: 'City', help: 'Lets the assistant talk about delivery, pickup and timing.' },
      { key: 'business.hours', label: 'Hours', help: 'E.g. "Daily 12:00–23:00, closed Tuesdays".' },
      { key: 'business.languages', label: 'Languages', help: 'Comma separated, e.g. English, Urdu, Roman Urdu.' },
      { key: 'business.tone', label: 'Tone', help: 'E.g. warm and brief, or formal English.' },
    ],
    catalog: [
      { key: 'catalog', label: 'Products / services', type: 'json', help: 'One per line: name | price | note' },
      { key: 'faqs', label: 'FAQs', type: 'json', help: 'One per line: question | answer' },
      { key: 'payment.bank.name', label: 'Bank name', help: 'Shown when a customer asks how to pay.' },
      { key: 'payment.bank.number', label: 'Account number', help: 'Kept in your own profile, never sent to a model.' },
    ],
    documents: [
      { key: 'documents', label: 'Documents', type: 'file', help: 'PDF, DOCX, TXT or CSV, up to 5 MB.' },
    ],
    agents: [
      { key: 'conversation.handoverKeywords', label: 'Hand over when you hear', help: 'Comma separated words, e.g. refund, manager, complaint.' },
      { key: 'conversation.dailyMessageCap', label: 'Messages per customer per day', help: 'Blank uses the default of 40.' },
      { key: 'conversation.maxBotTurnsBeforeHuman', label: 'Turns before a human takes over', help: 'Blank uses the default of 12.' },
      { key: 'intake.fields', label: 'Questions it must ask', help: 'Comma separated, e.g. name, area, budget.' },
      { key: 'replyTiming', label: 'Reply timing', help: 'natural, instant, or business hours only.' },
    ],
    connect: [],
    test: [],
    live: [],
  };

  function stepPanel(d) {
    var box = el('div', {});
    var stepId = d.step || 1;
    var meta = (d.steps || []).filter(function (s) { return s.id === stepId; })[0] || d.steps[0];
    var stepsBar = el('div', { class: 'steps' });
    d.steps.forEach(function (s) {
      stepsBar.appendChild(
        el('span', {
          'data-state': s.id === stepId ? 'current' : s.id < stepId ? 'done' : 'todo',
          text: s.id + '. ' + s.title,
        })
      );
    });
    box.appendChild(stepsBar);
    box.appendChild(el('h2', { text: meta.title }));
    box.appendChild(el('p', { class: 'muted', text: meta.hint }));

    if (stepId === 6 || stepId === 7 || stepId === 8) {
      box.appendChild(
        el('p', {
          class: 'notice',
          text:
            stepId === 6
              ? 'Open the WhatsApp tab to scan the QR or link with a phone number.'
              : stepId === 7
                ? 'Open the Test chat tab. It uses the real assistant with a sandbox contact.'
                : 'When WhatsApp says connected, press Go live below.',
        })
      );
      if (stepId === 8) {
        var live = el('button', { class: 'primary', type: 'button', text: 'Go live' });
        live.addEventListener('click', async function () {
          live.disabled = true;
          var res = await call('/api/platform/tenants/' + state.slug + '/go-live', { body: {} });
          live.disabled = false;
          say(res.status === 200 ? 'Live. It is answering on WhatsApp now.' : errText(res.data, 'Could not go live.'), res.status === 200 ? 'ok' : 'bad');
          await load();
          await loadTenant();
          render();
        });
        box.appendChild(el('div', { class: 'row' }, [live]));
      }
      box.appendChild(nextButton(d, stepId));
      return box;
    }

    var fields = STEP_FIELDS[meta.key] || [];
    var inputs = {};
    fields.forEach(function (field) {
      var value = get(d.draft, field.key);
      if (field.type === 'file') {
        var file = el('input', { type: 'file' });
        var upload = el('button', { type: 'button', text: 'Upload' });
        upload.addEventListener('click', async function () {
          if (!file.files || !file.files[0]) return say('Choose a file first.', 'bad');
          upload.disabled = true;
          var res = await fetch('/api/platform/tenants/' + state.slug + '/documents', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'x-platform-csrf': decodeURIComponent(csrf()), 'x-file-name': file.files[0].name },
            body: file.files[0],
          });
          var data = await res.json().catch(function () { return {}; });
          upload.disabled = false;
          say(res.ok ? 'Learned "' + data.document.name + '".' : errText(data, 'Upload failed.'), res.ok ? 'ok' : 'bad');
          await loadTenant();
          render();
        });
        box.appendChild(el('label', { text: field.label }));
        box.appendChild(el('div', { class: 'row' }, [file, upload]));
        box.appendChild(el('p', { class: 'small', text: field.help }));
        var docs = (d.draft.documents || []);
        docs.forEach(function (doc) {
          box.appendChild(el('div', { class: 'doc', text: doc.name + ' · ' + Math.round(doc.bytes / 1024) + ' KB' + (doc.chunks ? ' · ' + doc.chunks + ' chunks' : '') }));
        });
        return;
      }

      var input;
      var raw = value === undefined || value === null ? '' : value;
      if (field.type === 'select') {
        input = el('select', {});
        [{ id: '', name: "I'll fill it in myself" }]
          .concat((d.templates || []).map(function (t) { return { id: t.id, name: t.name || t.id }; }))
          .forEach(function (option) {
            input.appendChild(el('option', { value: option.id, text: option.name }));
          });
        input.value = raw || '';
      } else if (field.type === 'json') {
        input = el('textarea', {});
        input.value = Array.isArray(raw) ? raw.map(serialiseLine).join('\n') : '';
      } else {
        input = el('input', {});
        if (Array.isArray(raw)) input.value = raw.join(', ');
        else input.value = raw;
      }
      inputs[field.key] = input;
      box.appendChild(el('label', { text: field.label }));
      box.appendChild(input);
      if (field.help) box.appendChild(el('p', { class: 'small', text: field.help }));
    });

    var save = el('button', { class: 'primary', type: 'button', text: 'Save and continue' });
    save.addEventListener('click', async function () {
      var patch = {};
      Object.keys(inputs).forEach(function (key) {
        var input = inputs[key];
        var value = input.value;
        if (input.tagName === 'TEXTAREA') value = parseLines(value);
        else if (key === 'business.languages' || key === 'conversation.handoverKeywords' || key === 'intake.fields') {
          value = value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else if (key.indexOf('conversation.') === 0 && /Cap|Turns/.test(key)) {
          value = value === '' ? undefined : Number(value);
        }
        if (value === undefined) return;
        set(patch, key, value);
      });
      // Shape the patch the way the wizard expects (business/catalog/…).
      var body = { step: stepId, patch: shapePatch(stepId, patch) };
      save.disabled = true;
      var res = await call('/api/platform/tenants/' + state.slug + '/wizard/' + stepId, { body: body });
      save.disabled = false;
      if (res.status === 200) {
        say(res.data.warnings && res.data.warnings.length ? 'Saved. ' + res.data.warnings[0] : 'Saved.');
        await loadTenant();
        render();
      } else {
        say(errText(res.data, 'Could not save that step.'), 'bad');
      }
    });
    box.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [save]));
    box.appendChild(nextButton(d, stepId));
    return box;
  }

  function shapePatch(stepId, flat) {
    var patch = {};
    Object.keys(flat).forEach(function (key) {
      var parts = key.split('.');
      if (parts[0] === 'catalog' || parts[0] === 'faqs' || parts[0] === 'documents' || parts[0] === 'replyTiming') {
        patch[parts[0]] = flat[key];
        return;
      }
      if (parts[0] === 'payment') {
        patch.payment = patch.payment || {};
        set(patch.payment, parts.slice(1).join('.'), flat[key]);
        return;
      }
      if (parts[0] === 'business' || parts[0] === 'conversation' || parts[0] === 'intake') {
        patch[parts[0]] = patch[parts[0]] || {};
        set(patch[parts[0]], parts.slice(1).join('.'), flat[key]);
        return;
      }
      patch[key] = flat[key];
    });
    if (stepId === 1 && patch.template !== undefined) patch.businessType = patch.template;
    return patch;
  }

  function nextButton(d, stepId) {
    var next = (d.steps || []).filter(function (s) { return s.id > stepId; })[0];
    if (!next) return el('span');
    var button = el('button', { type: 'button', text: 'Next: ' + next.title });
    button.addEventListener('click', async function () {
      await call('/api/platform/tenants/' + state.slug + '/wizard/' + stepId, { body: { step: stepId, patch: {} } });
      await loadTenant();
      state.detail.step = next.id;
      render();
    });
    return el('div', { class: 'row', style: 'margin-top:10px' }, [button]);
  }

  function get(obj, path) {
    return String(path).split('.').reduce(function (acc, key) {
      return acc && typeof acc === 'object' ? acc[key] : undefined;
    }, obj);
  }

  function set(obj, path, value) {
    var parts = String(path).split('.');
    var last = parts.pop();
    var cursor = obj;
    parts.forEach(function (part) {
      if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
      cursor = cursor[part];
    });
    cursor[last] = value;
  }

  function serialiseLine(item) {
    if (typeof item === 'string') return item;
    if (item && item.name) {
      var bits = [item.name];
      if (item.price !== undefined && item.price !== null) bits.push(item.price);
      if (item.note) bits.push(item.note);
      return bits.join(' | ');
    }
    return JSON.stringify(item);
  }

  function parseLines(text) {
    return String(text || '')
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean)
      .map(function (line) {
        var parts = line.split('|').map(function (p) { return p.trim(); });
        if (parts.length === 1) return parts[0];
        var item = { name: parts[0] };
        if (parts[1]) item.price = Number(parts[1].replace(/[^0-9.]/g, '')) || parts[1];
        if (parts[2]) item.note = parts[2];
        return item;
      });
  }

  // ── connect ───────────────────────────────────────────────
  function connectPanel(d) {
    var box = el('div', {});
    box.appendChild(el('p', { class: 'muted', text: 'WhatsApp → Linked devices. The QR changes every minute and is never cached.' }));
    var status = el('p', { class: 'small', text: 'Status: ' + d.tenant.link_status });
    box.appendChild(status);

    var qrBox = el('div', {});
    var pairBox = el('div', {});
    var qrButton = el('button', { type: 'button', text: 'Show QR' });
    qrButton.addEventListener('click', async function () {
      qrButton.disabled = true;
      var res = await call('/api/platform/tenants/' + state.slug + '/qr');
      qrButton.disabled = false;
      qrBox.innerHTML = '';
      if (res.status !== 200) return say(errText(res.data, 'No QR right now.'), 'bad');
      if (res.data.transport === 'cloud') {
        qrBox.appendChild(el('p', { class: 'small', text: 'Cloud API: no QR. Webhook URL: ' }));
        qrBox.appendChild(el('div', { class: 'mono', text: res.data.webhookUrl || res.data.webhookPath }));
        qrBox.appendChild(el('p', { class: 'small', text: res.data.verifyTokenSet ? 'Verify token is set on the server.' : 'Verify token is missing on the server.' }));
        return;
      }
      if (!res.data.qr) return qrBox.appendChild(el('p', { class: 'small', text: res.data.note || 'No QR right now.' }));
      var img = el('img', { alt: 'WhatsApp QR code', src: res.data.qr });
      qrBox.appendChild(el('div', { class: 'qr' }, [img]));
      qrBox.appendChild(el('p', { class: 'small', text: 'Expires in about a minute. Reload for a fresh one.' }));
    });

    var pairButton = el('button', { type: 'button', text: 'Link with phone number' });
    pairButton.addEventListener('click', async function () {
      pairButton.disabled = true;
      var res = await call('/api/platform/tenants/' + state.slug + '/pairing', { body: {} });
      pairButton.disabled = false;
      if (res.status !== 200) return say(errText(res.data, 'Could not start pairing.'), 'bad');
      say(res.data.note || 'Waiting for the code…');
      pairBox.innerHTML = '';
      pairBox.appendChild(el('p', { class: 'small', text: 'Waiting for the assistant to produce the code…' }));
      setTimeout(pollPairing, (res.data.pollAfterMs || 3500));
    });

    async function pollPairing() {
      var res = await call('/api/platform/tenants/' + state.slug + '/pairing/code');
      pairBox.innerHTML = '';
      if (res.status === 200 && res.data.code) {
        pairBox.appendChild(el('div', { class: 'code', text: res.data.code }));
        pairBox.appendChild(el('p', { class: 'small', text: res.data.note }));
      } else {
        pairBox.appendChild(el('p', { class: 'small', text: 'Not yet — this page can stay open.' }));
        setTimeout(pollPairing, 4000);
      }
    }

    var disconnect = el('button', { class: 'danger', type: 'button', text: 'Disconnect WhatsApp' });
    disconnect.addEventListener('click', async function () {
      if (!confirm('Disconnect this WhatsApp number? The assistant stops and the session is deleted.')) return;
      var res = await call('/api/platform/tenants/' + state.slug + '/disconnect', { body: {} });
      say(res.status === 200 ? 'Disconnected.' : errText(res.data, 'Could not disconnect.'), res.status === 200 ? 'ok' : 'bad');
      await loadTenant();
      render();
    });

    box.appendChild(el('div', { class: 'row' }, [qrButton, pairButton]));
    box.appendChild(qrBox);
    box.appendChild(pairBox);
    box.appendChild(el('div', { class: 'hr' }));
    box.appendChild(disconnect);
    return box;
  }

  // ── test chat ─────────────────────────────────────────────
  function testPanel() {
    var box = el('div', {});
    box.appendChild(el('p', { class: 'muted', text: 'This runs your real assistant against a sandbox contact. Nothing is sent to WhatsApp.' }));
    var log = el('div', { class: 'chat' });
    (state.chat || []).forEach(function (line) {
      log.appendChild(el('div', { class: line.who === 'me' ? 'msg me' : line.who === 'sys' ? 'sys' : 'msg bot', text: line.text }));
    });
    box.appendChild(log);
    var input = el('textarea', { placeholder: 'Ask what a customer would ask…' });
    var send = el('button', { class: 'primary', type: 'button', text: 'Send' });
    send.addEventListener('click', async function () {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      state.chat.push({ who: 'me', text: text });
      log.appendChild(el('div', { class: 'msg me', text: text }));
      send.disabled = true;
      var res = await call('/api/platform/tenants/' + state.slug + '/test-chat', { body: { text: text } });
      send.disabled = false;
      if (res.status !== 200) {
        state.chat.push({ who: 'sys', text: errText(res.data, 'The sandbox is not available.') });
        log.appendChild(el('div', { class: 'sys', text: errText(res.data, 'The sandbox is not available.') }));
        return;
      }
      if (!res.data.replies || !res.data.replies.length) {
        state.chat.push({ who: 'sys', text: '(no reply — check the assistant logs)' });
        log.appendChild(el('div', { class: 'sys', text: '(no reply — check the assistant logs)' }));
        return;
      }
      res.data.replies.forEach(function (reply) {
        state.chat.push({ who: 'bot', text: reply });
        log.appendChild(el('div', { class: 'msg bot', text: reply }));
      });
    });
    box.appendChild(input);
    box.appendChild(el('div', { class: 'row', style: 'margin-top:10px' }, [send]));
    return box;
  }

  // ── usage / plan / settings ───────────────────────────────
  function usagePanel(d) {
    var box = el('div', {});
    var t = (d.usage && d.usage.totals) || {};
    box.appendChild(
      el('div', { class: 'grid2' }, [
        el('div', { class: 'stat' }, [el('b', { text: String(t.calls || 0) }), el('span', { text: 'model calls this month' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(t.total_tokens || 0) }), el('span', { text: 'tokens' })]),
        el('div', { class: 'stat' }, [el('b', { text: String((d.usage && d.usage.conversations) || 0) }), el('span', { text: 'conversations' })]),
        el('div', { class: 'stat' }, [el('b', { text: String(t.estimated_calls || 0) }), el('span', { text: 'estimated (provider sent no numbers)' })]),
      ])
    );
    var rows = (d.usage && d.usage.kinds) || [];
    if (rows.length) {
      var table = el('table', { class: 'table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Kind' }), el('th', { text: 'Calls' }), el('th', { text: 'Tokens' })])]));
      var body = el('tbody');
      rows.forEach(function (row) {
        body.appendChild(el('tr', {}, [el('td', { text: row.kind }), el('td', { text: String(row.calls) }), el('td', { text: String(row.total_tokens) })]));
      });
      table.appendChild(body);
      box.appendChild(el('div', { class: 'hr' }));
      box.appendChild(table);
    }
    box.appendChild(el('p', { class: 'small', text: 'No message text is stored here — only counts, kinds, model names and latency.' }));
    return box;
  }

  function planPanel(d) {
    var box = el('div', {});
    box.appendChild(el('p', { class: 'muted', text: 'Plans set limits. There is no payment in this product yet — an admin assigns a plan by hand.' }));
    var list = el('div', { class: 'tenant-list' });
    (state.plans || []).forEach(function (plan) {
      var limits = plan.limits || {};
      list.appendChild(
        el('div', { class: 'tenant-card' }, [
          el('b', { text: plan.name }),
          el('div', { class: 'small', text: limits.conversations_month + ' conversations · ' + limits.agents + ' agents · ' + (limits.voice_minutes ? limits.voice_minutes + ' voice minutes' : 'no voice') }),
          el('div', { class: 'small', text: plan.id === d.tenant.plan_id ? 'current plan' : ' ' }),
        ])
      );
    });
    box.appendChild(list);
    if ((state.me.account && state.me.account.role) === 'admin') {
      var select = el('select', {});
      (state.plans || []).forEach(function (plan) {
        select.appendChild(el('option', { value: plan.id, text: plan.name }));
      });
      select.value = d.tenant.plan_id || 'free';
      var apply = el('button', { type: 'button', text: 'Assign' });
      apply.addEventListener('click', async function () {
        var res = await call('/api/platform/tenants/' + state.slug + '/plan', { body: { planId: select.value } });
        say(res.status === 200 ? 'Plan applied.' : errText(res.data, 'Could not change the plan.'), res.status === 200 ? 'ok' : 'bad');
        await loadTenant();
        render();
      });
      box.appendChild(el('div', { class: 'row' }, [select, apply]));
    }
    if (d.tenant.trial_ends_at) {
      box.appendChild(el('p', { class: 'small', text: 'Trial ends ' + d.tenant.trial_ends_at.slice(0, 10) + '. When it does, the assistant pauses — nothing is deleted.' }));
    }
    return box;
  }

  function settingsPanel(d) {
    var box = el('div', {});
    box.appendChild(el('p', { class: 'muted', text: 'Every setting is the same profile the wizard writes. Change it here any time.' }));
    var link = el('button', { type: 'button', text: 'Behaviour settings' });
    link.addEventListener('click', function () {
      state.tab = 'setup';
      state.detail.step = 5;
      render();
    });
    box.appendChild(el('div', { class: 'row' }, [link]));
    var danger = el('div', { class: 'card danger' });
    danger.appendChild(el('h2', { text: 'Delete this assistant' }));
    danger.appendChild(el('p', { class: 'small', text: 'Stops the bot and removes its folder. Export your account first — deletion is not reversible.' }));
    box.appendChild(el('div', { class: 'hr' }));
    box.appendChild(danger);
    return box;
  }

  function accountCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('h2', { text: 'Your account' }));
    card.appendChild(el('p', { class: 'small', text: 'Terms v' + state.me.consent.terms + ' · privacy v' + state.me.consent.privacy }));
    var exportButton = el('button', { type: 'button', text: 'Export my data' });
    exportButton.addEventListener('click', async function () {
      var res = await call('/api/platform/account/export', { body: {} });
      if (res.status !== 200) return say(errText(res.data, 'Export failed.'), 'bad');
      var blob = new Blob([JSON.stringify(res.data.export, null, 2)], { type: 'application/json' });
      var a = el('a', { href: URL.createObjectURL(blob), download: 'platform-account.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      say('Export downloaded. You can now delete the account for an hour.');
    });
    var deleteButton = el('button', { class: 'danger', type: 'button', text: 'Delete my account' });
    deleteButton.addEventListener('click', async function () {
      if (!confirm('Delete the account and every assistant under it? Export first.')) return;
      var res = await call('/api/platform/account/delete', { body: { confirm: 'DELETE' } });
      if (res.status === 200) {
        location.href = '/platform/login';
        return;
      }
      say(errText(res.data, 'Could not delete the account.'), 'bad');
    });
    card.appendChild(el('div', { class: 'row' }, [exportButton, deleteButton]));
    return card;
  }

  // ── boot ──────────────────────────────────────────────────
  var logout = document.getElementById('logout');
  if (logout) {
    logout.addEventListener('click', async function () {
      await call('/api/platform/logout', { body: {} });
      location.href = '/platform/login';
    });
  }

  load().then(loadTenant).then(render);
})();
