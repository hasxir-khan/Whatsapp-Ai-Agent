const slug = document.querySelector('main').dataset.slug,
  base = '/api/platform/tenants/' + encodeURIComponent(slug) + '/reports/';
const csrf = () =>
  decodeURIComponent((document.cookie.match(/(?:^|;\s*)(?:__Host-)?wa_platform_csrf=([^;]+)/) || [])[1] || '');
const notice = document.getElementById('notice');
for (const a of document.querySelectorAll('.help'))
  a.onclick = () => {
    document.getElementById('glossary').open = true;
  };
for (const btn of document.querySelectorAll('[data-export]'))
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const res = await fetch(base + 'export' + location.search, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-platform-csrf': csrf() },
        body: JSON.stringify({ kind: btn.dataset.export, format: btn.dataset.format }),
      });
      if (!res.ok)
        throw new Error(
          res.status === 429
            ? 'Export limit reached. Please try again later.'
            : 'Export refused. Refresh your session and try again.',
        );
      const url = URL.createObjectURL(await res.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = slug + '-' + btn.dataset.export + '.' + btn.dataset.format;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notice.textContent = 'Export downloaded.';
    } catch (e) {
      notice.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };
const rate = document.getElementById('rate'),
  out = document.getElementById('estimate');
if (rate)
  rate.oninput = () => {
    out.textContent =
      rate.value !== '' && rate.validity.valid
        ? 'Estimated at your rate: ' +
          ((Number(rate.value) * Number(out.dataset.tokens)) / 1e6).toLocaleString(undefined, {
            maximumFractionDigits: 6,
          })
        : '';
  };
for (const b of document.querySelectorAll('[data-brief]'))
  b.onclick = async () => {
    const res = await fetch(base + 'brief/' + b.dataset.brief);
    if (!res.ok) {
      notice.textContent = 'Brief unavailable.';
      return;
    }
    const data = await res.json();
    const origin = data.origin || prompt('Your tenant’s HTTPS live-inbox origin (not the platform address):');
    if (!origin) return;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:' || u.username || u.password || u.origin === location.origin) throw Error();
      const a = document.createElement('a');
      a.href = u.origin + data.path;
      a.rel = 'noreferrer noopener';
      a.target = '_blank';
      a.textContent = 'Read collected fields in your authenticated live inbox';
      notice.replaceChildren(a);
      notice.scrollIntoView();
    } catch {
      notice.textContent = 'Enter a separate HTTPS inbox origin. Do not enter your token here.';
    }
  };
