// What each role does, keyed by role id. The phase code (engine.js) never names a role: it walks the script's night
// order and calls the hooks of whatever is in play. A seat acts as the role it believes it is (the Drunk acts as its
// townsfolk role), and every hook checks malfunctioning() itself: a drunk or poisoned ability acts with no effect.
//
// Hooks: setup(state, i)            once, before the first night
//        firstNight(state, i)       its turn in the first night's order
//        otherNight(state, i)       its turn in the other nights' order
//        wakeIf(state, i)           whether it wakes at its turn (default: alive)
//        dayAction: {available(state, i), options(state, i), question, act(state, i, target)}
//                                   a standing public act the seat may call at any moment of the day (never at dawn,
//                                   never blocking): offered on the day's table decision (pending.dayActions)
//        onNominated(state, i, by)  when this seat is nominated; may return {endDay: true}
//        voteCounts(state, i, votes)  whether this seat's yes counts in this vote
//        onExecuted(state, i)       when this seat is executed
//        safeFromDemon(state, i)    true: the demon's kill does nothing
//        onDemonTarget(state, i, by)  may redirect the demon's kill; returns the seat that is attacked
//        endOfDay(state, i, {executed})  at dusk
import {
  roleName, teamOf, isEvilTeam, alive, aliveCount, addToken, hasToken, findToken, removeTokens, malfunctioning,
  livingNeighbours, log, tell, grimoire,
} from './grimoire.js';
import {ask, choose, perceive, inform, die, demonKill, execute, win, checkWin} from './mechanics.js';

const others = (state, i) => state.seats.filter(s => s.index !== i).map(s => s.index);
const aliveSeats = state => alive(state).map(s => s.index);
const aliveOthers = (state, i) => alive(state).filter(s => s.index !== i).map(s => s.index);
const allSeats = state => state.seats.map(s => s.index);
const pairs = list => {const out = []; for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) out.push([list[a], list[b]]); return out};
const sorted = arr => [...arr].sort((a, b) => a - b);
const rolesOfTeam = (state, team) => state.script.roles.filter(r => r.team === team).map(r => r.id);

// The Washerwoman, Librarian and Investigator: one of two players is a given role of `team`.
const pinger = (id, team, allowNone) => function* (state, i) {
  const seats = others(state, i), bad = malfunctioning(state, i);
  const reg = bad ? {} : yield* perceive(state, seats, r => (teamOf(state, r) === team ? r : null), `to the ${roleName(state, id)}`);
  const build = asRole => {
    const out = [];
    for (const x of seats) {
      const r = asRole(x);
      if (teamOf(state, r) !== team) continue;
      for (const y of seats) if (y !== x) out.push({players: sorted([x, y]), role: r});
    }
    return out;
  };
  let truth = build(x => reg[x] ?? state.seats[x].role);
  if (!truth.length && !allowNone) truth = build(x => state.seats[x].role); // a registration may not leave nothing to say
  if (!truth.length && allowNone) truth = [{none: true}];
  const all = [];
  for (const r of rolesOfTeam(state, team)) for (const p of pairs(seats)) all.push({players: p, role: r});
  if (allowNone) all.push({none: true});
  yield* inform(state, i, id, {truth, all, question: allowNone ? `One of two players is a given ${team}, or there are none.` : `One of two players is a given ${team}.`});
};

const evilAs = state => r => isEvilTeam(teamOf(state, r));

function* fortuneTeller(state, i) {
  const picks = yield choose(state, i, 'fortune-teller', allSeats(state), 'pick two players: is either the demon?', {count: 2});
  const bad = malfunctioning(state, i);
  const reg = bad ? {} : yield* perceive(state, picks, r => teamOf(state, r) === 'demon', 'to the Fortune Teller');
  const yes = picks.some(p => teamOf(state, reg[p] ?? state.seats[p].role) === 'demon' || hasToken(state, p, 'red-herring'));
  yield* inform(state, i, 'fortune-teller', {truth: [yes], all: [true, false], question: `Is either ${picks.map(p => state.seats[p].name).join(' or ')} the demon?`, about: {picks}});
}

function* empath(state, i) {
  const n = livingNeighbours(state, i), bad = malfunctioning(state, i);
  const reg = bad ? {} : yield* perceive(state, n, evilAs(state), 'to the Empath');
  const count = n.filter(x => isEvilTeam(teamOf(state, reg[x] ?? state.seats[x].role))).length;
  yield* inform(state, i, 'empath', {truth: [count], all: Array.from({length: n.length + 1}, (_, k) => k), question: 'How many of their living neighbours are evil?', about: {neighbours: n}});
}

