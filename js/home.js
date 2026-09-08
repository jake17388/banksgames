/* Home screen: pick a name, pick a game, create or join a room. */

import { GAMES } from './games/registry.js';
import { getDisplayName, setDisplayName, hasName, getLastRoom } from './session.js';
import { createRoom, joinRoom, normalizeCode, isValidCode, readOnce, CODE_LENGTH } from './db.js';
import { el, toast, goToRoom, onAuthError } from './router.js';

export async function mountHome(container) {
  const screen = el('div', { class: 'screen' });
  const body = el('div', { class: 'screen-body' });
  screen.appendChild(body);
  container.appendChild(screen);

  body.appendChild(
    el('h1', { class: 'wordmark', text: 'Banks Games' })
  );
  body.appendChild(
    el('p', { class: 'tagline', text: 'Card and tile games for up to four people, over a room code.' })
  );

  const nameInput = el('input', {
    class: 'input',
    id: 'name-input',
    type: 'text',
    maxlength: '16',
    placeholder: 'Your name',
    autocomplete: 'nickname',
    autocapitalize: 'words',
    spellcheck: 'false',
    value: getDisplayName()
  });

  body.appendChild(
    el('label', { class: 'field', for: 'name-input' }, [
      el('span', { class: 'field-label', text: 'You are' }),
      nameInput
    ])
  );

  const nameHint = el('p', { class: 'hint', text: 'Saved on this device. Change it any time.' });
  body.appendChild(nameHint);

  // Firebase not configured (or unreachable): the screen still works, but say
  // plainly why nothing can be created or joined.
  const authBanner = el('p', { class: 'hint error' });
  authBanner.hidden = true;
  body.appendChild(authBanner);
  const stopAuthWatch = onAuthError((err) => {
    authBanner.textContent = err && err.message ? err.message : 'Could not sign in to Firebase.';
    authBanner.hidden = false;
  });

  body.appendChild(el('div', { class: 'section-label', text: 'Games' }));
  const grid = el('div', { class: 'game-grid' });
  body.appendChild(grid);

  const cards = [];
  for (const game of GAMES) {
    const card = el('button', { class: 'game-card', type: 'button' }, [
      el('span', { class: 'name', text: game.name }),
      el('span', { class: 'blurb', text: game.blurb }),
      el('span', {
        class: game.enabled ? 'tag live' : 'tag',
        text: game.enabled ? `${game.minPlayers}–${game.maxPlayers} players` : 'Coming soon'
      })
    ]);
    if (!game.enabled) {
      card.disabled = true;
    } else {
      card.addEventListener('click', () => {
        if (!hasName()) {
          toast('Pick a name first');
          nameInput.focus();
          return;
        }
        openGameSheet(game);
      });
    }
    cards.push({ card, game });
    grid.appendChild(card);
  }

  const last = getLastRoom();
  if (last) {
    body.appendChild(el('div', { class: 'section-label', text: 'Last room' }));
    body.appendChild(
      el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        text: `Back to ${last}`,
        onClick: () => {
          if (!hasName()) {
            toast('Pick a name first');
            nameInput.focus();
            return;
          }
          goToRoom(last);
        }
      })
    );
  }

  body.appendChild(
    el('p', {
      class: 'hint',
      text: 'Tip: add this page to your home screen and it runs fullscreen, no browser bars.'
    })
  );

  function syncEnabled() {
    const ok = hasName();
    for (const { card, game } of cards) {
      card.disabled = !game.enabled || !ok;
    }
    nameHint.textContent = ok
      ? 'Saved on this device. Change it any time.'
      : 'Enter a name to unlock the games.';
    nameHint.classList.toggle('warn', !ok);
  }

  nameInput.addEventListener('input', () => {
    setDisplayName(nameInput.value);
    syncEnabled();
  });
  nameInput.addEventListener('blur', () => {
    nameInput.value = getDisplayName();
  });

  syncEnabled();
  if (!hasName()) window.setTimeout(() => nameInput.focus(), 120);

  return () => {
    stopAuthWatch();
    closeSheet();
  };
}

/* --- bottom sheets -------------------------------------------------------- */

let sheetEl = null;

function closeSheet() {
  if (sheetEl && sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
  sheetEl = null;
}

function openSheet(title, subtitle, children) {
  closeSheet();
  const panel = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet-grip' }),
    el('h2', { text: title }),
    el('p', { class: 'sheet-sub', text: subtitle }),
    ...children
  ]);
  sheetEl = el('div', { class: 'sheet-backdrop' }, [panel]);
  sheetEl.addEventListener('click', (event) => {
    if (event.target === sheetEl) closeSheet();
  });
  document.body.appendChild(sheetEl);
  return panel;
}

function openGameSheet(game) {
  openSheet(game.name, `${game.minPlayers} to ${game.maxPlayers} players.`, [
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Create a room',
      onClick: () => doCreate(game)
    }),
    el('button', {
      class: 'btn btn-secondary',
      type: 'button',
      text: 'Join with a code',
      onClick: () => openJoinSheet(game)
    }),
    el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onClick: closeSheet })
  ]);
}

async function doCreate(game) {
  const button = sheetEl && sheetEl.querySelector('.btn-primary');
  if (button) {
    button.disabled = true;
    button.textContent = 'Creating…';
  }
  try {
    const code = await createRoom(game.id, getDisplayName());
    closeSheet();
    goToRoom(code);
  } catch (err) {
    console.error('[home] create failed', err);
    toast(err.message || 'Could not create a room');
    if (button) {
      button.disabled = false;
      button.textContent = 'Create a room';
    }
  }
}

function openJoinSheet(game) {
  const input = el('input', {
    class: 'input input-code',
    type: 'text',
    maxlength: String(CODE_LENGTH),
    placeholder: '••••',
    autocapitalize: 'characters',
    autocorrect: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: 'text',
    enterkeyhint: 'go'
  });

  const error = el('p', { class: 'hint error' });
  error.hidden = true;

  const submit = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: 'Join room',
    disabled: true
  });

  const panel = openSheet(`Join ${game.name}`, 'Four characters. No zeros, no letter O.', [
    input,
    error,
    submit,
    el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onClick: closeSheet })
  ]);

  function currentCode() {
    return normalizeCode(input.value);
  }

  input.addEventListener('input', () => {
    const code = currentCode();
    input.value = code;
    submit.disabled = !isValidCode(code);
    error.hidden = true;
    if (isValidCode(code)) input.blur();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && isValidCode(currentCode())) doJoin();
  });

  submit.addEventListener('click', doJoin);
  window.setTimeout(() => input.focus(), 120);

  async function doJoin() {
    const code = currentCode();
    if (!isValidCode(code)) return;
    submit.disabled = true;
    submit.textContent = 'Joining…';
    error.hidden = true;
    try {
      const meta = await readOnce(`rooms/${code}/meta`);
      if (!meta) throw new Error(`No room called ${code}.`);
      if (meta.gameId !== game.id) {
        throw new Error(`Room ${code} is playing a different game.`);
      }
      await joinRoom(code, getDisplayName(), game.maxPlayers);
      closeSheet();
      goToRoom(code);
    } catch (err) {
      console.error('[home] join failed', err);
      error.textContent = err.message || 'Could not join that room.';
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Join room';
    }
  }

  return panel;
}
