/*
 * The game catalogue.
 *
 * Adding a game means: write js/games/<id>/rules.js and js/games/<id>/ui.js,
 * then add one entry here. Nothing else in the app needs to change.
 *
 * Descriptor contract:
 *   id          string, unique, matches the folder name and meta.gameId
 *   name        display name
 *   blurb       one line for the card
 *   minPlayers  Start stays disabled below this
 *   maxPlayers  joins are refused above this
 *   enabled     false renders the card greyed with a "Coming soon" tag
 *   load        () => import("./<id>/ui.js"), only called when a game starts
 */

export const GAMES = [
  {
    id: 'mahjong',
    name: 'Mah Jong',
    blurb: 'Tile matching with house rules',
    minPlayers: 2,
    maxPlayers: 4,
    enabled: true,
    load: () => import('./mahjong/ui.js')
  },
  {
    id: 'hearts',
    name: 'Hearts',
    blurb: 'Avoid the queen, or take her and everything else',
    minPlayers: 3,
    maxPlayers: 4,
    enabled: false,
    load: () => import('./hearts/ui.js')
  },
  {
    id: 'rummy',
    name: 'Gin Rummy',
    blurb: 'Runs, sets, and knocking early',
    minPlayers: 2,
    maxPlayers: 4,
    enabled: false,
    load: () => import('./rummy/ui.js')
  }
];

export function getGame(id) {
  return GAMES.find((game) => game.id === id) || null;
}