function* chef(state, i) {
  const seats = allSeats(state), bad = malfunctioning(state, i), len = seats.length;
  const reg = bad ? {} : yield* perceive(state, seats, evilAs(state), 'to the Chef');
  const evil = x => isEvilTeam(teamOf(state, reg[x] ?? state.seats[x].role));
  let count = 0;
  for (let x = 0; x < (len === 2 ? 1 : len); x++) if (evil(x) && evil((x + 1) % len)) count++;
  yield* inform(state, i, 'chef', {truth: [count], all: Array.from({length: len}, (_, k) => k), question: 'How many pairs of evil players sit side by side?'});
}

// The role a seat registers as, for the Undertaker and the Ravenkeeper.
function* learnRole(state, i, id, target, why) {
  const bad = malfunctioning(state, i);
  const reg = bad ? {} : yield* perceive(state, [target], r => r, why);
  const truth = [reg[target] ?? state.seats[target].role];
  yield* inform(state, i, id, {truth, all: state.script.roles.map(r => r.id), question: `What role is ${state.seats[target].name}?`, about: {target}});
}

const executedYesterday = state => state.executed.filter(e => e.day === state.night - 1).at(-1) || null;

export const TELLINGS = {
  // The minions learn the demon (and each other); seven seats or more.
  'minion-info': function* (state) {
    if (state.seats.length < 7) return;
    const demon = alive(state).filter(s => s.team === 'demon').map(s => s.index), minions = alive(state).filter(s => s.team === 'minion').map(s => s.index);
    for (const m of minions) tell(state, m, 'minion-info', {demon, minions});
  },
  // The demon learns its minions and is shown good roles not in play to bluff with.
  'demon-info': function* (state) {
    if (state.seats.length < 7) return;
    const demon = alive(state).filter(s => s.team === 'demon').map(s => s.index), minions = alive(state).filter(s => s.team === 'minion').map(s => s.index);
    const taken = new Set(state.seats.flatMap(s => [s.role, s.believed]));
    const options = state.script.roles.filter(r => !isEvilTeam(r.team) && !taken.has(r.id)).map(r => r.id);
    const count = Math.min(state.script.bluffs || 0, options.length);
    if (count) state.bluffs = yield ask(state, {kind: 'demon-bluffs', seat: 'storyteller', options, count, question: `Which ${count} good roles not in play is the demon shown?`});
    for (const d of demon) tell(state, d, 'demon-info', {minions, bluffs: state.bluffs});
  },
};

