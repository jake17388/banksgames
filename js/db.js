/*
 * Firebase wiring + every read/write the app performs.
 *
 * Rule of the house: nothing touches the database before anonymous auth has
 * resolved. Every exported helper awaits `ready` first, so a "permission
 * denied" in the console means your rules are wrong, not that you raced auth.
 */

import { firebaseConfig, isPlaceholderConfig } from './firebaseconfig.js';
import { setPlayerId } from './session.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O, 0, I, 1
export const CODE_LENGTH = 4;

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

/*
 * The Firebase SDK is imported lazily, on purpose.
 *
 * A static import of the CDN would make this module — and therefore the home
 * screen — fail to load whenever gstatic.com is slow, blocked, or simply
 * offline. The service worker cannot cache cross-origin modules, so that would
 * mean the installed app shows nothing at all on a bad connection. Loading it
 * on demand lets the app paint first and fail only where Firebase is actually
 * needed.
 */
let sdkPromise = null;

function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    let appMod;
    let authMod;
    let dbMod;
    try {
      [appMod, authMod, dbMod] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-database.js`)
      ]);
    } catch (err) {
      console.error('[db] could not load the Firebase SDK', err);
      throw new Error('Could not reach Firebase. Check your connection and reload.');
    }

    const app = appMod.initializeApp(firebaseConfig);
    return { app, auth: authMod.getAuth(app), db: dbMod.getDatabase(app), authMod, dbMod };
  })();
  return sdkPromise;
}

let handles = null;
let uid = null;

/** Resolves with the anonymous auth UID. Everything else waits on this. */
export const ready = (async () => {
  if (isPlaceholderConfig()) {
    throw new Error(
      'Firebase is not configured yet. Paste your real config into js/firebaseconfig.js.'
    );
  }

  handles = await loadSdk();
  const { auth, authMod } = handles;

  const existing = await new Promise((resolve) => {
    const stop = authMod.onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });

  const user = existing || (await authMod.signInAnonymously(auth)).user;
  uid = user.uid;
  setPlayerId(uid);
  return uid;
})();

// Every consumer handles this rejection itself (the router surfaces it on the
// home screen). This no-op keeps the browser from also logging it as an
// unhandled rejection before the first handler attaches.
ready.catch(() => {});

export function currentUid() {
  return uid;
}

/** Raw SDK handles, for anything this module does not wrap yet. */
export async function getHandles() {
  await ready;
  return handles;
}

/* --- low level path helpers ---------------------------------------------- */

async function refFor(path) {
  await ready;
  return handles.dbMod.ref(handles.db, path);
}

export async function readOnce(path) {
  const node = await refFor(path);
  const snap = await handles.dbMod.get(node);
  return snap.exists() ? snap.val() : null;
}

export async function writeAt(path, value) {
  const node = await refFor(path);
  return handles.dbMod.set(node, value);
}

export async function updateAt(path, patch) {
  const node = await refFor(path);
  return handles.dbMod.update(node, patch);
}

export async function removeAt(path) {
  const node = await refFor(path);
  return handles.dbMod.remove(node);
}

/**
 * Read-modify-write as one atomic server-side operation.
 * `fn(current)` must return the new value, or `undefined` to abort.
 * Returns { committed, value }.
 */
export async function transactAt(path, fn) {
  const node = await refFor(path);
  const result = await handles.dbMod.runTransaction(node, fn);
  return { committed: result.committed, value: result.snapshot.val() };
}

/** Subscribe to a path. Returns an unsubscribe function. */
export function subscribe(path, callback, onError) {
  let stopped = false;
  let off = () => {};
  ready
    .then(() => {
      if (stopped) return;
      off = handles.dbMod.onValue(
        handles.dbMod.ref(handles.db, path),
        (snap) => callback(snap.exists() ? snap.val() : null),
        (err) => {
          console.error('[db] subscribe failed at', path, err);
          if (onError) onError(err);
        }
      );
    })
    .catch((err) => {
      if (onError) onError(err);
    });

  return () => {
    stopped = true;
    off();
  };
}

/* --- room codes ----------------------------------------------------------- */

export function randomCode() {
  let out = '';
  const bytes = new Uint32Array(CODE_LENGTH);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

export function isValidCode(code) {
  if (code.length !== CODE_LENGTH) return false;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch));
}

/* --- room lifecycle -------------------------------------------------------- */

/**
 * Claim an unused 4-character room code. The transaction is what stops two
 * people creating the same room at the same instant: if the node already has a
 * value we abort and try a different code.
 */
export async function createRoom(gameId, playerName) {
  const me = await ready;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const room = {
      meta: {
        gameId,
        hostId: me,
        status: 'lobby',
        createdAt: Date.now()
      },
      players: {
        [me]: {
          name: playerName,
          seat: 0,
          online: true,
          lastSeen: Date.now()
        }
      }
    };

    const { committed } = await transactAt(`rooms/${code}`, (current) => {
      if (current !== null && current !== undefined) return undefined; // taken
      return room;
    });

    if (committed) return code;
  }

  throw new Error('Could not find a free room code. Try again.');
}

/**
 * Join (or rejoin) a room. Rejoining with the same UID always works, even mid
 * game — that is what makes closing the app and coming back survivable.
 */
export async function joinRoom(code, playerName, maxPlayers) {
  const me = await ready;

  const { committed, value } = await transactAt(`rooms/${code}`, (room) => {
    if (room === null || room === undefined) return undefined; // no such room
    const players = room.players || {};
    const mine = players[me];

    if (mine) {
      // Rejoin: keep the seat, refresh the name.
      mine.name = playerName;
      mine.online = true;
      mine.lastSeen = Date.now();
      room.players = players;
      return room;
    }

    const status = room.meta && room.meta.status;
    if (status && status !== 'lobby') return undefined; // game already started
    const seats = Object.values(players).map((p) => p.seat || 0);
    if (seats.length >= maxPlayers) return undefined; // full

    let seat = 0;
    while (seats.includes(seat)) seat += 1;

    players[me] = { name: playerName, seat, online: true, lastSeen: Date.now() };
    room.players = players;
    return room;
  });

  if (!committed) {
    const exists = await readOnce(`rooms/${code}/meta`);
    if (!exists) throw new Error(`No room called ${code}. Check the code and try again.`);
    if (exists.status !== 'lobby') throw new Error(`Room ${code} has already started.`);
    throw new Error(`Room ${code} is full.`);
  }

  return value;
}

/**
 * Leave a room. If the host leaves, the host role moves to the next seated
 * player so the room never dies with one device.
 */
export async function leaveRoom(code) {
  const me = await ready;
  await cancelPresence(code, me);

  await transactAt(`rooms/${code}`, (room) => {
    if (!room) return undefined;
    const players = room.players || {};
    if (!players[me]) return undefined;
    delete players[me];

    const remaining = Object.entries(players).sort(
      (a, b) => (a[1].seat || 0) - (b[1].seat || 0)
    );

    if (remaining.length === 0) return null; // last one out turns off the lights

    if (room.meta && room.meta.hostId === me) {
      room.meta.hostId = remaining[0][0];
    }
    room.players = players;
    return room;
  });
}

/** Any player can adopt the host role — used when the host has gone dark. */
export async function claimHost(code) {
  const me = await ready;
  const { committed } = await transactAt(`rooms/${code}/meta`, (meta) => {
    if (!meta) return undefined;
    meta.hostId = me;
    return meta;
  });
  return committed;
}

/* --- presence -------------------------------------------------------------- */

const disconnectHandles = new Map();

/**
 * Mark this device online in the room, and register the onDisconnect writes
 * that flip it offline the moment the socket drops (phone locks, tunnel dies).
 * Re-registered on every reconnect via .info/connected.
 */
export function attachPresence(code, playerId) {
  let stop = () => {};
  ready
    .then(() => {
      const { ref, onValue, onDisconnect, set, serverTimestamp } = handles.dbMod;
      const onlineRef = ref(handles.db, `rooms/${code}/players/${playerId}/online`);
      const seenRef = ref(handles.db, `rooms/${code}/players/${playerId}/lastSeen`);
      const connectedRef = ref(handles.db, '.info/connected');

      stop = onValue(connectedRef, async (snap) => {
        if (snap.val() !== true) return;
        // Re-registered on every reconnect: onDisconnect handlers are consumed
        // when they fire, so a dropped socket must arm a fresh pair.
        const od = onDisconnect(onlineRef);
        const odSeen = onDisconnect(seenRef);
        disconnectHandles.set(`${code}/${playerId}`, [od, odSeen]);
        try {
          await od.set(false);
          await odSeen.set(serverTimestamp());
          await set(onlineRef, true);
          await set(seenRef, serverTimestamp());
        } catch (err) {
          console.warn('[presence] could not write presence', err);
        }
      });
    })
    .catch((err) => console.warn('[presence] not attached', err));

  return () => stop();
}

async function cancelPresence(code, playerId) {
  const armed = disconnectHandles.get(`${code}/${playerId}`);
  disconnectHandles.delete(`${code}/${playerId}`);
  if (!armed) return;
  await Promise.all(armed.map((h) => h.cancel().catch(() => {})));
}
