/*
 * Mah Jong — presentation layer.
 *
 * Everything here is rendering and move submission. All of the actual rules
 * live in ./rules.js, which never imports Firebase or touches the DOM.
 *
 * Every move goes through room.submitState(), which runs applyMove inside a
 * Realtime Database transaction against the current server value. There is no
 * read-then-write anywhere in this file.
 */

import {
  createInitialState,
  getLegalMoves,
  applyMove,
  isGameOver,
  getScores,
  redactStateFor,
  normalizeState,
  isBonus,
  CLAIM_TIMEOUT_MS
} from './rules.js';
import { el, toast } from '../../router.js';

/* --- tile presentation -----------------------------------------------------
 * Glyphs are a fallback. Each tile renders as
 *   <button class="tile"><span class="tile-face"><span class="tile-glyph">
 * so swapping in an image sprite later is a CSS change (background-image on
 * .tile-face, hide .tile-glyph) with no touch to game logic.
 * ------------------------------------------------------------------------ */

const VS_TEXT = '︎'; // force text presentation; some tiles are emoji fonts

function codePointTile(base, offset) {
  return String.fromCodePoint(base + offset) + VS_TEXT;
}

const GLYPHS = (() => {
  const map = {};
  for (let n = 1; n <= 9; n += 1) {
    map['m' + n] = codePointTile(0x1f007, n - 1); // characters
    map['s' + n] = codePointTile(0x1f010, n - 1); // bamboo
    map['p' + n] = codePointTile(0x1f019, n - 1); // circles
  }
  ['we', 'ws', 'ww', 'wn'].forEach((tile, i) => {
    map[tile] = codePointTile(0x1f000, i);
  });
  ['dr', 'dg', 'dw'].forEach((tile, i) => {
    map[tile] = codePointTile(0x1f004, i);
  });
  for (let i = 0; i < 8; i += 1) {
    map['f' + (i + 1)] = codePointTile(0x1f022, i);
  }
  map.back = codePointTile(0x1f02b, 0);
  return map;
})();

const SUIT_NAMES = { m: 'characters', p: 'circles', s: 'bamboo' };
const NAMES = {
  we: 'East wind',
  ws: 'South wind',
  ww: 'West wind',
  wn: 'North wind',
  dr: 'Red dragon',
  dg: 'Green dragon',
  dw: 'White dragon',
  f1: 'Plum', f2: 'Orchid', f3: 'Bamboo flower', f4: 'Chrysanthemum',
  f5: 'Spring', f6: 'Summer', f7: 'Autumn', f8: 'Winter'
};

function tileName(tile) {
  if (NAMES[tile]) return NAMES[tile];
  const suit = SUIT_NAMES[tile.charAt(0)];
  if (suit) return `${tile.charAt(1)} of ${suit}`;
  return tile;
}

function tileClass(tile) {
  const classes = ['tile'];
  if (tile === 'dr') classes.push('dragon-red');
  else if (tile === 'dg') classes.push('dragon-green');
  else if (isBonus(tile)) classes.push('bonus');
  else if (!SUIT_NAMES[tile.charAt(0)]) classes.push('honor');
  return classes;
}

function tileEl(tile, options) {
  const opts = options || {};
  const classes = tile === null ? ['tile', 'back'] : tileClass(tile);
  if (opts.size) classes.push(opts.size);
  if (opts.selected) classes.push('selected');
  if (opts.highlight) classes.push('just-drawn');
  if (opts.onClick) classes.push('tappable');

  const node = el(opts.onClick ? 'button' : 'div', {
    class: classes.join(' '),
    type: opts.onClick ? 'button' : null,
    'aria-label': tile === null ? 'Face-down tile' : tileName(tile),
    title: tile === null ? '' : tileName(tile)
  }, [
    el('span', { class: 'tile-face' }, [
      el('span', { class: 'tile-glyph', text: tile === null ? GLYPHS.back : GLYPHS[tile] || '?' })
    ])
  ]);

  if (opts.onClick) node.addEventListener('click', opts.onClick);
  return node;
}

