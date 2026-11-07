// Trouble Brewing as data. The engine (src/game/) loops over this file; a new script is a new file of the same shape.
// Ability text is ours, in our words (docs/ROLES.md's mechanics column), following the official mechanic exactly.
//
// A role: {id, name, team, ability, wakes, reminders, setup?, misregisters?, disguise?, heir?}
//   id            the official name in kebab-case
//   team          'townsfolk' | 'outsider' | 'minion' | 'demon'
//   wakes         'first' (first night only) | 'each' (every night) | 'other' (every night but the first) |
//                 'when-killed' (an other night on which it died) | 'never'
//   reminders     the grimoire tokens this role puts down
//   setup         a change to the deal while this role is in play: {outsiders: +2} turns two townsfolk into outsiders
//   misregisters  the teams this role may register as to other abilities, at the Storyteller's call each time
//   disguise      the team of the role this seat is told it is (and wakes as), with no ability of its own
//   heir          becomes the demon when the demon dies with at least minAlive players alive (counted before the death)
// firstNight / otherNights: the order seats are woken in; 'minion-info' and 'demon-info' are the two setup tellings.

export const TEAMS = ['townsfolk', 'outsider', 'minion', 'demon'];
export const GOOD = ['townsfolk', 'outsider'];
export const EVIL = ['minion', 'demon'];

