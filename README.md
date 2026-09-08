# Banks Games

A mobile-first PWA of multiplayer card and tile games for up to four people, played over
a four-character room code.

**Live:** https://jake17388.github.io/banksgames/

- No build step. Plain HTML, CSS, and vanilla ES modules — every file in this repo is a
  file the browser loads directly.
- No server. All game logic runs in the browser; Firebase Realtime Database is only
  shared state.
- Every path is relative, because the site is served from the `/banksgames/` subpath.

---

## What you need to paste into `js/firebaseconfig.js`

Firebase console → **Project Overview → your web app (`</>`) → SDK setup and configuration**.
Replace the seven `PASTE_*` placeholders:

| Key | Looks like |
| --- | --- |
| `apiKey` | `AIzaSy...` |
| `authDomain` | `banks-games.firebaseapp.com` |
| `databaseURL` | `https://banks-games-default-rtdb.us-central1.firebasedatabase.app` |
| `projectId` | `banks-games` |
| `storageBucket` | `banks-games.appspot.com` |
| `messagingSenderId` | a 12-ish digit number |
| `appId` | `1:1234567890:web:abc123...` |

That is the whole list. Nothing else in the repo needs editing.

`databaseURL` is **required**. If the console did not show you one, you have not created
the Realtime Database yet — and note that Firestore is a different product; this app uses
Realtime Database.

**This config is committed to a public repo on purpose.** A Firebase web config is an
identifier, not a secret; it is visible in any client's network tab regardless. What
protects the data is the database rules plus the authorized-domains list.

### The console side (once, by hand)

1. **Realtime Database** → Create Database → location `us-central1`.
2. **Authentication** → Get started → **Anonymous** → Enable.
3. **Authentication → Settings → Authorized domains** → add `jake17388.github.io`.
   Anonymous auth fails silently without this.
4. **Realtime Database → Rules**:

   ```json
   {
     "rules": {
       "rooms": {
         "$roomId": {
           ".read": "auth != null",
           ".write": "auth != null",
           ".validate": "$roomId.length == 4"
         }
       }
     }
   }
   ```

   Anyone signed into the app can read and write a room whose code they know; random
   internet traffic cannot touch the database at all.

---

## Running it locally

ES modules will not load over `file://`, so you need a local server:

