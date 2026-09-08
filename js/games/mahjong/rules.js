/* ===========================================================================
 * Mah Jong — rules engine.
 *
 * Pure functions only. No Firebase, no DOM, no imports. Every function takes a
 * state and returns a new state (or a boolean/array); nothing is mutated in
 * place, so this can run inside a Realtime Database transaction that may be
 * retried against a different server value.
 *
 * To poke at it in a plain browser console: paste this file WITHOUT the final
 * `export { ... }` line (module syntax will not parse in a console).
 *
 * ---------------------------------------------------------------------------
 * HOUSE RULES IMPLEMENTED (see README for the rationale)
 *
 *   Set          144 tiles.
 *                  m1-m9  characters  x4  (36)
 *                  p1-p9  circles     x4  (36)
 *                  s1-s9  bamboo      x4  (36)
 *                  we ws ww wn  winds x4  (16)
 *                  dr dg dw  dragons  x4  (12)
 *                  f1-f8  flowers & seasons, one each (8)
 *
 *   Deal         13 tiles each, dealt round robin from the front of the wall.
 *                Bonus tiles (f*) are never part of a hand: they are revealed
 *                immediately and replaced with a tile from the back of the wall.
 *
 *   Turn         Draw one, then discard one. After a discard, any other player
 *                may claim it (see below); if nobody does, play passes to the
 *                next seat.
 *
 *   Claims       On a discard, in priority order:
 *                  win  >  kong  >  pung
 *                Ties between equal claims go to the player closest to the
 *                discarder's left. Chow is NOT claimable from a discard — but
 *                runs still count inside a concealed hand (see Winning).
 *                A claim window closes as soon as every player who *could*
 *                claim has answered, or after CLAIM_TIMEOUT_MS.
 *
 *   Kong         Claimed from a discard, or declared concealed from your own
 *                hand on your turn. Either way you draw a replacement tile from
 *                the back of the wall and then discard.
 *
 *   Winning      Four sets plus one pair. A set is a pung (three identical), a
 *                kong (four identical, counts as one set) or a chow (three in
 *                sequence in one suit). You may win on your own draw or on
 *                another player's discard.
 *
 *   Wall out     If the wall empties before anyone wins, the hand is a draw.
 *
 *   Scoring      Deliberately a stub: a flat WIN_SCORE for the winner, zero for
 *                everyone else. Swap getScores() for real scoring later without
 *                touching anything else.
 * ======================================================================== */

const SUITS = ['m', 'p', 's'];
const WINDS = ['we', 'ws', 'ww', 'wn'];
const DRAGONS = ['dr', 'dg', 'dw'];
const BONUS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];

const HAND_SIZE = 13;
const WIN_SCORE = 10;
const CLAIM_TIMEOUT_MS = 12000;
const STATE_VERSION = 1;

/** Canonical ordering, used for sorting hands and for hand decomposition. */
const TILE_ORDER = (() => {
  const order = [];
  for (const suit of SUITS) {
    for (let n = 1; n <= 9; n += 1) order.push(suit + n);
  }
  order.push(...WINDS, ...DRAGONS, ...BONUS);
  return order;
})();

const ORDER_INDEX = TILE_ORDER.reduce((acc, tile, i) => {
  acc[tile] = i;
  return acc;
}, Object.create(null));

/* --- tile predicates ------------------------------------------------------ */

function isBonus(tile) {
  return typeof tile === 'string' && tile.charAt(0) === 'f';
}

function isSuited(tile) {
  return typeof tile === 'string' && SUITS.includes(tile.charAt(0)) && tile.length === 2;
}

function isHonor(tile) {
  return WINDS.includes(tile) || DRAGONS.includes(tile);
}

function suitOf(tile) {
  return isSuited(tile) ? tile.charAt(0) : null;
}

function rankOf(tile) {
  return isSuited(tile) ? Number(tile.charAt(1)) : 0;
}

function compareTiles(a, b) {
  return (ORDER_INDEX[a] ?? 999) - (ORDER_INDEX[b] ?? 999);
}

function sortTiles(tiles) {
  return tiles.slice().sort(compareTiles);
}

/** The full 144-tile set, unshuffled. */
function buildWall() {
  const wall = [];
  for (const suit of SUITS) {
    for (let n = 1; n <= 9; n += 1) {
      for (let copy = 0; copy < 4; copy += 1) wall.push(suit + n);
    }
  }
  for (const honor of [...WINDS, ...DRAGONS]) {
    for (let copy = 0; copy < 4; copy += 1) wall.push(honor);
  }
  wall.push(...BONUS);
  return wall;
}