/* --- module state ---------------------------------------------------------- */

let ctx = null;

export async function mount(container, room) {
  unmount();

  ctx = {
    room,
    container,
    rawState: null,
    selected: null,
    seedAttempted: false,
    busy: false,
    handScroll: 0,
    unsubState: null,
    unsubPlayers: null,
    ticker: null,
    seedTimer: null
  };

  const root = el('div', { class: 'game' });
  const status = el('div', { class: 'game-status' });
  const table = el('div', { class: 'game-table' });
  const rail = el('div', { class: 'hand-rail' });
  root.appendChild(status);
  root.appendChild(table);
  root.appendChild(rail);
  container.appendChild(root);

  ctx.nodes = { root, status, table, rail };

  ctx.unsubPlayers = room.onPlayers(() => {
    if (ctx) render();
  });

  ctx.unsubState = room.subscribeState(
    (value) => {
      if (!ctx) return;
      ctx.rawState = value;
      if (value === null) {
        scheduleSeed();
      } else if (ctx.seedTimer) {
        window.clearTimeout(ctx.seedTimer);
        ctx.seedTimer = null;
      }
      render();
    },
    (err) => {
      console.error('[mahjong] state listener failed', err);
      toast('Lost the game state. Check your connection.');
    }
  );

  // Drives the claim countdown and unsticks a claim window whose players have
  // gone silent.
  ctx.ticker = window.setInterval(() => {
    if (!ctx || !ctx.rawState) return;
    const state = normalizeState(ctx.rawState);
    if (state.phase !== 'claim' || !state.pendingDiscard) return;
    render();
    if (Date.now() - (state.pendingDiscard.at || 0) > CLAIM_TIMEOUT_MS + 400) {
      resolveStalledClaims();
    }
  }, 1000);

  render();
}

export function unmount() {
  if (!ctx) return;
  if (ctx.unsubState) ctx.unsubState();
  if (ctx.unsubPlayers) ctx.unsubPlayers();
  if (ctx.ticker) window.clearInterval(ctx.ticker);
  if (ctx.seedTimer) window.clearTimeout(ctx.seedTimer);
  if (ctx.nodes && ctx.nodes.root && ctx.nodes.root.parentNode) {
    ctx.nodes.root.parentNode.removeChild(ctx.nodes.root);
  }
  ctx = null;
}

/* --- dealing --------------------------------------------------------------- */

function scheduleSeed() {
  if (!ctx || ctx.seedTimer || ctx.seedAttempted) return;
  // The host deals straight away. Anyone else waits a beat and then deals only
  // if the host never did, so a host who drops out cannot wedge the room.
  const delay = ctx.room.isHost ? 0 : 4000;
  ctx.seedTimer = window.setTimeout(() => {
    if (!ctx) return;
    ctx.seedTimer = null;
    if (ctx.rawState) return;
    seedGame();
  }, delay);
}

async function seedGame() {
  if (!ctx || ctx.seedAttempted) return;
  const players = ctx.room.players;
  if (players.length < 2) return;
  ctx.seedAttempted = true;
  try {
    await ctx.room.seedState(() =>
      createInitialState(players.map((p) => ({ playerId: p.playerId, name: p.name, seat: p.seat })))
    );
  } catch (err) {
    console.error('[mahjong] could not deal', err);
    toast(err.message || 'Could not deal the tiles');
    ctx.seedAttempted = false;
  }
}

/* --- move submission -------------------------------------------------------- */

async function submit(move, options) {
  if (!ctx || ctx.busy) return;
  ctx.busy = true;
  const quiet = options && options.quiet;
  try {
    const me = ctx.room.playerId;
    await ctx.room.submitState((current) => applyMove(current, me, move));
    ctx.selected = null;
  } catch (err) {
    if (!quiet) {
      console.warn('[mahjong] move rejected', move, err);
      toast(err.message || 'That move was not allowed');
    }
  } finally {
    if (ctx) ctx.busy = false;
  }
}