```bash
cd banksgames
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

Add `localhost` to Firebase's authorized domains if you want auth to work locally
(Authentication → Settings → Authorized domains).

While developing, open DevTools → **Application** → **Service Workers** and tick
**Update on reload**, otherwise the service worker will keep handing you the shell it
already cached.

---

## How it fits together

```
index.html            boots the router, registers the service worker
manifest.json         PWA manifest (standalone, portrait, dark)
sw.js                 network-first for HTML, cache-first for assets
css/styles.css        one stylesheet, 390px-wide portrait phone first
js/firebaseconfig.js  the config you paste in
js/db.js              auth + every read/write; nothing runs before auth resolves
js/session.js         name and player id in localStorage
js/router.js          hash routing (#/ and #/room/ABCD) + shared UI helpers
js/home.js            name, game grid, create/join
js/lobby.js           presence, player list, host controls, game mount point
js/games/registry.js  the game catalogue
js/games/<id>/rules.js  pure logic — no Firebase, no DOM
js/games/<id>/ui.js     rendering and move submission
icons/                app icons
.nojekyll             stop GitHub Pages running the files through Jekyll
```

### Data model

Everything for one session lives under `/rooms/{CODE}`:

```
rooms/
  ABCD/
    meta/
      gameId: "mahjong"
      hostId: "<uid>"
      status: "lobby" | "playing" | "finished"
      createdAt: <timestamp>
    players/
      <uid>/
        name: "Jake"
        seat: 0
        online: true
        lastSeen: <timestamp>
    state/
      <owned entirely by the game module>
```

Room codes are four characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `O`, `0`,
`I` or `1`, so nobody has to ask "letter or number?" over the phone. Claiming a code is a
transaction, so two people creating a room at the same instant cannot land on the same one.

### Why the Firebase SDK loads lazily

`js/db.js` pulls the Firebase modules in with a dynamic `import()` rather than a static
one. A service worker cannot cache cross-origin modules, so a static import would mean the
installed app renders **nothing** whenever `gstatic.com` is slow, blocked, or you are
offline — the shell would be cached and useless. Loading on demand lets the home screen
paint from cache and fail only where Firebase is genuinely needed. It also means you can
open the app and see the main screen before you have pasted any config at all; it will just
tell you, in place, that it is not configured.

### Presence

Every client watches `.info/connected` and, on each connect, registers an
`onDisconnect()` write that flips its own `players/{uid}/online` to `false`. Lock your
phone and your dot goes grey on everyone else's screen within a second or two; unlock and
it comes back. Nothing about the game depends on one specific device staying alive: if the
host leaves, the host role passes to the next seated player automatically, and if the host
simply goes dark, anyone in the lobby can take the role over.

### Concurrency

Every move is a **transaction** on `/rooms/{CODE}/state` that runs `applyMove` against the
current server value. There is no read-then-write anywhere in the codebase. Two players
tapping at the same instant get serialized by the server; the loser's transaction re-runs
against the winner's state and is rejected if it is no longer legal.

### Hidden information — read this before you care about cheating

`redactStateFor(state, playerId)` strips other players' hands, the contents of the wall,
and who is eligible to claim a discard, and the UI only ever renders the redacted view.

**This is client-side redaction.** The raw room state, including everyone's tiles, lives
in the database and a determined player can read it straight out of dev tools. That is a
deliberate trade-off: fixing it properly means moving move-validation into a Cloud
Function, which means a server, which this project does not want. It is a game among
friends. If a friend opens dev tools to see your hand, you have a friend problem, not a
software problem.

---

## Adding a game

Write two files and add one line. Nothing else in the app changes.

1. `js/games/<id>/rules.js` — pure functions, no Firebase, no DOM:

   | Function | Contract |
   | --- | --- |
   | `createInitialState(players)` | `players` is `[{ playerId, name, seat }]` |
   | `getLegalMoves(state, playerId)` | array of move objects |
   | `applyMove(state, playerId, move)` | returns a **new** state, or throws on an illegal move |
   | `isGameOver(state)` | boolean |
   | `getScores(state)` | `{ [playerId]: number }` |
   | `redactStateFor(state, playerId)` | strips what that player must not see |

   Keep it pasteable into a bare console (minus the final `export` line) so you can test
   the rules without a browser or a network.

2. `js/games/<id>/ui.js` — exports `mount(container, room)` and `unmount()`.

   `room` gives you:

   | Member | What it does |
   | --- | --- |
   | `code`, `playerId`, `gameId`, `descriptor` | identity |
   | `players` | live seated players, sorted by seat |
   | `isHost` | boolean |
   | `onPlayers(cb)` | subscribe to the player list; returns an unsubscribe |
   | `subscribeState(cb, onError)` | subscribe to game state; returns an unsubscribe |
   | `submitState(updater)` | run `updater(current)` inside a transaction; throw to reject |
   | `seedState(build)` | write initial state only if there is none yet |
   | `replaceState(value)` | overwrite state (used by "deal again") |
   | `setStatus(s)` / `backToLobby()` | move the room between lobby and play |
   | `leave()`, `toast(msg)` | shell helpers |

   The module deals its own opening state: when it mounts as host and finds no state, it
   calls `seedState`. Non-hosts wait a few seconds and then try too, so a host whose phone
   dies between "Start" and the deal cannot wedge the room.

3. Add a descriptor to `js/games/registry.js`:

   ```js
   {
     id: 'hearts',
     name: 'Hearts',
     blurb: 'Avoid the queen',
     minPlayers: 3,
     maxPlayers: 4,
     enabled: true,
     load: () => import('./hearts/ui.js')
   }
   ```

   `enabled: false` renders the card greyed with a "Coming soon" tag, which is what the
   two placeholder entries currently do.

---

## Mah Jong: the rules currently implemented

These are **placeholder house rules** — a complete, playable loop so the plumbing can be
tested end to end. They are meant to be replaced. All of it lives in
`js/games/mahjong/rules.js`; nothing else in the app knows what a tile is.

- **144 tiles**: characters, circles and bamboo 1–9 (four of each), the four winds and
  three dragons (four of each), and eight bonus tiles (four flowers, four seasons).
- **13-tile hands**, dealt round robin. Bonus tiles are never held: they are revealed
  immediately and replaced from the back of the wall.
- **Turn order**: draw one, discard one, pass to the left.
- **Claims on a discard**, in priority order **win > kong > pung**. Ties go to the player
  closest to the discarder's left. The window closes as soon as every player who *could*
  claim has answered, or after 12 seconds — so one person locking their phone does not
  freeze the table.
- **Chow is not claimable from a discard**, but a run of three in one suit still counts as
  a set inside your own hand. Without that, an all-pungs-only win condition is close to
  unreachable and every hand washes out.
- **Kong** can be claimed from a discard or declared concealed on your own turn. Either
  way you draw a replacement and then discard.
- **Winning**: four sets plus one pair, on your own draw or on someone's discard. A set is
  a pung, a kong, or a chow.
- **Wall out**: if the wall empties first, the hand is a wash.
- **Scoring is a deliberate stub**: a flat 10 to the winner, 0 to everyone else. Replace
  the body of `getScores()` and nothing else has to change.

### Tiles

Tiles render as CSS-styled divs using the Unicode mahjong characters (U+1F000–U+1F02B) as
the glyph layer:

```html
<button class="tile"><span class="tile-face"><span class="tile-glyph">🀇</span></span></button>
```

To swap in image sprites later, set a `background-image` on `.tile-face` and hide
`.tile-glyph`. No game logic is involved in tile appearance.

---

## Service worker

`CACHE_VERSION` at the top of `sw.js` names the cache; old caches are deleted on activate.
HTML documents are fetched **network first**, so a push to `main` shows up on the next
load instead of being pinned forever; static assets are **cache first** and revalidated in
the background. Cross-origin requests — Firebase auth, the Realtime Database socket, the
`gstatic` module CDN — are never intercepted or cached.

If a stale version keeps loading anyway, bump `CACHE_VERSION`.

---

## Things that will probably bite you

| Symptom | Cause |
| --- | --- |
| Blank white page | An absolute path. Every `src` and `import` must start with `./`. |
| Auth fails silently | `jake17388.github.io` is missing from Authentication → Settings → Authorized domains. |
| `PERMISSION_DENIED` in the console | Rules not published, or something touched the database before `signInAnonymously` resolved. Nothing in this repo does the latter — everything awaits `ready` in `js/db.js`. |
| Old version keeps loading | Bump `CACHE_VERSION` in `sw.js`; tick "Update on reload" in DevTools while developing. |
| "Firebase is not configured yet" on the boot screen | `js/firebaseconfig.js` still has the `PASTE_*` placeholders. |

---

## Getting it on a phone

1. Push to `main` and give Pages a minute (watch the **Actions** tab).
2. Open https://jake17388.github.io/banksgames/ in Chrome (Android) or Safari (iOS).
3. Menu → **Add to Home screen**. It launches fullscreen with no browser chrome.
4. Have a friend do the same, create a room, read them the code, and confirm both names
   appear in the lobby with green dots.
5. Lock your phone for 30 seconds and confirm your dot goes grey on their screen, then
   comes back when you unlock.

Test step 5 before caring about any game logic. If presence works, the rest is just rules.