function shuffle(tiles, rng) {
  const random = rng || Math.random;
  const out = tiles.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/* --- state plumbing -------------------------------------------------------
 * The Realtime Database drops empty arrays and empty objects (they come back
 * as null) and refuses `undefined`. normalizeState puts the holes back so the
 * rest of this file can assume everything exists.
 * ------------------------------------------------------------------------ */

function normalizeState(state) {
  if (!state) return state;
  const seats = (state.seats || []).slice();
  const next = {
    version: state.version || STATE_VERSION,
    seats,
    wall: (state.wall || []).slice(),
    hands: {},
    melds: {},
    flowers: {},
    discards: (state.discards || []).slice(),
    turn: state.turn || null,
    dealer: state.dealer || null,
    phase: state.phase || 'draw',
    pendingDiscard: state.pendingDiscard ? { ...state.pendingDiscard } : null,
    lastDrawn: state.lastDrawn || null,
    winner: state.winner || null,
    winningTile: state.winningTile || null,
    endReason: state.endReason || null,
    log: (state.log || []).slice()
  };

  if (next.pendingDiscard) {
    next.pendingDiscard.eligible = (next.pendingDiscard.eligible || []).slice();
    next.pendingDiscard.claims = { ...(next.pendingDiscard.claims || {}) };
  }

  for (const seat of seats) {
    const id = seat.playerId;
    next.hands[id] = ((state.hands || {})[id] || []).slice();
    next.melds[id] = ((state.melds || {})[id] || []).map((meld) => ({
      type: meld.type,
      tile: meld.tile,
      tiles: (meld.tiles || []).slice(),
      concealed: !!meld.concealed,
      from: meld.from || null
    }));
    next.flowers[id] = ((state.flowers || {})[id] || []).slice();
  }

  return next;
}

function seatOf(state, playerId) {
  const seat = state.seats.find((s) => s.playerId === playerId);
  return seat ? seat.seat : -1;
}

function nameOf(state, playerId) {
  const seat = state.seats.find((s) => s.playerId === playerId);
  return seat ? seat.name : 'Someone';
}

function playerAfter(state, playerId) {
  const n = state.seats.length;
  const idx = state.seats.findIndex((s) => s.playerId === playerId);
  if (idx < 0) return state.seats[0].playerId;
  return state.seats[(idx + 1) % n].playerId;
}

/** Seat distance going around the table from `fromId` to `toId` (1..n-1). */
function seatDistance(state, fromId, toId) {
  const n = state.seats.length;
  const a = state.seats.findIndex((s) => s.playerId === fromId);
  const b = state.seats.findIndex((s) => s.playerId === toId);
  if (a < 0 || b < 0) return n;
  return (b - a + n) % n;
}

function pushLog(state, line) {
  state.log = state.log.concat(line).slice(-40);
}

function removeTiles(hand, tile, count) {
  const out = hand.slice();
  for (let i = 0; i < count; i += 1) {
    const idx = out.indexOf(tile);
    if (idx < 0) throw new Error(`You do not have enough ${tile} tiles.`);
    out.splice(idx, 1);
  }
  return out;
}

function countOf(hand, tile) {
  let n = 0;
  for (const t of hand) if (t === tile) n += 1;
  return n;
}

/**
 * Draw a replacement for a bonus tile from the BACK of the wall, repeating if
 * the replacement is itself a bonus tile. Mutates the passed state.
 */
function drawFromBack(state, playerId) {
  if (state.wall.length === 0) return null;
  return state.wall.pop();
}

function absorbBonus(state, playerId) {
  let ok = true;
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 20) break;
    const hand = state.hands[playerId];
    const idx = hand.findIndex(isBonus);
    if (idx < 0) break;
    const bonus = hand[idx];
    state.hands[playerId] = hand.slice(0, idx).concat(hand.slice(idx + 1));
    state.flowers[playerId] = state.flowers[playerId].concat(bonus);
    const replacement = drawFromBack(state, playerId);
    if (replacement === null) {
      // Wall gone mid-replacement: the hand can never be completed, so the
      // caller ends the game as a wash-out.
      ok = false;
      break;
    }
    state.hands[playerId] = state.hands[playerId].concat(replacement);
  }
  state.hands[playerId] = sortTiles(state.hands[playerId]);
  return ok;
}

