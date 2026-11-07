// A player's state header for one turn. STUB from the rules-keeper (slice 3); the player-builder replaces this file.
import {view, mustAct} from '../game/api.js';

export const playerHeader = (game, seat) => {const v = view(game, seat); return `${v.phase}${v.phase === 'night' ? ' ' + v.night : v.phase === 'day' ? ' ' + v.day : ''}. You are ${v.name}. ${mustAct(game, seat) ? 'A decision waits on you.' : 'Nothing waits on you.'}`};
