// platform/public/auth.js
// The sign-in, sign-up and reset pages. Plain DOM, same-origin fetches, and not
// one external request.

(function () {
  'use strict';

  var err = document.getElementById('err');
  var ok = document.getElementById('ok');

  function show(el, text) {
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  function fail(message) {
    show(ok, '');
    show(err, message || 'Something went wrong.');
  }

  function done(message) {
    show(err, '');
    show(ok, message || 'Done.');
  }

  async function api(path, body, method) {
    var res = await fetch(path, {
      method: method || 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    return { status: res.status, data: data };
  }

  function message(data, fallback) {
    if (!data) return fallback;
    if (data.message) return data.message;
    if (Array.isArray(data.errors) && data.errors.length) return data.errors.join('\n');
    if (data.error) return String(data.error).replace(/_/g, ' ');
    return fallback;
  }

  function busy(form, on) {
    if (!form) return;
    var buttons = form.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = !!on;
  }

  function where() {
    try {
      var next = new URLSearchParams(location.search).get('next');
      if (next && next.indexOf('/platform') === 0 && next.indexOf('//') !== 0) return next;
    } catch (e) {
      /* ignore */
    }
    return '/platform/app';
  }

  var login = document.getElementById('f');
  if (login && location.pathname === '/platform/login') {
    login.addEventListener('submit', async function (event) {
      event.preventDefault();
      busy(login, true);
      var res = await api('/api/platform/login', {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      });
      busy(login, false);
      if (res.status === 200) return (location.href = where());
      fail(message(res.data, 'Could not sign in.'));
    });
  }

  var signup = document.querySelector('#f');
  if (signup && location.pathname === '/platform/signup') {
    signup.addEventListener('submit', async function (event) {
      event.preventDefault();
      busy(signup, true);
      var email = document.getElementById('email').value;
      var res = await api('/api/platform/signup', {
        email: email,
        terms: document.getElementById('terms').checked,
        privacy: document.getElementById('privacy').checked,
      });
      busy(signup, false);
      if (res.status === 200) {
        sessionStorage.setItem('platform_email', email);
        return (location.href = '/platform/verify');
      }
      fail(message(res.data, 'Could not send a code.'));
    });
  }

  if (signup && location.pathname === '/platform/verify') {
    var stored = sessionStorage.getItem('platform_email');
    var field = document.getElementById('email');
    if (stored && field && !field.value) field.value = stored;
    signup.addEventListener('submit', async function (event) {
      event.preventDefault();
      busy(signup, true);
      var res = await api('/api/platform/signup/verify', {
        email: document.getElementById('email').value,
        code: document.getElementById('code').value,
        password: document.getElementById('password').value,
      });
      busy(signup, false);
      if (res.status === 200) return (location.href = '/platform/app');
      fail(message(res.data, 'That code was not right.'));
    });
  }

  var request = document.getElementById('f-request');
  if (request) {
    request.addEventListener('submit', async function (event) {
      event.preventDefault();
      busy(request, true);
      var res = await api('/api/platform/password/forgot', { email: document.getElementById('email').value });
      busy(request, false);
      if (res.status === 200) {
        var code = res.data && res.data.devCode ? ' Dev code: ' + res.data.devCode : '';
        return done('If that address has an account, a code is on its way.' + code);
      }
      fail(message(res.data, 'Could not send a code.'));
    });
  }

  var reset = document.getElementById('f-reset');
  if (reset) {
    reset.addEventListener('submit', async function (event) {
      event.preventDefault();
      busy(reset, true);
      var res = await api('/api/platform/password/reset', {
        email: document.getElementById('email').value,
        code: document.getElementById('code').value,
        password: document.getElementById('password').value,
      });
      busy(reset, false);
      if (res.status === 200) {
        done('Password changed. You can sign in now.');
        setTimeout(function () {
          location.href = '/platform/login';
        }, 900);
        return;
      }
      fail(message(res.data, 'That code was not right.'));
    });
  }
})();