function resolveStalledClaims() {
  submit({ type: 'resolveClaims', now: Date.now() }, { quiet: true });
}

/* --- rendering -------------------------------------------------------------- */

function render() {
  if (!ctx) return;
  const { status, table, rail } = ctx.nodes;
  const me = ctx.room.playerId;

  if (!ctx.rawState) {
    status.innerHTML = '';
    status.appendChild(el('span', { text: 'Shuffling…' }));
    table.innerHTML = '';
    table.appendChild(
      el('div', { class: 'boot' }, [el('div', { class: 'boot-msg', text: 'Dealing the tiles…' })])
    );
    rail.innerHTML = '';
    return;
  }

  const view = redactStateFor(ctx.rawState, me);
  const legal = getLegalMoves(view, me);
  const over = isGameOver(view);
  const myHand = view.hands[me] || [];

  // Preserve where the hand rail was scrolled to across re-renders.
  const oldScroll = rail.querySelector('.hand-scroll');
  if (oldScroll) ctx.handScroll = oldScroll.scrollLeft;

  renderStatus(status, view, me, over);
  renderTable(table, view, me, over);
  renderRail(rail, view, me, myHand, legal, over);

  const newScroll = rail.querySelector('.hand-scroll');
  if (newScroll) newScroll.scrollLeft = ctx.handScroll;
}

function nameFor(view, playerId) {
  const seat = view.seats.find((s) => s.playerId === playerId);
  return seat ? seat.name : 'Someone';
}

function renderStatus(status, view, me, over) {
  status.innerHTML = '';

  let label;
  let mine = false;
  if (over) {
    label = view.winner ? `${nameFor(view, view.winner)} wins` : 'Washed-out hand';
  } else if (view.phase === 'claim') {
    const waiting = view.pendingDiscard ? view.pendingDiscard.waitingCount || 0 : 0;
    label = waiting > 0 ? `Claims open · ${waiting} to answer` : 'Resolving claims…';
  } else if (view.turn === me) {
    label = view.phase === 'draw' ? 'Your turn — draw' : 'Your turn — discard';
    mine = true;
  } else {
    label = `${nameFor(view, view.turn)}'s turn`;
  }

  status.appendChild(el('span', { class: mine ? 'turn-pill mine' : 'turn-pill', text: label }));
  status.appendChild(el('span', { class: 'spacer' }));
  status.appendChild(
    el('span', { class: 'wall-count', text: `${view.wallCount} in wall` })
  );
}