export const HOOKS = {
  washerwoman: {firstNight: pinger('washerwoman', 'townsfolk', false)},
  librarian: {firstNight: pinger('librarian', 'outsider', true)},
  investigator: {firstNight: pinger('investigator', 'minion', false)},
  chef: {firstNight: chef},
  empath: {firstNight: empath, otherNight: empath},
  'fortune-teller': {
    *setup(state, i) {
      const options = state.seats.filter(s => !isEvilTeam(s.team)).map(s => s.index);
      const v = yield ask(state, {kind: 'red-herring', seat: 'storyteller', subject: i, options, question: `Which good player registers as the demon to ${state.seats[i].name}, the Fortune Teller?`});
      addToken(state, v, {token: 'red-herring', role: 'fortune-teller', keep: true});
    },
    firstNight: fortuneTeller, otherNight: fortuneTeller,
  },
  undertaker: {
    wakeIf: (state, i) => state.seats[i].alive && !!executedYesterday(state),
    *otherNight(state, i) {
      const e = executedYesterday(state);
      addToken(state, e.seat, {token: 'executed', role: 'undertaker', by: i, until: 'dawn'});
      yield* learnRole(state, i, 'undertaker', e.seat, 'to the Undertaker');
    },
  },
  monk: {
    *otherNight(state, i) {
      const v = yield choose(state, i, 'monk', aliveOthers(state, i), 'pick another player to keep safe from the demon tonight');
      addToken(state, v, {token: 'protected', role: 'monk', by: i, until: 'dawn', shields: 'demon', active: !malfunctioning(state, i)});
      log(state, 'acted', {seat: i, role: 'monk', target: v});
    },
  },
  ravenkeeper: {
    wakeIf: (state, i) => state.diedTonight.includes(i),
    *otherNight(state, i) {
      const v = yield choose(state, i, 'ravenkeeper', allSeats(state), 'you died tonight: pick a player to learn their role');
      yield* learnRole(state, i, 'ravenkeeper', v, 'to the Ravenkeeper');
    },
  },
  virgin: {
    *onNominated(state, i, by) {
      if (hasToken(state, i, 'no-ability', t => t.role === 'virgin')) return;
      addToken(state, i, {token: 'no-ability', role: 'virgin', by: i, keep: true});
      if (malfunctioning(state, i)) {log(state, 'no-effect', {seat: i, role: 'virgin'}); return}
      const reg = yield* perceive(state, [by], r => teamOf(state, r) === 'townsfolk', 'to the Virgin');
      if (teamOf(state, reg[by]) !== 'townsfolk') return;
      log(state, 'virgin', {seat: i, nominator: by});
      yield* execute(state, by, 'virgin');
      return {endDay: true};
    },
  },
  slayer: {
    // A standing day action: the living Slayer with the shot unspent may call it at any moment of the day (game 1, #37:
    // a shot offered only at dawn, before any talk, was held every time). Not offered at dawn and never blocking.
    dayAction: {
      available: (state, i) => state.seats[i].alive && !hasToken(state, i, 'no-ability', t => t.role === 'slayer'),
      options: state => aliveSeats(state),
      question: 'your shot is unspent: you may shoot a player at any moment today (they die if they are the demon), or keep it (null)',
      *act(state, i, v) {
        addToken(state, i, {token: 'no-ability', role: 'slayer', by: i, keep: true});
        log(state, 'slayer-shot', {seat: i, target: v});
        if (malfunctioning(state, i)) {log(state, 'no-effect', {seat: i, role: 'slayer'}); return}
        const reg = yield* perceive(state, [v], r => teamOf(state, r) === 'demon', 'to the Slayer');
        if (teamOf(state, reg[v]) !== 'demon') {log(state, 'no-death', {seat: v, why: 'not the demon'}); return}
        yield* die(state, v, 'slayer', i);
        checkWin(state);
      },
    },
  },
  soldier: {safeFromDemon: (state, i) => !malfunctioning(state, i)},
  mayor: {
    *onDemonTarget(state, i, by) {
      if (malfunctioning(state, i)) return i;
      const options = [i, ...aliveSeats(state).filter(x => x !== i && x !== by)];
      return yield ask(state, {kind: 'mayor-bounce', seat: 'storyteller', subject: i, options, question: `The demon attacks ${state.seats[i].name}, the Mayor: does the Mayor die, or another player instead?`});
    },
    *endOfDay(state, i, {executed}) {
      if (executed != null || !state.seats[i].alive || malfunctioning(state, i) || aliveCount(state) !== 3) return;
      win(state, 'good', 'mayor', `good wins by the Mayor: three alive and no execution on day ${state.day}`);
    },
  },
  butler: {
    *firstNight(state, i) {yield* butlerNight(state, i)},
    *otherNight(state, i) {yield* butlerNight(state, i)},
    voteCounts(state, i, votes) {
      if (!state.seats[i].alive || malfunctioning(state, i)) return true;
      const m = findToken(state, 'master', t => t.by === i && t.active);
      return !m || votes[m.on] === true;
    },
  },
  saint: {
    *onExecuted(state, i) {
      if (malfunctioning(state, i)) return;
      win(state, 'evil', 'saint', `evil wins by the execution of the Saint on day ${state.day}`);
    },
  },
  poisoner: {firstNight: poisonerNight, otherNight: poisonerNight},
  spy: {
    *firstNight(state, i) {tell(state, i, 'grimoire', {grimoire: grimoire(state)})},
    *otherNight(state, i) {tell(state, i, 'grimoire', {grimoire: grimoire(state)})},
  },
  imp: {
    *otherNight(state, i) {
      const v = yield choose(state, i, 'imp', aliveSeats(state), 'pick a player to kill tonight (yourself to pass the demon to a minion)');
      log(state, 'acted', {seat: i, role: 'imp', target: v});
      if (malfunctioning(state, i)) {log(state, 'no-effect', {seat: i, role: 'imp'}); return}
      if (v === i) yield* die(state, i, 'star-pass', i, {starPass: true});
      else yield* demonKill(state, i, v);
      checkWin(state);
    },
  },
};

function* poisonerNight(state, i) {
  removeTokens(state, t => t.token === 'poisoned' && t.by === i);
  const v = yield choose(state, i, 'poisoner', aliveSeats(state), 'pick a player to poison tonight and tomorrow');
  addToken(state, v, {token: 'poisoned', role: 'poisoner', by: i, active: !malfunctioning(state, i)});
  log(state, 'acted', {seat: i, role: 'poisoner', target: v});
}

function* butlerNight(state, i) {
  removeTokens(state, t => t.token === 'master' && t.by === i);
  const v = yield choose(state, i, 'butler', aliveOthers(state, i), 'pick your master: tomorrow you may vote only when they vote');
  addToken(state, v, {token: 'master', role: 'butler', by: i, active: !malfunctioning(state, i)});
  log(state, 'acted', {seat: i, role: 'butler', target: v});
}

// Every role in a script must be either here or plainly passive (its rule lives in the data: disguise, misregisters,
// heir, setup). gamecheck holds this.
export const PASSIVE = role => !!(role.disguise || role.misregisters || role.heir || role.setup);
