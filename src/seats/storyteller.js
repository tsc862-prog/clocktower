// The Storyteller's state header for one turn. STUB from the rules-keeper (slice 3); the storyteller-builder replaces this file.
import {grimoire} from '../game/api.js';

export const storytellerHeader = game => {const g = grimoire(game); return `${g.phase}${g.phase === 'night' ? ' ' + g.night : g.phase === 'day' ? ' ' + g.day : ''}. ${g.pending ? `A ${g.pending.kind} decision waits on you.` : 'Nothing waits on you.'}`};