/* --- winning-hand detection ----------------------------------------------- */

function toCounts(tiles) {
  const counts = Object.create(null);
  for (const tile of tiles) counts[tile] = (counts[tile] || 0) + 1;
  return counts;
}

function lowestPresent(counts) {
  let best = null;
  let bestIdx = Infinity;
  for (const tile of Object.keys(counts)) {
    if (counts[tile] > 0 && ORDER_INDEX[tile] < bestIdx) {
      bestIdx = ORDER_INDEX[tile];
      best = tile;
    }
  }
  return best;
}

/** Can the remaining counts be split into exactly `need` pungs/chows? */
function formSets(counts, need) {
  if (need === 0) {
    return Object.keys(counts).every((tile) => counts[tile] === 0);
  }

  const tile = lowestPresent(counts);
  if (tile === null) return false;

  // Pung
  if (counts[tile] >= 3) {
    counts[tile] -= 3;
    const ok = formSets(counts, need - 1);
    counts[tile] += 3;
    if (ok) return true;
  }

  // Chow (suited tiles only, and only within one suit)
  if (isSuited(tile) && rankOf(tile) <= 7) {
    const suit = suitOf(tile);
    const b = suit + (rankOf(tile) + 1);
    const c = suit + (rankOf(tile) + 2);
    if ((counts[b] || 0) > 0 && (counts[c] || 0) > 0) {
      counts[tile] -= 1;
      counts[b] -= 1;
      counts[c] -= 1;
      const ok = formSets(counts, need - 1);
      counts[tile] += 1;
      counts[b] += 1;
      counts[c] += 1;
      if (ok) return true;
    }
  }

  return false;
}

/** Do these concealed tiles make `setsNeeded` sets plus exactly one pair? */
function isWinningTileSet(tiles, setsNeeded) {
  if (tiles.some(isBonus)) return false;
  if (tiles.length !== setsNeeded * 3 + 2) return false;

  const counts = toCounts(tiles);
  for (const tile of Object.keys(counts)) {
    if (counts[tile] >= 2) {
      counts[tile] -= 2;
      const ok = formSets(counts, setsNeeded);
      counts[tile] += 2;
      if (ok) return true;
    }
  }
  return false;
}

function setsNeededFor(state, playerId) {
  return 4 - state.melds[playerId].length;
}

/** Would `playerId` win by adding `tile` to their concealed hand? */
function canWinWith(state, playerId, tile) {
  const tiles = state.hands[playerId].concat(tile ? [tile] : []);
  return isWinningTileSet(tiles, setsNeededFor(state, playerId));
}

/** Is `playerId`'s current concealed hand (post-draw) already a winner? */
function handIsComplete(state, playerId) {
  return isWinningTileSet(state.hands[playerId], setsNeededFor(state, playerId));
}

/* --- public API ------------------------------------------------------------ */

/**
 * players: [{ playerId, name, seat }]
 * Returns a fresh, fully dealt game state.
 */
function createInitialState(players, options) {
  const opts = options || {};
  const seats = players
    .slice()
    .sort((a, b) => (a.seat || 0) - (b.seat || 0))
    .map((p, i) => ({ playerId: p.playerId, name: p.name || `Player ${i + 1}`, seat: i }));

  if (seats.length < 2) throw new Error('Mah Jong needs at least 2 players.');
  if (seats.length > 4) throw new Error('Mah Jong seats at most 4 players.');

  const state = normalizeState({
    version: STATE_VERSION,
    seats,
    wall: shuffle(buildWall(), opts.rng),
    dealer: seats[0].playerId,
    turn: seats[0].playerId,
    phase: 'draw'
  });

  for (const seat of seats) {
    state.hands[seat.playerId] = [];
    state.melds[seat.playerId] = [];
    state.flowers[seat.playerId] = [];
  }

  for (let round = 0; round < HAND_SIZE; round += 1) {
    for (const seat of seats) {
      state.hands[seat.playerId] = state.hands[seat.playerId].concat(state.wall.shift());
    }
  }

  for (const seat of seats) absorbBonus(state, seat.playerId);

  pushLog(state, `${nameOf(state, state.dealer)} deals. ${state.wall.length} tiles in the wall.`);
  return state;
}