function renderTable(table, view, me, over) {
  table.innerHTML = '';

  if (over) {
    table.appendChild(renderResult(view, me));
  }

  // Opponents, in seat order starting from the player after me.
  const order = [];
  const idx = view.seats.findIndex((s) => s.playerId === me);
  for (let i = 1; i < view.seats.length; i += 1) {
    order.push(view.seats[(idx + i) % view.seats.length]);
  }

  const opponents = el('div', { class: 'opponents' });
  for (const seat of order) {
    const pid = seat.playerId;
    const count = view.handCounts[pid] || 0;
    const backs = el('div', { class: 'backs' });
    for (let i = 0; i < Math.min(count, 14); i += 1) backs.appendChild(tileEl(null, { size: 'xs' }));

    const bits = [`${count} tiles`];
    const melds = view.melds[pid] || [];
    if (melds.length) bits.push(`${melds.length} meld${melds.length === 1 ? '' : 's'}`);
    const flowers = view.flowers[pid] || [];
    if (flowers.length) bits.push(`${flowers.length} flower${flowers.length === 1 ? '' : 's'}`);

    const row = el(
      'div',
      { class: view.turn === pid && !over ? 'opponent active' : 'opponent' },
      [
        el('span', { class: 'who' }, [
          el('div', { class: 'nm', text: seat.name }),
          el('div', { class: 'sub', text: bits.join(' · ') })
        ]),
        backs
      ]
    );
    opponents.appendChild(row);

    if (melds.length) {
      const meldWrap = el('div', { class: 'melds' });
      for (const meld of melds) {
        meldWrap.appendChild(
          el(
            'div',
            { class: 'meld', title: `${meld.type}${meld.concealed ? ' (concealed)' : ''}` },
            meld.tiles.map((t) => tileEl(meld.concealed ? null : t, { size: 'xs' }))
          )
        );
      }
      opponents.appendChild(meldWrap);
    }
  }
  table.appendChild(opponents);

  // The centre: the live discard, then the pile.
  const area = el('div', { class: 'discard-area' });

  if (view.pendingDiscard && !over) {
    const pd = view.pendingDiscard;
    const remaining = Math.max(
      0,
      Math.ceil((CLAIM_TIMEOUT_MS - (Date.now() - (pd.at || 0))) / 1000)
    );
    area.appendChild(
      el('div', { class: 'live-discard' }, [
        tileEl(pd.tile, { size: 'lg' }),
        el('span', { class: 'txt' }, [
          el('div', { text: `${nameFor(view, pd.by)} discarded ${tileName(pd.tile)}` }),
          el('div', {
            text:
              pd.waitingCount > 0
                ? `Waiting on ${pd.waitingCount} player${pd.waitingCount === 1 ? '' : 's'} · ${remaining}s`
                : 'Resolving…'
          })
        ])
      ])
    );
  }

  area.appendChild(
    el('div', { class: 'area-label' }, [`Discards (${view.discards.length})`])
  );
  const pile = el('div', { class: 'discard-pile' });
  for (const d of view.discards.slice(-40)) {
    pile.appendChild(tileEl(d.tile, { size: 'sm' }));
  }
  if (view.discards.length === 0) {
    pile.appendChild(el('span', { class: 'hint', text: 'Nothing discarded yet.' }));
  }
  area.appendChild(pile);
  table.appendChild(area);

  if (view.log.length) {
    table.appendChild(
      el('div', { class: 'log' }, view.log.slice(-8).map((line) => el('div', { text: line })))
    );
  }
}

function renderResult(view, me) {
  const scores = getScores(view);
  const card = el('div', { class: 'result-card' });

  if (view.winner) {
    card.appendChild(el('h2', { text: view.winner === me ? 'You win' : 'Hand over' }));
    card.appendChild(
      el('p', {}, [
        el('span', { class: 'who', text: nameFor(view, view.winner) }),
        view.endReason === 'discard'
          ? ' won on a discard.'
          : ' won on a self-draw.'
      ])
    );
  } else {
    card.appendChild(el('h2', { text: 'Washed out' }));
    card.appendChild(el('p', { text: 'The wall ran out before anyone completed a hand.' }));
  }

  const list = el('ul', { class: 'score-list' });
  for (const seat of view.seats) {
    list.appendChild(
      el('li', {}, [
        el('span', { text: seat.name }),
        el('span', { class: 'pts', text: String(scores[seat.playerId] || 0) })
      ])
    );
  }
  card.appendChild(list);
  card.appendChild(
    el('p', { class: 'hint', text: 'Scoring is a flat value per win for now.' })
  );
  return card;
}

