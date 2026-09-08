/*
 * Paste the firebaseConfig object from the Firebase console here.
 *
 *   Firebase console > Project Overview > your web app (</>) > SDK setup
 *
 * This file is committed to a public repo on purpose. A Firebase web config is
 * an identifier, not a secret — it is visible in the network tab of any client
 * anyway. What actually protects the data is the Realtime Database rules plus
 * the authorized-domains list in Authentication > Settings.
 *
 * databaseURL is REQUIRED. If the console did not show you one, you have not
 * created the Realtime Database yet (and note: Firestore is a different
 * product — this app uses Realtime Database).
 */

export const firebaseConfig = {
  apiKey: 'PASTE_API_KEY',
  authDomain: 'PASTE_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://PASTE_PROJECT_ID-default-rtdb.us-central1.firebasedatabase.app',
  projectId: 'PASTE_PROJECT_ID',
  storageBucket: 'PASTE_PROJECT_ID.appspot.com',
  messagingSenderId: 'PASTE_SENDER_ID',
  appId: 'PASTE_APP_ID'
};

/** True while the placeholders above have not been replaced. */
export function isPlaceholderConfig() {
  return Object.values(firebaseConfig).some(
    (value) => typeof value === 'string' && value.includes('PASTE_')
  );
}