/** Every move `playerId` may legally make right now. */
function getLegalMoves(rawState, playerId) {
  const state = normalizeState(rawState);
  if (!state || state.phase === 'over') return [];
  if (seatOf(state, playerId) < 0) return [];

  const moves = [];

  if (state.phase === 'claim' && state.pendingDiscard) {
    const pd = state.pendingDiscard;
    const answered = pd.claims[playerId];
    if (pd.eligible.includes(playerId) && !answered) {
      moves.push({ type: 'pass' });
      const tile = pd.tile;
      const inHand = countOf(state.hands[playerId], tile);
      if (canWinWith(state, playerId, tile)) moves.push({ type: 'win' });
      if (inHand >= 3) moves.push({ type: 'kong' });
      if (inHand >= 2) moves.push({ type: 'pung' });
    }
    // Anyone may close a stalled claim window once the timeout has elapsed.
    moves.push({ type: 'resolveClaims', after: (pd.at || 0) + CLAIM_TIMEOUT_MS });
    return moves;
  }

  if (state.turn !== playerId) return moves;

  if (state.phase === 'draw') {
    moves.push({ type: 'draw' });
    return moves;
  }

  if (state.phase === 'discard') {
    if (handIsComplete(state, playerId)) moves.push({ type: 'declareWin' });

    const seen = new Set();
    for (const tile of state.hands[playerId]) {
      if (seen.has(tile)) continue;
      seen.add(tile);
      if (countOf(state.hands[playerId], tile) === 4 && state.wall.length > 0) {
        moves.push({ type: 'concealedKong', tile });
      }
      moves.push({ type: 'discard', tile });
    }
  }

  return moves;
}

/**
 * Apply a move. Returns a NEW state, or throws if the move is illegal.
 * Every caller runs this inside a database transaction against the current
 * server value, so two players tapping at the same instant cannot interleave.
 */
function applyMove(rawState, playerId, move) {
  const state = normalizeState(rawState);
  if (!state) throw new Error('No game in progress.');
  if (state.phase === 'over') throw new Error('This hand is already finished.');
  if (seatOf(state, playerId) < 0) throw new Error('You are not seated in this game.');
  if (!move || !move.type) throw new Error('Empty move.');

  switch (move.type) {
    case 'draw':
      return doDraw(state, playerId);
    case 'discard':
      return doDiscard(state, playerId, move.tile);
    case 'concealedKong':
      return doConcealedKong(state, playerId, move.tile);
    case 'declareWin':
      return doDeclareWin(state, playerId);
    case 'pass':
    case 'pung':
    case 'kong':
    case 'win':
      return doClaim(state, playerId, move.type);
    case 'resolveClaims':
      return doResolveClaims(state, move.now);
    default:
      throw new Error(`Unknown move "${move.type}".`);
  }
}

function doDraw(state, playerId) {
  if (state.phase !== 'draw') throw new Error('Not a drawing phase.');
  if (state.turn !== playerId) throw new Error('It is not your turn.');

  if (state.wall.length === 0) return endInDraw(state);

  const tile = state.wall.shift();
  state.hands[playerId] = sortTiles(state.hands[playerId].concat(tile));
  state.lastDrawn = { playerId, tile };
  if (!absorbBonus(state, playerId)) return endInDraw(state);

  state.phase = 'discard';
  return state;
}

function doDiscard(state, playerId, tile) {
  if (state.phase !== 'discard') throw new Error('You cannot discard right now.');
  if (state.turn !== playerId) throw new Error('It is not your turn.');
  if (!tile || countOf(state.hands[playerId], tile) === 0) {
    throw new Error('That tile is not in your hand.');
  }

  state.hands[playerId] = removeTiles(state.hands[playerId], tile, 1);
  state.lastDrawn = null;

  const eligible = state.seats
    .map((s) => s.playerId)
    .filter((pid) => pid !== playerId)
    .filter(
      (pid) =>
        canWinWith(state, pid, tile) ||
        countOf(state.hands[pid], tile) >= 2
    );

  pushLog(state, `${nameOf(state, playerId)} discards.`);

  if (eligible.length === 0) {
    state.discards = state.discards.concat({ tile, by: playerId });
    state.turn = playerAfter(state, playerId);
    state.phase = 'draw';
    state.pendingDiscard = null;
    if (state.wall.length === 0) return endInDraw(state);
    return state;
  }

  state.phase = 'claim';
  state.pendingDiscard = {
    tile,
    by: playerId,
    at: Date.now(),
    eligible,
    claims: {}
  };
  return state;
}

