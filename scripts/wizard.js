// scripts/wizard.js
// Interactive business setup: ten questions, one owner.json.
//
// Works two ways:
//   node scripts/tenant.js setup ayesha-designs              (asks questions)
//   node scripts/tenant.js setup ayesha-designs --non-interactive --type salon --city Islamabad
//
// The non-interactive path exists so this is testable and scriptable — it is
// the same writer either way, and it never touches anything but owner.json.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { listTemplates, buildProfileFromTemplate, isTemplate } from '../src/services/templates.js';
import { validateProfile } from '../src/services/profile.js';

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function parseItems(lines) {
  const items = [];
  for (const line of lines) {
    const [name, price, extra] = String(line).split('|').map((s) => s.trim?.() ?? s);
    if (!name) continue;
    const num = Number(String(price || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(num) || num < 0) continue;
    const entry = { name, kind: 'service', price: num };
    if (extra) entry.description = extra;
    items.push(entry);
  }
  return items;
}

/**
 * @param {object} opts
 * @param {string} opts.dir absolute tenant folder
 * @param {object} opts.tenant { name, number, timezone }
 * @param {object} opts.flags CLI flags
 */
export async function runSetup({ dir, tenant, flags = {} }) {
  const interactive = !flags.nonInteractive && stdin.isTTY;
  const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;

  const ask = async (question, fallback = '') => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${question}${fallback ? c.dim(` [${fallback}]`) : ''}: `)).trim();
    return answer || fallback;
  };

  const pick = async (question, options, fallback) => {
    if (!rl) return fallback;
    console.log(`\n${question}`);
    options.forEach((opt, i) => console.log(`  ${c.bold(String(i + 1))}. ${opt.emoji || ''} ${opt.label} ${c.dim(opt.description || '')}`));
    const answer = (await rl.question(`Choose 1–${options.length} ${c.dim(`[${fallback}]`)}: `)).trim();
    if (!answer) return fallback;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index].id;
    return options.find((o) => o.id === answer.toLowerCase())?.id || fallback;
  };

  try {
    if (interactive) {
      console.log(`\n${c.bold('Business setup')} for ${c.bold(tenant.name)} ${c.dim(`(+${tenant.number})`)}`);
      console.log(c.dim('Ten questions. You can change everything later with .set, .addservice and .addfaq on WhatsApp.\n'));
    }

    const businessName = await ask('1. Business name', flags.name || tenant.name);
    const templates = listTemplates();
    const type = await pick('2. What kind of business is it?', templates, flags.type || 'generic');
    const template = isTemplate(type) ? type : 'generic';
    const tpl = buildProfileFromTemplate(template, { name: businessName });
    const defaultHours = tpl.business?.hours || '';

    const city = await ask('3. City', flags.city || '');
    const languagesRaw = await ask('4. Languages your customers speak (comma separated)', flags.languages || 'en, ur');
    const hours = await ask('5. Opening hours', flags.hours || defaultHours);

    // price list
    let items = tpl.catalog?.items || [];
    if (interactive) {
      console.log(`\n6. Price list — ${c.bold(String(items.length))} example items from the ${template} template:`);
      for (const item of items) {
        const price = item.price ?? (item.min !== undefined ? `${item.min}–${item.max}` : '—');
        console.log(`   • ${item.name} — ${price}`);
      }
      const keep = (await rl.question(`Keep these examples for now? ${c.dim('[Y/n]')}: `)).trim().toLowerCase();
      if (keep.startsWith('n')) {
        console.log(c.dim('Type your own, one per line as "Name | price". Blank line to finish.'));
        const lines = [];
        for (;;) {
          const line = (await rl.question('   > ')).trim();
          if (!line) break;
          lines.push(line);
        }
        const mine = parseItems(lines);
        if (mine.length) items = mine;
      }
    }

    const currency = await ask('7. Prices are in which currency?', flags.currency || 'PKR');
    const escalation = await ask('8. Number to hand over to when a human is needed', flags.escalation || tenant.number);
    const confirm = interactive ? (await rl.question(`\n9. Save this profile? ${c.dim('[Y/n]')}: `)).trim().toLowerCase() : 'y';
    if (confirm.startsWith('n')) {
      console.log(c.yellow('\nNothing saved.'));
      return { saved: false };
    }

    const profile = buildProfileFromTemplate(template, {
      name: businessName,
      brand: businessName,
      number: tenant.number,
      timezone: tenant.timezone || 'Asia/Karachi',
      city,
      languages: languagesRaw.split(',').map((s) => s.trim()).filter(Boolean),
      currency: currency || 'PKR',
      hours,
      escalationNumber: escalation,
    });
    profile.catalog = { items };
    profile.owner.bio =
      `${businessName} — ${String(profile.business.type).toLowerCase()}${city ? ` in ${city}` : ''}. ` +
      'EDIT ME: one or two honest sentences about this business, in the owner’s voice.';

    const { errors, warnings } = validateProfile(profile);

    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'owner.json');
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(configDir, 'owner.json.bak'));
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`);
    fs.renameSync(tmp, file);

    // make sure the wizard's own choices are the ones switched on
    const on = Object.entries(profile.features).filter(([, v]) => v === true).map(([k]) => k);
    console.log(`\n${c.green('✔')} Saved ${path.relative(process.cwd(), file)}`);
    console.log(`  Business : ${profile.business.name} (${profile.business.type})${city ? ` · ${city}` : ''}`);
    console.log(`  Hours    : ${profile.business.hours || '—'}`);
    console.log(`  Price list: ${items.length} items in ${currency}`);
    console.log(`  Escalates to: ${escalation || '—'}`);
    console.log(`  Features on: ${on.length ? on.join(', ') : c.dim('none')}`);
    if (warnings.length) {
      console.log(`\n${c.yellow('Notes')} ${c.dim('(not blocking — you can fix these later)')}`);
      for (const w of warnings) console.log(`  • ${w}`);
    }
    if (errors.length) {
      console.log(`\n${c.red('Please fix')}`);
      for (const e of errors) console.log(`  • ${e}`);
      return { saved: true, errors, warnings, profile };
    }

    console.log(`\n${c.dim('Next:')} restart this user's bot so the new profile is picked up,`);
    console.log(`  ${c.dim('node scripts/tenant.js show <slug> --start')}`);
    console.log(`  ${c.dim(`or add documents: node scripts/tenant.js learn <slug> menu.pdf`)}\n`);

    return { saved: true, errors, warnings, profile };
  } finally {
    rl?.close();
  }
}

export default { runSetup };
