# Roles: the canon

Every name and word here is ours. The mechanics follow the genre; the words do not. If a name is added or
changed anywhere, it is changed here in the same PR.

## The setting

**Thistlewick** is a small town of one street, a market square and a clocktower that has kept good time
for two hundred years. Last week it struck thirteen. Since then the baker has not been the baker, the
lamps burn when no one lit them, and someone among the neighbours is feeding the hour something it
should not have. The first script is **The Stopped Hour**: seven neighbours, one night at a time, and a
tower that will not strike twelve until the town has dealt with what is wrong.

## The teams

Our words for the teams stay the generic ones.

- **Town**: good, the many. Each carries a small gift of knowledge or protection.
- **Outsider**: good, but a burden to the town's side.
- **Minion**: evil, serves the demon and knows who it is.
- **Demon**: evil, kills at night.

At the start the demon learns its minions and is shown three good roles not in play (its bluffs); the
minions learn who the demon is. The seven-seat table is 5 town, 0 outsiders, 1 minion, 1 demon before
setup changes (the Landlord adds two outsiders and takes two town away).

## The roles

"Wakes" says when the Storyteller wakes the seat; the order is in the night order below.

### Town (13)

| Name | Id | Mechanic | Wakes | Flavour |
| --- | --- | --- | --- | --- |
| Gossip | `gossip` | First night: learns that one of two named players is a given town role. | First night | Heard it from someone who heard it from someone. |
| Almoner | `almoner` | First night: learns that one of two named players is a given outsider role, or that there are no outsiders. | First night | Knows who needs the bread. |
| Tipster | `tipster` | First night: learns that one of two named players is a given minion role. | First night | A coin in the right hand, a name in the left. |
| Busybody | `busybody` | First night: learns how many pairs of evil players sit next to each other. | First night | Counts who stands too close. |
| Watchman | `watchman` | Each night: learns how many of their two living neighbours are evil. | Every night | Walks the same two doors until dawn. |
| Dowser | `dowser` | Each night: picks two players and learns whether either is the demon. One good player is chosen at setup to register as the demon to this role only. | Every night | The rod dips, and sometimes it dips for an honest neighbour. |
| Gravedigger | `gravedigger` | Each night except the first: learns which role died by execution that day. | Other nights | Knows every name on the stones. |
| Warden | `warden` | Each night except the first: picks another player, who is safe from the demon that night. | Other nights | Locks one door and keeps the key. |
| Confessor | `confessor` | If killed at night, wakes, picks a player and learns that player's role. | When killed at night | Always has one more question. |
| Magistrate | `magistrate` | The first time this player is nominated, if the nominator is a town player, the nominator is executed at once. | Never | Does not like being called to account. |
| Sharpshooter | `sharpshooter` | Once per game, in the day, publicly picks a player; if that player is the demon, that player dies. | Never (acts by day) | One shot, and everyone hears it. |
| Tanner | `tanner` | Cannot be killed by the demon. | Never | Hide like old boot leather. |
| Reeve | `reeve` | If only three players are alive and no execution happens that day, good wins. If the demon would kill this player at night, the Storyteller may kill another player instead. | Never | The town's elected worry. |

### Outsiders (4)

| Name | Id | Mechanic | Wakes | Flavour |
| --- | --- | --- | --- | --- |
| Apprentice | `apprentice` | Each night picks a master; may vote only on days when the master votes. | Every night | Does nothing without being shown first. |
| Tippler | `tippler` | Believes they are a town role (and is told so) but has no ability. The role they believe they are is kept in the grimoire as a reminder. | Never (is told at setup) | Sure of it, every time, and wrong. |
| Misfit | `misfit` | May register as evil, or as a minion or demon, to other abilities, at the Storyteller's choice each time. | Never | Looks wrong from every side. |
| Blameless | `blameless` | If executed, good loses. | Never | Whatever happens, this one must not hang. |

### Minions (4)

| Name | Id | Mechanic | Wakes | Flavour |
| --- | --- | --- | --- | --- |
| Brewer | `brewer` | Each night picks a player, who is poisoned that night and the next day. A poisoned ability has no effect, and information it gives may be false. | Every night | Kind to your tea. |
| Eavesdropper | `eavesdropper` | Each night sees the grimoire. May register as good, or as a town or outsider role, to other abilities. | Every night | Knows what the walls know. |
| Understudy | `understudy` | If five or more players are alive and the demon dies, this player becomes the demon. | Never | Learned the lines long ago. |
| Landlord | `landlord` | Setup: there are two more outsiders than usual. | Never | Collects rent from the unlucky. |

### Demon (1)

| Name | Id | Mechanic | Wakes | Flavour |
| --- | --- | --- | --- | --- |
| Thirteenth Stroke | `thirteenth-stroke` | Each night except the first: picks a player, who dies. If this player kills themself, a minion becomes the demon. | Other nights | The strike that should not have come. |

## The night order

Poison first, then information, with the demon's kill before the roles that react to a death. A seat is
woken only if its role is in play. Roles marked "never" are not woken.

**First night**
1. Brewer
2. Eavesdropper
3. Demon and minion information: the minions learn who the demon is; the demon learns its minions and is shown three good roles not in play
4. Apprentice
5. Gossip
6. Almoner
7. Tipster
8. Busybody
9. Watchman
10. Dowser

**Other nights**
1. Brewer
2. Warden
3. Eavesdropper
4. Thirteenth Stroke
5. Confessor (only if killed this night, immediately after the kill)
6. Gravedigger
7. Apprentice
8. Watchman
9. Dowser

## The seven seats

The characters at the table, as the watcher sees them: **Odette, Bram, Ines, Corwin, Thea, Fitch, Yusuf**.
Roles are dealt to seats at random; a name belongs to a character, not to a role.

## The overlay

For the owner's private play only. `overlay.local.json` at the repo root is git-ignored and maps our ids
to the names of the game we are shaped after:

```json
{ "our-id": "the official name" }
```

Every check passes with the file absent. `npm run rightscheck` uses its values, when present, as a
blocklist over the tracked files. The file and its values never enter the repo, an issue, a PR or a commit.

## Voice

The Storyteller narrates plainly and a little dry, like a town clerk reading the minutes of a bad week.
It says what happened and no more, and it is never cute. Thistlewick's own names (the Square, the Tower,
Lamp Row) are used without comment, as if everyone already knew them.
