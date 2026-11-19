// platform/views.js
// Server-rendered pages. No framework, no build step, no CDN — the same rule the
// BOT's dashboard follows, because a customer's login page should not phone a
// third party to look nice.
//
// The app itself (dashboard, wizard, settings) is one page plus /platform/app.js
// and /platform/app.css, both served from this origin.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const BASE_CSS = `
:root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --ink:#e9edf3; --muted:#9aa4b2;
  --line:#262b36; --accent:#3ddc97; --warn:#ffb454; --bad:#ff6b6b; --radius:14px; }
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f7fb; --panel:#ffffff; --ink:#141821; --muted:#5a6472; --line:#e2e6ee; --accent:#0f9d63; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color:var(--accent); }
header.top { padding:18px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; }
.brand { font-weight:650; letter-spacing:.2px; }
.wrap { max-width:960px; margin:0 auto; padding:28px 20px 72px; }
.narrow { max-width:440px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:20px; margin:0 0 18px; }
h1 { font-size:26px; margin:0 0 6px; letter-spacing:-.02em; }
h2 { font-size:19px; margin:0 0 10px; }
p.lede { color:var(--muted); margin:0 0 18px; }
label { display:block; font-size:14px; color:var(--muted); margin:12px 0 5px; }
input, select, textarea, button { font:inherit; }
input, select, textarea { width:100%; padding:11px 12px; border-radius:10px; border:1px solid var(--line);
  background:var(--bg); color:var(--ink); }
textarea { min-height:88px; resize:vertical; }
button { padding:11px 16px; border-radius:10px; border:1px solid var(--line); background:var(--panel);
  color:var(--ink); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#06120c; font-weight:650; }
button.ghost { background:transparent; }
button:disabled { opacity:.55; cursor:not-allowed; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.muted { color:var(--muted); font-size:14px; }
.error { color:var(--bad); font-size:14px; margin:10px 0 0; white-space:pre-wrap; }
.ok { color:var(--accent); font-size:14px; margin:10px 0 0; }
.pill { display:inline-block; padding:2px 9px; border-radius:999px; border:1px solid var(--line);
  font-size:12px; color:var(--muted); }
code, .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
.hr { height:1px; background:var(--line); margin:18px 0; }
`;

function page({ title, body, style = '', head = '', script = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${BASE_CSS}${style}</style>
${head}
</head>
<body>
${body}
${script}
</body>
</html>`;
}

function authShell({ title, lede, form, footer }) {
  return page({
    title: `${title} · Assistant platform`,
    body: `<header class="top"><span class="brand">Assistant platform</span></header>
<main class="wrap narrow">
  <div class="card">
    <h1>${esc(title)}</h1>
    <p class="lede">${lede}</p>
    ${form}
    <p class="error" id="err" hidden></p>
    <p class="ok" id="ok" hidden></p>
  </div>
  <p class="muted">${footer}</p>
</main>`,
  });
}

export function loginPage() {
  return authShell({
    title: 'Sign in',
    lede: 'Your assistant, your account.',
    form: `<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <div class="row" style="margin-top:16px">
    <button class="primary" type="submit">Sign in</button>
    <a href="/platform/signup">Create an account</a>
    <a href="/platform/reset">Forgot password</a>
  </div>
</form>`,
    footer: 'Six-digit sign-in codes are only ever for this account — never for WhatsApp.',
    script: '<script src="/platform/auth.js" defer></script>',
  });
}

export function signupPage() {
  return authShell({
    title: 'Create an account',
    lede: 'We email a six-digit code. That is how we know the address is yours.',
    form: `<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <label class="row" style="margin-top:14px;color:var(--ink);font-size:14px">
    <input type="checkbox" id="terms" style="width:auto"> <span>I accept the terms.</span>
  </label>
  <label class="row" style="color:var(--ink);font-size:14px">
    <input type="checkbox" id="privacy" style="width:auto"> <span>I have read the privacy notice.</span>
  </label>
  <div class="row" style="margin-top:16px"><button class="primary" type="submit">Send my code</button></div>
</form>`,
    footer: 'Already have an account? <a href="/platform/login">Sign in</a>',
    script: '<script src="/platform/auth.js" defer></script>',
  });
}

export function verifyPage({ email = '' } = {}) {
  return authShell({
    title: 'Check your email',
    lede: 'Enter the six-digit code and choose a password. The code expires in 10 minutes.',
    form: `<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" value="${esc(email)}" autocomplete="email" required>
  <label for="code">Six-digit code</label>
  <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
  <label for="password">Password (at least 10 characters)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <div class="row" style="margin-top:16px"><button class="primary" type="submit">Create my account</button></div>
</form>`,
    footer: 'Wrong address? <a href="/platform/signup">Start again</a>',
    script: '<script src="/platform/auth.js" defer></script>',
  });
}

export function resetPage() {
  return authShell({
    title: 'Reset your password',
    lede: 'We email a six-digit code. Nothing changes until you use it.',
    form: `<form id="f-request">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <div class="row" style="margin-top:16px"><button class="primary" type="submit">Email me a code</button></div>
</form>
<div class="hr"></div>
<form id="f-reset">
  <label for="code">Six-digit code</label>
  <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6">
  <label for="password">New password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10">
  <div class="row" style="margin-top:16px"><button type="submit">Set my password</button></div>
</form>`,
    footer: '<a href="/platform/login">Back to sign in</a>',
    script: '<script src="/platform/auth.js" defer></script>',
  });
}

export function appPage() {
  return page({
    title: 'Your assistants',
    body: `<header class="top">
  <span class="brand">Assistant platform</span>
  <span class="pill" id="who"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="logout" type="button">Sign out</button>
</header>
<main class="wrap" id="app">
  <p class="muted">Loading…</p>
  <noscript><p class="error">This page needs JavaScript. The API is JSON, so a script can do everything the page does.</p></noscript>
</main>`,
    head: '<link rel="stylesheet" href="/platform/app.css">',
    script: '<script src="/platform/app.js" defer></script>',
  });
}

/** Shown when PLATFORM_ENABLED is on but PLATFORM_SECRET is missing. */
export function misconfiguredPage() {
  return page({
    title: 'Platform not configured',
    body: `<main class="wrap narrow"><div class="card">
  <h1>Not configured</h1>
  <p class="lede">The platform is switched on but has no session secret, so it will not serve accounts.</p>
  <p class="muted">Set <code>PLATFORM_SECRET</code> to a long random string, then restart.</p>
</div></main>`,
  });
}

export function notFoundPage() {
  return page({
    title: 'Not found',
    body: `<main class="wrap narrow"><div class="card">
  <h1>Not here</h1>
  <p class="lede">That page does not exist.</p>
  <p><a href="/platform">Back to your assistants</a></p>
</div></main>`,
  });
}

export default {
  esc,
  loginPage,
  signupPage,
  verifyPage,
  resetPage,
  appPage,
  misconfiguredPage,
  notFoundPage,
};