function renderRail(rail, view, me, myHand, legal, over) {
  rail.innerHTML = '';

  if (over) {
    const actions = el('div', { class: 'hand-actions' });
    if (ctx.room.isHost) {
      actions.appendChild(
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: 'Deal again',
          onClick: dealAgain
        })
      );
      actions.appendChild(
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'Back to lobby',
          onClick: () => ctx.room.backToLobby()
        })
      );
    } else {
      const waiting = el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        text: 'Waiting for the host'
      });
      waiting.disabled = true;
      actions.appendChild(waiting);
    }
    rail.appendChild(actions);
    return;
  }

  // Claim bar takes over the thumb zone while a claim is open to me.
  const claimMoves = legal.filter((m) => ['pung', 'kong', 'win', 'pass'].includes(m.type));
  if (view.phase === 'claim' && claimMoves.length) {
    const bar = el('div', { class: 'claim-bar' });
    bar.appendChild(
      el('div', { class: 'claim-title' }, [
        `You can claim the ${tileName(view.pendingDiscard.tile)}`
      ])
    );
    const row = el('div', { class: 'btn-row' });
    const order = ['win', 'kong', 'pung', 'pass'];
    const labels = { win: 'Win', kong: 'Kong', pung: 'Pung', pass: 'Pass' };
    for (const type of order) {
      if (!claimMoves.some((m) => m.type === type)) continue;
      row.appendChild(
        el('button', {
          class: type === 'pass' ? 'btn btn-ghost' : 'btn btn-primary',
          type: 'button',
          text: labels[type],
          onClick: () => submit({ type })
        })
      );
    }
    bar.appendChild(row);
    rail.appendChild(bar);
  }

  const flowers = view.flowers[me] || [];
  const header = el('div', { class: 'hand-header' }, [
    `Your hand (${myHand.length})`
  ]);
  if (flowers.length) {
    const fl = el('div', { class: 'flowers' });
    for (const f of flowers) fl.appendChild(tileEl(f, { size: 'xs' }));
    header.appendChild(fl);
  }
  rail.appendChild(header);

  const myMelds = view.melds[me] || [];
  if (myMelds.length) {
    const wrap = el('div', { class: 'melds', style: 'padding: 0 16px 6px' });
    for (const meld of myMelds) {
      wrap.appendChild(
        el('div', { class: 'meld', title: meld.type }, meld.tiles.map((t) => tileEl(t, { size: 'xs' })))
      );
    }
    rail.appendChild(wrap);
  }

  const canDiscard = legal.some((m) => m.type === 'discard');
  const scroll = el('div', { class: 'hand-scroll' });
  const lastDrawn =
    view.lastDrawn && view.lastDrawn.playerId === me ? view.lastDrawn.tile : null;
  let highlighted = false;

  myHand.forEach((tile, i) => {
    const highlight = !highlighted && tile === lastDrawn;
    if (highlight) highlighted = true;
    scroll.appendChild(
      tileEl(tile, {
        selected: ctx.selected === i,
        highlight,
        onClick: canDiscard
          ? () => {
              ctx.selected = ctx.selected === i ? null : i;
              render();
            }
          : null
      })
    );
  });
  rail.appendChild(scroll);

  const actions = el('div', { class: 'hand-actions' });

  if (legal.some((m) => m.type === 'draw')) {
    actions.appendChild(
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: view.wallCount > 0 ? 'Draw a tile' : 'End the hand',
        onClick: () => submit({ type: 'draw' })
      })
    );
  }

  if (legal.some((m) => m.type === 'declareWin')) {
    actions.appendChild(
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Declare a win',
        onClick: () => submit({ type: 'declareWin' })
      })
    );
  }

  if (canDiscard) {
    const selectedTile = ctx.selected === null ? null : myHand[ctx.selected];

    if (
      selectedTile &&
      legal.some((m) => m.type === 'concealedKong' && m.tile === selectedTile)
    ) {
      actions.appendChild(
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: 'Kong',
          onClick: () => submit({ type: 'concealedKong', tile: selectedTile })
        })
      );
    }

    const discardBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: selectedTile ? `Discard ${tileName(selectedTile)}` : 'Pick a tile to discard'
    });
    discardBtn.disabled = !selectedTile;
    discardBtn.addEventListener('click', () => submit({ type: 'discard', tile: selectedTile }));
    actions.appendChild(discardBtn);
  }

  if (actions.childNodes.length) rail.appendChild(actions);
}

async function dealAgain() {
  if (!ctx) return;
  const players = ctx.room.players;
  try {
    await ctx.room.replaceState(
      createInitialState(players.map((p) => ({ playerId: p.playerId, name: p.name, seat: p.seat })))
    );
    ctx.selected = null;
  } catch (err) {
    console.error('[mahjong] could not re-deal', err);
    toast('Could not deal a new hand');
  }
}