export const SCRIPT = {
  id: 'trouble-brewing',
  name: 'Trouble Brewing',
  roles: [
    // townsfolk
    {id: 'washerwoman', name: 'Washerwoman', team: 'townsfolk', wakes: 'first', reminders: ['townsfolk', 'wrong'],
      ability: 'First night: learns that one of two named players is a given townsfolk role.'},
    {id: 'librarian', name: 'Librarian', team: 'townsfolk', wakes: 'first', reminders: ['outsider', 'wrong'],
      ability: 'First night: learns that one of two named players is a given outsider role, or that there are no outsiders.'},
    {id: 'investigator', name: 'Investigator', team: 'townsfolk', wakes: 'first', reminders: ['minion', 'wrong'],
      ability: 'First night: learns that one of two named players is a given minion role.'},
    {id: 'chef', name: 'Chef', team: 'townsfolk', wakes: 'first', reminders: [],
      ability: 'First night: learns how many pairs of evil players sit next to each other.'},
    {id: 'empath', name: 'Empath', team: 'townsfolk', wakes: 'each', reminders: [],
      ability: 'Each night: learns how many of their two nearest living neighbours are evil.'},
    {id: 'fortune-teller', name: 'Fortune Teller', team: 'townsfolk', wakes: 'each', reminders: ['red-herring'],
      ability: 'Each night: picks two players and learns whether either is the demon. One good player, chosen at setup, registers as the demon to this role only.'},
    {id: 'undertaker', name: 'Undertaker', team: 'townsfolk', wakes: 'other', reminders: ['executed'],
      ability: 'Each night except the first: learns which role died by execution that day.'},
    {id: 'monk', name: 'Monk', team: 'townsfolk', wakes: 'other', reminders: ['protected'],
      ability: 'Each night except the first: picks another player, who is safe from the demon that night.'},
    {id: 'ravenkeeper', name: 'Ravenkeeper', team: 'townsfolk', wakes: 'when-killed', reminders: [],
      ability: 'If killed at night, wakes, picks a player and learns that player\'s role.'},
    {id: 'virgin', name: 'Virgin', team: 'townsfolk', wakes: 'never', reminders: ['no-ability'],
      ability: 'The first time this player is nominated, if the nominator is a townsfolk player, the nominator is executed at once.'},
    {id: 'slayer', name: 'Slayer', team: 'townsfolk', wakes: 'never', reminders: ['no-ability'],
      ability: 'Once per game, in the day, publicly picks a player; if that player is the demon, that player dies.'},
    {id: 'soldier', name: 'Soldier', team: 'townsfolk', wakes: 'never', reminders: [],
      ability: 'Cannot be killed by the demon.'},
    {id: 'mayor', name: 'Mayor', team: 'townsfolk', wakes: 'never', reminders: [],
      ability: 'If only three players are alive and no execution happens that day, good wins. If the demon would kill this player at night, the Storyteller may kill another player instead.'},
    // outsiders
    {id: 'butler', name: 'Butler', team: 'outsider', wakes: 'each', reminders: ['master'],
      ability: 'Each night picks a master; may vote only when the master votes.'},
    {id: 'drunk', name: 'Drunk', team: 'outsider', wakes: 'never', reminders: ['is-the-drunk'], disguise: 'townsfolk',
      ability: 'Believes they are a townsfolk role (and is told so) but has no ability. The role they believe they are is kept in the grimoire as a reminder.'},
    {id: 'recluse', name: 'Recluse', team: 'outsider', wakes: 'never', reminders: [], misregisters: ['minion', 'demon'],
      ability: 'May register as evil, or as a minion or demon, to other abilities, at the Storyteller\'s choice each time.'},
    {id: 'saint', name: 'Saint', team: 'outsider', wakes: 'never', reminders: [],
      ability: 'If executed, good loses.'},
    // minions
    {id: 'poisoner', name: 'Poisoner', team: 'minion', wakes: 'each', reminders: ['poisoned'],
      ability: 'Each night picks a player, who is poisoned that night and the next day. A poisoned ability has no effect, and information it gives may be false.'},
    {id: 'spy', name: 'Spy', team: 'minion', wakes: 'each', reminders: [], misregisters: ['townsfolk', 'outsider'],
      ability: 'Each night sees the grimoire. May register as good, or as a townsfolk or outsider role, to other abilities.'},
    {id: 'scarlet-woman', name: 'Scarlet Woman', team: 'minion', wakes: 'never', reminders: ['is-the-demon'], heir: {minAlive: 5},
      ability: 'If five or more players are alive and the demon dies, this player becomes the demon.'},
    {id: 'baron', name: 'Baron', team: 'minion', wakes: 'never', reminders: [], setup: {outsiders: +2},
      ability: 'Setup: there are two more outsiders than usual.'},
    // demon
    {id: 'imp', name: 'Imp', team: 'demon', wakes: 'other', reminders: ['dead'],
      ability: 'Each night except the first: picks a player, who dies. If this player kills themself, a minion becomes the demon.'},
  ],
  firstNight: ['poisoner', 'spy', 'minion-info', 'demon-info', 'butler', 'washerwoman', 'librarian', 'investigator', 'chef', 'empath', 'fortune-teller'],
  otherNights: ['poisoner', 'monk', 'spy', 'imp', 'ravenkeeper', 'undertaker', 'butler', 'empath', 'fortune-teller'],
  // the deal by table size, before setup changes
  setup: {
    5: {townsfolk: 3, outsiders: 0, minions: 1, demon: 1},
    6: {townsfolk: 3, outsiders: 1, minions: 1, demon: 1},
    7: {townsfolk: 5, outsiders: 0, minions: 1, demon: 1},
    8: {townsfolk: 5, outsiders: 1, minions: 1, demon: 1},
    9: {townsfolk: 5, outsiders: 2, minions: 1, demon: 1},
    10: {townsfolk: 7, outsiders: 0, minions: 2, demon: 1},
    11: {townsfolk: 7, outsiders: 1, minions: 2, demon: 1},
    12: {townsfolk: 7, outsiders: 2, minions: 2, demon: 1},
    13: {townsfolk: 9, outsiders: 0, minions: 3, demon: 1},
    14: {townsfolk: 9, outsiders: 1, minions: 3, demon: 1},
    15: {townsfolk: 9, outsiders: 2, minions: 3, demon: 1},
  },
  // the first-night tellings that are not a role, and how many good roles not in play the demon is shown
  tellings: ['minion-info', 'demon-info'],
  bluffs: 3,
};

// The seven seats (docs/ROLES.md); a table of another size takes the first n and numbers the rest.
export const SEAT_NAMES = ['Odette', 'Bram', 'Ines', 'Corwin', 'Thea', 'Fitch', 'Yusuf'];

export default SCRIPT;