function doConcealedKong(state, playerId, tile) {
  if (state.phase !== 'discard') throw new Error('You can only declare a kong on your own turn.');
  if (state.turn !== playerId) throw new Error('It is not your turn.');
  if (countOf(state.hands[playerId], tile) < 4) throw new Error('You need all four tiles.');
  if (state.wall.length === 0) throw new Error('No tiles left for a replacement draw.');

  state.hands[playerId] = removeTiles(state.hands[playerId], tile, 4);
  state.melds[playerId] = state.melds[playerId].concat({
    type: 'kong',
    tile,
    tiles: [tile, tile, tile, tile],
    concealed: true,
    from: null
  });

  const replacement = state.wall.pop();
  state.hands[playerId] = sortTiles(state.hands[playerId].concat(replacement));
  state.lastDrawn = { playerId, tile: replacement };
  if (!absorbBonus(state, playerId)) return endInDraw(state);

  pushLog(state, `${nameOf(state, playerId)} declares a concealed kong.`);
  state.phase = 'discard';
  return state;
}

function doDeclareWin(state, playerId) {
  if (state.phase !== 'discard') throw new Error('You can only declare a win on your own turn.');
  if (state.turn !== playerId) throw new Error('It is not your turn.');
  if (!handIsComplete(state, playerId)) throw new Error('That hand is not complete.');

  state.phase = 'over';
  state.winner = playerId;
  state.winningTile = state.lastDrawn ? state.lastDrawn.tile : null;
  state.endReason = 'selfDraw';
  state.pendingDiscard = null;
  pushLog(state, `${nameOf(state, playerId)} wins on a self-draw.`);
  return state;
}

function doClaim(state, playerId, claim) {
  if (state.phase !== 'claim' || !state.pendingDiscard) {
    throw new Error('There is nothing to claim.');
  }
  const pd = state.pendingDiscard;
  if (playerId === pd.by) throw new Error('You cannot claim your own discard.');
  if (!pd.eligible.includes(playerId)) throw new Error('You have no claim on that tile.');
  if (pd.claims[playerId]) throw new Error('You already answered.');

  const tile = pd.tile;
  if (claim === 'win' && !canWinWith(state, playerId, tile)) {
    throw new Error('That tile does not complete your hand.');
  }
  if (claim === 'kong' && countOf(state.hands[playerId], tile) < 3) {
    throw new Error('You need three matching tiles for a kong.');
  }
  if (claim === 'pung' && countOf(state.hands[playerId], tile) < 2) {
    throw new Error('You need two matching tiles for a pung.');
  }

  pd.claims[playerId] = claim;

  const everyoneAnswered = pd.eligible.every((pid) => pd.claims[pid]);
  if (everyoneAnswered) return resolvePending(state);
  return state;
}

function doResolveClaims(state, now) {
  if (state.phase !== 'claim' || !state.pendingDiscard) {
    throw new Error('There is nothing to resolve.');
  }
  const pd = state.pendingDiscard;
  const everyoneAnswered = pd.eligible.every((pid) => pd.claims[pid]);
  const stamp = typeof now === 'number' ? now : Date.now();
  if (!everyoneAnswered && stamp - (pd.at || 0) < CLAIM_TIMEOUT_MS) {
    throw new Error('Still waiting on a claim.');
  }
  return resolvePending(state);
}

/** win > kong > pung; ties go to whoever sits closest to the discarder's left. */
const CLAIM_RANK = { win: 3, kong: 2, pung: 1, pass: 0 };

