/*
 * Per-device identity.
 *
 * playerId is the Firebase anonymous auth UID. Firebase already persists the
 * anonymous account in IndexedDB, so reopening the app signs you back in as the
 * same UID; we mirror it into localStorage purely so the UI can render a name
 * before auth resolves.
 *
 * displayName is entirely ours.
 */

const KEY_NAME = 'banksgames.displayName';
const KEY_ID = 'banksgames.playerId';
const KEY_LAST_ROOM = 'banksgames.lastRoom';

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    // Private mode / storage disabled. Fall back to in-memory only.
    return memory[key] ?? null;
  }
}

function write(key, value) {
  memory[key] = value;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch (err) {
    /* in-memory fallback already set */
  }
}

const memory = Object.create(null);

export function getDisplayName() {
  return (read(KEY_NAME) || '').trim();
}

export function setDisplayName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  write(KEY_NAME, clean);
  return clean;
}

export function hasName() {
  return getDisplayName().length > 0;
}

export function getPlayerId() {
  return read(KEY_ID);
}

export function setPlayerId(uid) {
  write(KEY_ID, uid);
  return uid;
}

export function getLastRoom() {
  return read(KEY_LAST_ROOM);
}

export function setLastRoom(code) {
  write(KEY_LAST_ROOM, code || null);
}
