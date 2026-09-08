/*
 * Firebase wiring + every read/write the app performs.
 *
 * Rule of the house: nothing touches the database before anonymous auth has
 * resolved. Every exported helper awaits `ready` first, so a "permission
 * denied" in the console means your rules are wrong, not that you raced auth.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase,
  ref,
  child,
  get,
  set,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

import { firebaseConfig, isPlaceholderConfig } from './firebaseconfig.js';
import { setPlayerId } from './session.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O, 0, I, 1
export const CODE_LENGTH = 4;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

/** Resolves with the anonymous auth UID. Everything else waits on this. */
export const ready = (async () => {
  if (isPlaceholderConfig()) {
    throw new Error(
      'Firebase is not configured yet. Paste your real config into js/firebaseconfig.js.'
    );
  }

  const existing = await new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });

  const user = existing || (await signInAnonymously(auth)).user;
  setPlayerId(user.uid);
  return user.uid;
})();

export function currentUid() {
  return auth.currentUser ? auth.currentUser.uid : null;
}

/* --- low level path helpers ---------------------------------------------- */

export function pathRef(path) {
  return ref(db, path);
}

export async function readOnce(path) {
  await ready;
  const snap = await get(ref(db, path));
  return snap.exists() ? snap.val() : null;
}

export async function writeAt(path, value) {
  await ready;
  return set(ref(db, path), value);
}

export async function updateAt(path, patch) {
  await ready;
  return update(ref(db, path), patch);
}

export async function removeAt(path) {
  await ready;
  return remove(ref(db, path));
}

/**
 * Read-modify-write as one atomic server-side operation.
 * `fn(current)` must return the new value, or `undefined` to abort.
 * Returns { committed, value }.
 */
export async function transactAt(path, fn) {
  await ready;
  const result = await runTransaction(ref(db, path), fn);
  return { committed: result.committed, value: result.snapshot.val() };
}

/** Subscribe to a path. Returns an unsubscribe function. */
export function subscribe(path, callback, onError) {
  let stopped = false;
  let off = () => {};
  ready
    .then(() => {
      if (stopped) return;
      off = onValue(
        ref(db, path),
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

export const TIMESTAMP = serverTimestamp();

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
  const uid = await ready;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const room = {
      meta: {
        gameId,
        hostId: uid,
        status: 'lobby',
        createdAt: Date.now()
      },
      players: {
        [uid]: {
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
  const uid = await ready;

  const { committed, value } = await transactAt(`rooms/${code}`, (room) => {
    if (room === null || room === undefined) return undefined; // no such room
    const players = room.players || {};
    const mine = players[uid];

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

    players[uid] = { name: playerName, seat, online: true, lastSeen: Date.now() };
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
  const uid = await ready;
  await cancelPresence(code, uid);

  await transactAt(`rooms/${code}`, (room) => {
    if (!room) return undefined;
    const players = room.players || {};
    if (!players[uid]) return undefined;
    delete players[uid];

    const remaining = Object.entries(players).sort(
      (a, b) => (a[1].seat || 0) - (b[1].seat || 0)
    );

    if (remaining.length === 0) return null; // last one out turns off the lights

    if (room.meta && room.meta.hostId === uid) {
      room.meta.hostId = remaining[0][0];
    }
    room.players = players;
    return room;
  });
}

/** Any player can adopt the host role — used when the host has gone dark. */
export async function claimHost(code) {
  const uid = await ready;
  const { committed } = await transactAt(`rooms/${code}/meta`, (meta) => {
    if (!meta) return undefined;
    meta.hostId = uid;
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
export function attachPresence(code, uid) {
  const onlineRef = ref(db, `rooms/${code}/players/${uid}/online`);
  const seenRef = ref(db, `rooms/${code}/players/${uid}/lastSeen`);
  const connectedRef = ref(db, '.info/connected');

  let stop = () => {};
  ready.then(() => {
    stop = onValue(connectedRef, async (snap) => {
      if (snap.val() !== true) return;
      const od = onDisconnect(onlineRef);
      const odSeen = onDisconnect(seenRef);
      disconnectHandles.set(`${code}/${uid}`, [od, odSeen]);
      try {
        await od.set(false);
        await odSeen.set(serverTimestamp());
        await set(onlineRef, true);
        await set(seenRef, serverTimestamp());
      } catch (err) {
        console.warn('[presence] could not write presence', err);
      }
    });
  });

  return () => stop();
}

async function cancelPresence(code, uid) {
  const handles = disconnectHandles.get(`${code}/${uid}`);
  disconnectHandles.delete(`${code}/${uid}`);
  if (!handles) return;
  await Promise.all(handles.map((h) => h.cancel().catch(() => {})));
}

export { ref, child, onValue, serverTimestamp };
