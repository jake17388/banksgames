/*
 * Hash routing. No page reloads, no server rewrites, works fine from a
 * subdirectory on GitHub Pages.
 *
 *   #/            home
 *   #/room/ABCD   lobby (and, once the host starts, the game surface)
 */

import { ready, normalizeCode, isValidCode } from './db.js';

const appEl = () => document.getElementById('app');

let currentTeardown = null;
let currentKey = null;
let booted = false;

export function parseHash(hash) {
  const raw = (hash || window.location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'room' && parts[1]) {
    const code = normalizeCode(parts[1]);
    if (isValidCode(code)) return { name: 'room', code };
    return { name: 'home' };
  }
  return { name: 'home' };
}

export function navigate(hash) {
  if (window.location.hash === hash) {
    render();
    return;
  }
  window.location.hash = hash;
}

export function goHome() {
  navigate('#/');
}

export function goToRoom(code) {
  navigate(`#/room/${code}`);
}

async function render() {
  const route = parseHash();
  const key = route.name === 'room' ? `room:${route.code}` : 'home';

  // Re-rendering the same room would tear down a live game for no reason.
  if (key === currentKey) return;
  currentKey = key;

  if (currentTeardown) {
    try {
      currentTeardown();
    } catch (err) {
      console.warn('[router] teardown failed', err);
    }
    currentTeardown = null;
  }

  const container = appEl();
  container.innerHTML = '';

  try {
    if (route.name === 'room') {
      const mod = await import('./lobby.js');
      currentTeardown = await mod.mountLobby(container, route.code);
    } else {
      const mod = await import('./home.js');
      currentTeardown = await mod.mountHome(container);
    }
  } catch (err) {
    console.error('[router] could not render', route, err);
    currentKey = null;
    showFatal(err);
  }
}

function showFatal(err) {
  const container = appEl();
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'boot';
  wrap.innerHTML = `
    <div class="boot-mark">Banks Games</div>
    <div class="boot-msg error"></div>
  `;
  wrap.querySelector('.boot-msg').textContent = err && err.message ? err.message : String(err);
  const back = document.createElement('button');
  back.className = 'btn btn-secondary btn-sm';
  back.textContent = 'Back to start';
  back.addEventListener('click', () => {
    currentKey = null;
    goHome();
    render();
  });
  wrap.appendChild(back);
  container.appendChild(wrap);
}

export async function startRouter() {
  if (booted) return;
  booted = true;

  // Paint the first screen without waiting on the network. Anonymous auth
  // resolves in the background; the screens that actually need it (anything
  // that talks to a room) await `ready` themselves.
  window.addEventListener('hashchange', render);
  await render();

  ready.catch((err) => {
    console.error('[boot] auth failed', err);
    authError = err;
    for (const listener of authListeners) listener(err);
  });
}

/* --- auth failure, surfaced by whichever screen is showing ---------------- */

let authError = null;
const authListeners = new Set();

export function onAuthError(callback) {
  if (authError) callback(authError);
  authListeners.add(callback);
  return () => authListeners.delete(callback);
}

/* --- shared UI helpers used by every screen ------------------------------- */

let toastTimer = null;

export function toast(message, ms) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, ms || 2400);
}

/** Small tagged-template-free element builder; keeps the screens readable. */
export function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
