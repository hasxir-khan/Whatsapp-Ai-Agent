// Tenant-scoped dashboard controls. User/provider text is always a text node.
export function tenantControls({ el, call, errText, refresh, navigate, say }) {
  const small = (text) => el('p', { class: 'small', text });
  const row = (...children) => el('div', { class: 'row actions' }, children);
  const field = (label, input) => el('label', { class: 'field' }, [label, input]);
  const select = (options, value) => {
    const node = el('select', {}, options.map((o) => el('option', { value: o.id ?? o, text: o.label ?? o })));
    node.value = value ?? ''; return node;
  };
  function button(label, fn, disabled = false) {
    const b = el('button', { type: 'button', text: label, disabled });
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { if (b.isConnected) say(e.message || 'Request failed. Please try again.', 'bad'); }
      finally { b.disabled = disabled; }
    };
    return b;
  }
  const base = (d) => '/api/platform/tenants/' + encodeURIComponent(d.tenant.slug);
  const mutate = async (d, suffix, body = {}) => {
    const r = await call(base(d) + suffix, { body });
    if (!r.data.ok) throw new Error(errText(r.data, 'Could not save the change.'));
    return r.data;
  };
  function fetchPanel(d, suffix, draw) {
    const panel = el('div', { text: 'Loading…' });
    call(base(d) + suffix).then((r) => {
      panel.replaceChildren();
      if (r.status !== 200) panel.append(small(errText(r.data, 'Unavailable.')));
      else draw(panel, r.data);
    }).catch(() => { panel.textContent = 'Could not load this panel. Reopen the tab to retry.'; });
    return panel;
  }

  function overview(d) {
    const gate = d.checklist, c = d.connection;
    const box = el('section', { class: 'readiness' });
    box.append(el('h3', { text: 'Activation checklist' }), small(`${gate.done} of ${gate.total} required checks complete · AI: ${c.ai.health} · WhatsApp: ${c.whatsapp.state}`));
    c.alerts.forEach((a) => box.append(small(`${a.provider}, slot ${a.slot}: ${a.message}`)));
    if (c.lastModelCallAt) box.append(small('Last successful model call: ' + new Date(c.lastModelCallAt).toLocaleString()));
    const list = el('ul', { class: 'checks' });
    for (const i of gate.items) list.append(el('li', {}, [el('span', { text: `${i.ok ? '✓' : '○'} ${i.label}${i.required ? '' : ' (optional)'}` }),
      i.detail ? small(i.detail) : null, !i.ok && d.canEdit ? button('Open ' + i.action.tab, () => navigate(i.action.tab, i.action.step)) : null]));
    const details = el('details', { open: !gate.requiredComplete && d.tenant.status !== 'active' }, [el('summary', { text: 'View checks and next steps' }), list]);
    box.append(details);
    if (d.canEdit) {
      const action = d.tenant.status === 'active' ? 'pause' : d.tenant.status === 'paused' ? 'resume' : 'go-live';
      const disabled = action === 'resume' ? !gate.canResume : action === 'go-live' && !gate.canGoLive;
      box.append(row(button({ 'go-live': 'Go live', pause: 'Pause assistant', resume: 'Resume assistant' }[action], async () => {
        await mutate(d, '/' + action); await refresh(d, action === 'pause' ? 'Paused. Your setup and session are kept.' : 'Assistant started.');
      }, disabled)));
      if (c.pausedReason === 'trial_expired') box.append(small('Trial ended. Contact the platform owner to change your plan.'));
    }
    return box;
  }

  function keyPanel(d) {
    return fetchPanel(d, '/keys', (box, screen) => {
      box.append(el('h3', { text: 'Your AI keys' }), small('The assistant uses your provider account. Your key is write-only; only its last four characters are shown. A platform key pool is not available.'));
      for (const p of screen.providers) {
        const card = el('section', { class: 'control-block' }, [el('h3', { text: p.label })]);
        const help = el('details', {}, [el('summary', { text: 'How to get a key' }), el('ol', {}, p.help.map((text) => el('li', { text }))),
          row(el('a', { href: p.consoleUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open provider console' }), el('a', { href: p.termsUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Provider terms' })), small(p.freeTier)]);
        card.append(help);
        const paste = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', maxlength: 200, placeholder: p.keyHint });
        const take = () => { const value = paste.value.trim(); paste.value = ''; if (!value) throw new Error('Paste a key first.'); return value; };
        const active = screen.chain.filter((k) => k.provider === p.id && k.status === 'active');
        for (const k of active) {
          const slot = `${k === active[0] ? 'Primary' : 'Backup'} · slot ${k.slot} · ••••${k.last4}`;
          card.append(row(el('b', { text: slot }), el('span', { class: 'pill', text: k.health })), small(`Last tested: ${k.lastTestedAt || 'never'} · ${k.calls} calls · ${k.errors} errors`),
            row(button('Test saved key', async () => { const r = await call(base(d) + `/keys/${k.id}/test`, { body: {} }); await refresh(d, r.data.message || errText(r.data, 'Unavailable'), !r.data.ok); }),
              button('Replace with pasted key', async () => { if (!confirm(`Replace ${slot}?`)) return; const r = await mutate(d, `/keys/${k.id}/rotate`, { key: take() }); await refresh(d, r.note || 'Key rotated. Test it before going live.'); }),
              button('Revoke', async () => { if (!confirm(`Remove ${slot} from this assistant? Also revoke it at the provider if it was exposed.`)) return;
                const r = await mutate(d, `/keys/${k.id}/revoke`); await refresh(d, r.note || 'Removed from the assistant.'); })));
        }
        const revoked = screen.chain.filter((k) => k.provider === p.id && k.status === 'revoked');
        if (revoked.length) card.append(small('Revoked: ' + revoked.map((k) => `••••${k.last4}`).join(', ')));
        card.append(field('Paste a new or replacement key', paste), row(button(active.length ? 'Add backup' : 'Save primary key', async () => {
          await mutate(d, '/keys', { provider: p.id, key: take() }); await refresh(d, 'Saved. Use Test saved key to check it.');
        }, active.length >= screen.limits.perProvider)));
        box.append(card);
      }
      const providers = screen.providers.filter((p) => screen.chain.some((k) => k.provider === p.id && k.status === 'active'));
      if (!providers.length) return;
      const m = screen.model;
      const card = el('section', { class: 'control-block' }, [el('h3', { text: 'Model and compatibility' })]);
      const choices = providers.flatMap((p) => p.models.map((model) => ({ ...model, provider: p.id, label: `${p.label} · ${model.label}` })));
      const selected = select(choices.map((o, index) => ({ id: index, label: o.label })), Math.max(0, choices.findIndex((o) => o.provider === m.provider && o.id === m.model)));
      const chosen = () => ({ provider: choices[selected.value].provider, model: choices[selected.value].id });
      card.append(small(`Current model: ${m.model || 'not selected'}`), field('Supported models', selected), button('Use this model', async () => {
        const payload = chosen(); let r = await call(base(d) + '/model', { body: payload });
        if (r.data.error === 'compatibility_failed' && confirm('This model failed the check. It may invent prices or skip confirmations. Override and accept the risk?')) r = await call(base(d) + '/model', { body: { ...payload, override: true } });
        await refresh(d, r.data.ok ? 'Model saved.' : errText(r.data, 'Could not select model.'), !r.data.ok);
      }));
      const consent = el('input', { type: 'checkbox' });
      const check = button('Run compatibility check', async () => {
        if (!consent.checked) return;
        const r = await mutate(d, '/compatibility', { ...chosen(), consent: true });
        await refresh(d, `${r.status} on ${r.model}: ${Object.entries(r.categories).map(([k,v]) => `${k}: ${v.status}`).join(' · ')} (${r.calls} calls)`);
      });
      check.disabled = true; consent.onchange = () => { check.disabled = !consent.checked; };
      card.append(field(`I agree to spend up to ${screen.limits.compatCalls} calls on my key to test the selected model.`, consent), check);
      if (m.lastRun) {
        card.append(el('h4', { text: `Last result: ${m.lastRun.status}${m.override ? ' (owner override)' : ''}` }), small(`${m.lastRun.model} · ${new Date(m.lastRun.at).toLocaleString()}`));
        for (const [category, r] of Object.entries(m.lastRun.categories)) card.append(small(`${category}: ${r.status}${r.notes?.length ? ' — ' + r.notes.join('; ') : ''}`));
      }
      box.append(card);
    });
  }

  const examples = {
    timing: '{"targetMinMs":5000,"targetMaxMs":15000}', team: '[{"name":"Manager","number":"…","roles":["payments"]}]',
    chains: '{"payment":[{"who":"owner","afterMinutes":0}]}', reasons: '{"other":{"en":"Please send a clearer proof."}}',
  };
  function intakeEditor(initial, preset, disabled, mark) {
    const box = el('fieldset', { disabled }); let fields = initial || [];
    function draw() {
      box.replaceChildren(el('legend', { text: 'Intake questions (maximum 12)' }));
      fields.forEach((f, index) => {
        const group = el('div', { class: 'control-block' });
        for (const [k, label] of [['id','ID'],['label','Label'],['ask','Question'],['type','Answer type'],['choices','Choices (comma separated)'],['askIf','Only ask if (earlier ID = answer)']]) {
          const input = k === 'type' ? select(['text','choice','number','date','phone','address'], f.type || 'text') : el('input');
          if (k !== 'type') input.value = k === 'askIf' ? (f.askIf ? `${f.askIf.field} ${f.askIf.includes !== undefined ? '~' : '='} ${f.askIf.equals ?? f.askIf.includes ?? ''}` : '') : k === 'choices' ? (f.choices || []).join(', ') : f[k] || '';
          input.oninput = () => {
            if (k === 'choices') f[k] = input.value.split(',').map((v) => v.trim()).filter(Boolean);
            else if (k === 'askIf') { const m = /^([\w]+)\s*([=~])\s*(.+)$/.exec(input.value.trim()); f[k] = m ? { field: m[1], [m[2] === '=' ? 'equals' : 'includes']: m[3] } : input.value.trim() ? {} : null; }
            else f[k] = input.value;
            mark(fields);
          };
          group.append(field(label, input));
        }
        group.append(button('Remove question', () => { fields.splice(index, 1); mark(fields); draw(); })); box.append(group);
      });
      box.append(row(button('Add question', () => { fields.push({ type: 'text' }); mark(fields); draw(); }, fields.length >= 12),
        button('Use template questions', () => { fields = structuredClone(preset); mark(fields); draw(); })));
    }
    draw(); return box;
  }

  function settingsPanel(d) {
    return fetchPanel(d, '/settings', (box, settings) => {
      const patch = {}, readers = new Map();
      box.append(el('h3', { text: 'Behaviour settings' }), small('Changes go to your assistant’s profile. Saving a live assistant reloads its worker.'));
      function editor(group, e) {
        const disabled = !d.canEdit || e.disabled;
        if (e.type === 'timing') {
          const bounds = {};
          for (const [key, label] of [['targetMinMs','Shortest reply delay (ms)'],['targetMaxMs','Longest reply delay (ms)']]) {
            const input = el('input', { type:'number', min:0, max:60000, step:100, disabled });
            bounds[key] = e.value?.[key] ?? 0; input.value = bounds[key];
            input.oninput = () => { bounds[key] = input.value === '' ? null : Number(input.value); patch[e.id] = bounds; };
            group.append(field(label,input));
          }
          return;
        }
        if (e.type === 'team') {
          const members = e.value || [];
          const roster = el('fieldset', { disabled });
          function draw() {
            roster.replaceChildren(el('legend', { text:'People who can handle escalations' }));
            members.forEach((m,i) => {
              const card = el('div',{class:'control-block'});
              for (const [key,label] of [['name','Name'],['number','WhatsApp number'],['roles','Roles (comma separated)'],['hours','Working hours (09:00-17:00)']]) {
                const input = el('input'); input.value = Array.isArray(m[key]) ? m[key].join(', ') : m[key] || '';
                input.oninput = () => { m[key] = key === 'roles' ? input.value.split(',').map((s) => s.trim()).filter(Boolean) : input.value; patch[e.id] = members; };
                card.append(field(label,input));
              }
              card.append(button('Remove person',() => { members.splice(i,1); patch[e.id] = members; draw(); })); roster.append(card);
            });
            roster.append(button('Add person',() => { members.push({roles:['view']}); patch[e.id] = members; draw(); }));
          }
          draw(); group.append(roster); if (e.gate) group.append(small(e.gate.message)); return;
        }
        if (e.type === 'fields') { group.append(intakeEditor(e.value, settings.intakePreset, disabled, (v) => { patch[e.id] = v; })); return; }
        if (e.type === 'agent') {
          group.append(el('h4', { text: e.label }));
          for (const k of ['enabled','name','role','persona','instructions','hours','handoff']) editor(group, { ...e, id: `${e.id}.${k}`, label: k, type: k === 'enabled' ? 'bool' : k === 'role' ? 'enum' : 'string', options: settings.agentRoles, value: e.value[k] });
          return;
        }
        const json = Object.hasOwn(examples, e.type);
        const input = e.type === 'enum' ? select(e.options, e.value) : e.type === 'bool' ? el('input', { type: 'checkbox' }) : json ? el('textarea', { rows: 3, placeholder: examples[e.type] }) : el('input', { type: e.type === 'int' ? 'number' : 'text', min: e.min, max: e.max, maxlength: e.maxLength });
        if (e.type === 'bool') input.checked = e.value === true;
        else if (e.type !== 'enum') input.value = e.value == null ? '' : json ? JSON.stringify(e.value, null, 2) : Array.isArray(e.value) ? e.value.join(', ') : e.value;
        input.disabled = disabled;
        input.addEventListener('input', () => {
          readers.set(e.id, () => { if (json) { try { return JSON.parse(input.value); } catch { throw new Error(`${e.label}: enter valid JSON.`); } } return e.type === 'bool' ? input.checked : input.value; });
        });
        group.append(field(e.label, input));
        if (e.gate) group.append(small('Available on ' + e.gate.upgradeTo + '.'));
      }
      for (const g of settings.groups) {
        const group = el('details', { class: 'control-block' }, [el('summary', { text: g.id.charAt(0).toUpperCase() + g.id.slice(1) })]);
        if (!g.entries.length) group.append(small('No agents configured for this template.'));
        g.entries.forEach((e) => editor(group, e)); box.append(group);
      }
      if (d.canEdit) box.append(row(button('Save changes', async () => {
        for (const [id, read] of readers) patch[id] = read();
        const r = await mutate(d, '/settings', { patch }); await refresh(d, r.note || `${r.applied.length} settings saved. A backup was kept.`);
      }), button('Undo last change', async () => {
        if (!confirm('Undo the latest settings change for this assistant?')) return;
        await mutate(d, '/settings/undo'); await refresh(d, 'Latest change undone.');
      })));
    });
  }
  return { overview, keyPanel, settingsPanel };
}