function resolvePending(state) {
  const pd = state.pendingDiscard;
  const tile = pd.tile;

  let winnerId = null;
  let winnerClaim = null;
  for (const pid of pd.eligible) {
    const claim = pd.claims[pid];
    if (!claim || claim === 'pass') continue;
    if (
      winnerId === null ||
      CLAIM_RANK[claim] > CLAIM_RANK[winnerClaim] ||
      (CLAIM_RANK[claim] === CLAIM_RANK[winnerClaim] &&
        seatDistance(state, pd.by, pid) < seatDistance(state, pd.by, winnerId))
    ) {
      winnerId = pid;
      winnerClaim = claim;
    }
  }

  state.pendingDiscard = null;

  if (winnerId === null) {
    state.discards = state.discards.concat({ tile, by: pd.by });
    state.turn = playerAfter(state, pd.by);
    state.phase = 'draw';
    if (state.wall.length === 0) return endInDraw(state);
    return state;
  }

  if (winnerClaim === 'win') {
    state.phase = 'over';
    state.winner = winnerId;
    state.winningTile = tile;
    state.endReason = 'discard';
    state.discards = state.discards.concat({ tile, by: pd.by, claimedBy: winnerId });
    pushLog(state, `${nameOf(state, winnerId)} wins on ${nameOf(state, pd.by)}'s discard.`);
    return state;
  }

  const take = winnerClaim === 'kong' ? 3 : 2;
  state.hands[winnerId] = removeTiles(state.hands[winnerId], tile, take);
  state.melds[winnerId] = state.melds[winnerId].concat({
    type: winnerClaim,
    tile,
    tiles: new Array(take + 1).fill(tile),
    concealed: false,
    from: pd.by
  });

  if (winnerClaim === 'kong') {
    if (state.wall.length === 0) return endInDraw(state);
    const replacement = state.wall.pop();
    state.hands[winnerId] = sortTiles(state.hands[winnerId].concat(replacement));
    state.lastDrawn = { playerId: winnerId, tile: replacement };
    if (!absorbBonus(state, winnerId)) {
      state.turn = winnerId;
      return endInDraw(state);
    }
  } else {
    state.lastDrawn = null;
  }

  state.turn = winnerId;
  state.phase = 'discard';
  pushLog(state, `${nameOf(state, winnerId)} claims a ${winnerClaim}.`);
  return state;
}

function endInDraw(state) {
  state.phase = 'over';
  state.winner = null;
  state.winningTile = null;
  state.endReason = 'wallExhausted';
  state.pendingDiscard = null;
  pushLog(state, 'The wall ran out. Washed-out hand.');
  return state;
}

function isGameOver(rawState) {
  const state = normalizeState(rawState);
  return !!state && state.phase === 'over';
}

/**
 * Scoring stub. One flat value for the winner so the loop is playable; swap the
 * body of this function for real scoring later and nothing else changes.
 */
function getScores(rawState) {
  const state = normalizeState(rawState);
  const scores = {};
  if (!state) return scores;
  for (const seat of state.seats) {
    scores[seat.playerId] = state.winner === seat.playerId ? WIN_SCORE : 0;
  }
  return scores;
}

/**
 * Strip everything `playerId` is not entitled to see: other people's concealed
 * hands and the contents of the wall.
 *
 * This is client-side redaction. A determined player can open dev tools and
 * read the raw room state straight from Firebase. That is a deliberate
 * trade-off — see the README.
 */
function redactStateFor(rawState, playerId) {
  const state = normalizeState(rawState);
  if (!state) return state;

  const handCounts = {};
  const hands = {};
  for (const seat of state.seats) {
    const id = seat.playerId;
    handCounts[id] = state.hands[id].length;
    if (id === playerId) hands[id] = state.hands[id].slice();
  }

  const view = {
    ...state,
    hands,
    handCounts,
    // Length is public information (everyone can see the wall shrink); the
    // contents are not, so they are replaced with blanks.
    wall: new Array(state.wall.length).fill(null),
    wallCount: state.wall.length
  };

  if (view.pendingDiscard) {
    const pd = state.pendingDiscard;
    const mine = pd.eligible.includes(playerId);
    view.pendingDiscard = {
      tile: pd.tile,
      by: pd.by,
      at: pd.at || 0,
      // Knowing that Bob *may* claim tells you Bob holds a pair. Each player
      // only ever learns about their own claim; everyone else is a headcount.
      eligible: mine ? [playerId] : [],
      claims: pd.claims[playerId] ? { [playerId]: pd.claims[playerId] } : {},
      waitingCount: pd.eligible.filter((pid) => !pd.claims[pid]).length
    };
  }

  return view;
}

/* --- exports ---------------------------------------------------------------
 * Strip this final statement to paste the file into a plain browser console.
 * ------------------------------------------------------------------------ */
export {
  createInitialState,
  getLegalMoves,
  applyMove,
  isGameOver,
  getScores,
  redactStateFor,
  normalizeState,
  buildWall,
  sortTiles,
  isBonus,
  isSuited,
  isHonor,
  suitOf,
  rankOf,
  canWinWith,
  handIsComplete,
  isWinningTileSet,
  HAND_SIZE,
  WIN_SCORE,
  CLAIM_TIMEOUT_MS,
  TILE_ORDER
};
