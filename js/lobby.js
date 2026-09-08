/*
 * Room shell: presence, the player list, host controls, and the frame that a
 * game module renders itself into.
 *
 * This file knows nothing about any particular game. It reads minPlayers /
 * maxPlayers off the registry descriptor and, once meta.status flips to
 * "playing", hands a container and a `room` handle to the game module.
 *
 * The game module contract (js/games/<id>/ui.js):
 *   mount(container, room)   render the game, subscribe to state, submit moves
 *   unmount()                tear down every listener and timer
 *
 * The module — not the lobby — seeds the initial state. When it mounts as host
 * and finds no state, it deals. That way a host whose phone dies between
 * "Start" and the deal does not leave the room wedged: the next host deals.
 */

import { getGame } from './games/registry.js';
import { getDisplayName, hasName, setLastRoom } from './session.js';
import {
  ready,
  subscribe,
  readOnce,
  joinRoom,
  leaveRoom,
  claimHost,
  transactAt,
  removeAt
} from './db.js';
import { el, toast, goHome } from './router.js';

const HOST_STALE_MS = 20000;

export async function mountLobby(container, code) {
  const uid = await ready;

  if (!hasName()) {
    toast('Pick a name first');
    goHome();
    return () => {};
  }

  const meta0 = await readOnce(`rooms/${code}/meta`);
  if (!meta0) {
    throw new Error(`No room called ${code}. It may have been closed.`);
  }

  const descriptor = getGame(meta0.gameId);
  if (!descriptor) {
    throw new Error(`Room ${code} is playing "${meta0.gameId}", which this build does not have.`);
  }

  // Make sure we are actually seated before we start writing presence.
  const players0 = await readOnce(`rooms/${code}/players`);
  if (!players0 || !players0[uid]) {
    await joinRoom(code, getDisplayName(), descriptor.maxPlayers);
  }

  setLastRoom(code);

  /* --- DOM frame --------------------------------------------------------- */

  const screen = el('div', { class: 'screen' });
  const title = el('h1', { text: descriptor.name });
  const sub = el('span', { class: 'sub' });
  const leaveBtn = el('button', {
    class: 'btn btn-danger btn-sm',
    type: 'button',
    text: 'Leave'
  });
  const topbar = el('div', { class: 'topbar' }, [title, sub, leaveBtn]);
  const stage = el('div', { class: 'screen' });
  screen.appendChild(topbar);
  screen.appendChild(stage);
  container.appendChild(screen);

  /* --- live room data ---------------------------------------------------- */

  let meta = meta0;
  let players = {};
  let mountedGame = null;
  let mountedStatus = null;
  let destroyed = false;
  const playerListeners = new Set();

  const room = {
    code,
    playerId: uid,
    gameId: descriptor.id,
    descriptor,
    get meta() {
      return meta;
    },
    get players() {
      return seatedPlayers();
    },
    get isHost() {
      return !!meta && meta.hostId === uid;
    },
    onPlayers(callback) {
      playerListeners.add(callback);
      callback(seatedPlayers());
      return () => playerListeners.delete(callback);
    },
    statePath: `rooms/${code}/state`,
    subscribeState(callback, onError) {
      return subscribe(`rooms/${code}/state`, callback, onError);
    },
    /**
     * Read-modify-write the game state as one atomic operation.
     * `updater(currentState)` returns the new state or throws to reject.
     */
    async submitState(updater) {
      let thrown = null;
      const { committed } = await transactAt(`rooms/${code}/state`, (current) => {
        thrown = null;
        if (current === null || current === undefined) {
          thrown = new Error('The game state has not loaded yet.');
          return undefined;
        }
        try {
          return updater(current);
        } catch (err) {
          thrown = err;
          return undefined;
        }
      });
      if (thrown) throw thrown;
      if (!committed) throw new Error('That move was not accepted. Try again.');
    },
    /** Seed state only if there is none yet. Safe to call from every client. */
    async seedState(build) {
      let seeded = false;
      await transactAt(`rooms/${code}/state`, (current) => {
        if (current !== null && current !== undefined) return undefined;
        seeded = true;
        return build();
      });
      return seeded;
    },
    async replaceState(value) {
      await transactAt(`rooms/${code}/state`, () => value);
    },
    async setStatus(status) {
      await transactAt(`rooms/${code}/meta`, (current) => {
        if (!current) return undefined;
        current.status = status;
        return current;
      });
    },
    async backToLobby() {
      await removeAt(`rooms/${code}/state`);
      await room.setStatus('lobby');
    },
    leave: doLeave,
    toast
  };

  function seatedPlayers() {
    return Object.entries(players)
      .map(([playerId, p]) => ({
        playerId,
        name: p.name || 'Player',
        seat: typeof p.seat === 'number' ? p.seat : 0,
        online: p.online === true,
        lastSeen: p.lastSeen || 0
      }))
      .sort((a, b) => a.seat - b.seat);
  }

  /* --- presence ---------------------------------------------------------- */

  const { attachPresence } = await import('./db.js');
  const detachPresence = attachPresence(code, uid);

  const stopMeta = subscribe(
    `rooms/${code}/meta`,
    (value) => {
      if (destroyed) return;
      if (!value) {
        toast('That room was closed.');
        setLastRoom(null);
        goHome();
        return;
      }
      meta = value;
      render();
    },
    handleError
  );

  const stopPlayers = subscribe(
    `rooms/${code}/players`,
    (value) => {
      if (destroyed) return;
      players = value || {};
      for (const listener of playerListeners) listener(seatedPlayers());
      render();
    },
    handleError
  );

  function handleError(err) {
    console.error('[lobby] listener error', err);
    toast(err && err.code === 'PERMISSION_DENIED' ? 'Database rules rejected that read.' : 'Connection problem.');
  }

  leaveBtn.addEventListener('click', doLeave);

  async function doLeave() {
    if (destroyed) return;
    leaveBtn.disabled = true;
    try {
      await leaveRoom(code);
    } catch (err) {
      console.warn('[lobby] leave failed', err);
    }
    setLastRoom(null);
    goHome();
  }

  /* --- rendering --------------------------------------------------------- */

  function render() {
    if (destroyed || !meta) return;
    sub.textContent = code;

    const status = meta.status || 'lobby';

    if (status === 'lobby') {
      if (mountedGame) unmountGame();
      if (mountedStatus !== 'lobby') {
        stage.innerHTML = '';
        mountedStatus = 'lobby';
      }
      renderLobby();
      return;
    }

    if (mountedStatus !== 'playing') {
      stage.innerHTML = '';
      mountedStatus = 'playing';
      stage.appendChild(el('div', { class: 'boot' }, [el('div', { class: 'boot-msg', text: 'Loading game…' })]));
      mountGame();
    }
  }

  async function mountGame() {
    try {
      const mod = await descriptor.load();
      if (destroyed || mountedStatus !== 'playing') return;
      stage.innerHTML = '';
      mountedGame = mod;
      await mod.mount(stage, room);
    } catch (err) {
      console.error('[lobby] game module failed to mount', err);
      stage.innerHTML = '';
      stage.appendChild(
        el('div', { class: 'boot' }, [
          el('div', { class: 'boot-msg error', text: err.message || 'Could not load the game.' })
        ])
      );
    }
  }

  function unmountGame() {
    if (!mountedGame) return;
    try {
      if (typeof mountedGame.unmount === 'function') mountedGame.unmount();
    } catch (err) {
      console.warn('[lobby] game unmount failed', err);
    }
    mountedGame = null;
    mountedStatus = null;
  }

  function renderLobby() {
    const list = seatedPlayers();
    const isHost = room.isHost;
    const host = list.find((p) => p.playerId === meta.hostId);
    const hostStale =
      !!host && !host.online && Date.now() - (host.lastSeen || 0) > HOST_STALE_MS;

    stage.innerHTML = '';

    const body = el('div', { class: 'screen-body' });

    const plate = el('button', { class: 'code-plate', type: 'button' }, [
      el('div', { class: 'code-label', text: 'Room code' }),
      el('div', { class: 'code', text: code }),
      el('div', { class: 'code-hint', text: 'Tap to copy' })
    ]);
    plate.addEventListener('click', () => copyCode(code));
    body.appendChild(plate);

    body.appendChild(el('div', { class: 'section-label', text: `Players (${list.length}/${descriptor.maxPlayers})` }));

    const ul = el('ul', { class: 'player-list' });
    for (const p of list) {
      const roleBits = [];
      if (p.playerId === meta.hostId) roleBits.push('Host');
      roleBits.push(p.online ? 'Online' : 'Offline');
      ul.appendChild(
        el('li', { class: p.playerId === uid ? 'player-row me' : 'player-row' }, [
          el('span', { class: 'seat', text: String(p.seat + 1) }),
          el('span', { class: 'who' }, [
            el('div', { class: 'nm', text: p.name }),
            el('div', { class: 'role', text: roleBits.join(' · ') })
          ]),
          el('span', { class: p.online ? 'dot online' : 'dot' })
        ])
      );
    }
    for (let i = list.length; i < descriptor.maxPlayers; i += 1) {
      ul.appendChild(el('li', { class: 'empty-slot', text: 'Waiting for a player…' }));
    }
    body.appendChild(ul);

    if (hostStale && !isHost) {
      body.appendChild(
        el('p', { class: 'hint warn', text: `${host.name} has the host role but has been offline for a while.` })
      );
      body.appendChild(
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'Take over as host',
          onClick: async () => {
            const ok = await claimHost(code);
            toast(ok ? 'You are the host now' : 'Could not take over');
          }
        })
      );
    }

    body.appendChild(
      el('p', {
        class: 'hint',
        text: `Everyone opens ${window.location.origin}${window.location.pathname} and joins with ${code}.`
      })
    );

    const actions = el('div', { class: 'action-bar' });

    const shareBtn = el('button', {
      class: 'btn btn-secondary',
      type: 'button',
      text: 'Share the code'
    });
    shareBtn.addEventListener('click', () => shareRoom(code, descriptor.name));

    if (isHost) {
      const canStart = list.length >= descriptor.minPlayers;
      const startBtn = el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: canStart
          ? `Start ${descriptor.name}`
          : `Need ${descriptor.minPlayers - list.length} more player${
              descriptor.minPlayers - list.length === 1 ? '' : 's'
            }`
      });
      startBtn.disabled = !canStart;
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        try {
          await room.setStatus('playing');
        } catch (err) {
          console.error('[lobby] start failed', err);
          toast('Could not start the game');
          startBtn.disabled = false;
        }
      });
      actions.appendChild(startBtn);
    } else {
      const waiting = el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        text: host ? `Waiting for ${host.name} to start` : 'Waiting for the host'
      });
      waiting.disabled = true;
      actions.appendChild(waiting);
    }

    actions.appendChild(shareBtn);

    stage.appendChild(body);
    stage.appendChild(actions);
  }

  render();

  /* --- teardown ---------------------------------------------------------- */

  return () => {
    destroyed = true;
    unmountGame();
    stopMeta();
    stopPlayers();
    detachPresence();
    playerListeners.clear();
  };
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${code}`);
  } catch (err) {
    toast(`Room code: ${code}`);
  }
}

async function shareRoom(code, gameName) {
  const url = `${window.location.origin}${window.location.pathname}#/room/${code}`;
  const text = `Join my ${gameName} game on Banks Games. Room code ${code}.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Banks Games', text, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Invite copied');
  } catch (err) {
    toast(url);
  }
}
