# Roles: the skin, the seats and the voice

The game is played as Trouble Brewing with its official role names (the ids in code are those names in
kebab-case). This file keeps three things: a skin of our own names for every role, mapped to the official
ones below, ready for a public release that would need it; the seven seat names; and the voice. The
mechanics column is ours in our words and is what the engine's ability text follows. If a seat name or a
flavour line changes anywhere, it changes here in the same PR.

## The setting

**Thistlewick** is a small town of one street, a market square and a clocktower that has kept good time
for two hundred years. Last week it struck thirteen. Since then the baker has not been the baker, the
lamps burn when no one lit them, and someone among the neighbours is feeding the hour something it
should not have. The first script is **The Stopped Hour**: seven neighbours, one night at a time, and a
tower that will not strike twelve until the town has dealt with what is wrong.

### The three rooms

On most days the whole town talks in the Square and everyone hears. For a word out of earshot there are
three places besides, of three sizes. A player says "take Bram to the Snug" and the table sees who went
where; the words stay inside. The ids in code (`nook`, `parlour`, `backroom`, in `src/data/rooms.js`) were
written first and stay; the names below are what the page and the Storyteller say.

| Place | Id | Holds | Flavour |
| --- | --- | --- | --- |
| **the Snug** | `nook` | 2 | The bench behind the Wick and Candle's stove, where two people sit knee to knee and nobody else can hear. |
| **the Vestry** | `parlour` | 3 | The cold little room off the Tower stair where the clock committee used to count the collection. |
| **the Taproom** | `backroom` | 4 | The inn's low back room, with a long table and a door that sticks. |

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

Each character has a manner at the table, given to its seat in the system prompt (`SEAT_MANNERS` in
`src/data/prompts.js`) so seven seats played by one model do not speak as one voice. A manner is how the
character talks, never which side it is on.

| Seat | Manner |
| --- | --- |
| Odette | Methodical: keeps the order of who said what and lays it out before concluding. |
| Bram | Blunt: says the plain thing first, in few words; little patience for hedging. |
| Ines | Curious: asks more than she tells; wants to know why someone said a thing. |
| Corwin | Cautious: slow to accuse, weighs both sides out loud, changes his mind for a reason. |
| Thea | Warm: speaks to people by name, looks for who can be trusted, stands up for the quiet ones. |
| Fitch | Dry: few words and a flat aside; points out what does not add up. |
| Yusuf | Suspicious: trusts a claim once it is tested; pushes back when the table agrees too fast. |

## The official names

The ids in code and the names the agents and the page use today are the official ones. The skin above
maps onto them as follows; a public release would swap the right column for the left.

| Ours | Official | Team |
| --- | --- | --- |
| Gossip | Washerwoman | townsfolk |
| Almoner | Librarian | townsfolk |
| Tipster | Investigator | townsfolk |
| Busybody | Chef | townsfolk |
| Watchman | Empath | townsfolk |
| Dowser | Fortune Teller | townsfolk |
| Gravedigger | Undertaker | townsfolk |
| Warden | Monk | townsfolk |
| Confessor | Ravenkeeper | townsfolk |
| Magistrate | Virgin | townsfolk |
| Sharpshooter | Slayer | townsfolk |
| Tanner | Soldier | townsfolk |
| Reeve | Mayor | townsfolk |
| Apprentice | Butler | outsider |
| Tippler | Drunk | outsider |
| Misfit | Recluse | outsider |
| Blameless | Saint | outsider |
| Brewer | Poisoner | minion |
| Eavesdropper | Spy | minion |
| Understudy | Scarlet Woman | minion |
| Landlord | Baron | minion |
| Thirteenth Stroke | Imp | demon |

## Voice

The Storyteller narrates plainly and a little dry, like a town clerk reading the minutes of a bad week.
It says what happened and no more, and it is never cute. Thistlewick's own names (the Square, the Tower,
Lamp Row, the Snug, the Vestry, the Taproom) are used without comment, as if everyone already knew them.

At each dawn and each execution the Storyteller's header offers one touch of the town to put in its own
words: a dozen for dawns and eight for dusks in `src/data/colour.js`, picked by the game's seed and never
repeated within a game. They use the names above, the Wick and Candle, the baker, the rooks on the Tower
rail, and two more of our own: **the millpond** below **the mill** at the end of the one street, where a
heron stands in the shallows.

### The voices

Each seat and the Storyteller speaks with a fixed voice of the local speech engine (Kokoro-FastAPI), in
`src/data/voices.js`; `voiceFor(name)` gives `{voice, speed}`, and an unknown name gets the default
(`af_heart`). The first letter of an id is the accent (a American, b British), the second the sex (f, m).
Seven voices a listener can tell apart, mixed on both counts; speed is held within 0.9 to 1.1.

| Seat | Voice | Speed | Why |
| --- | --- | --- | --- |
| Odette | `bf_emma` | 0.95 | British, even and unhurried: reads the order out. |
| Bram | `am_michael` | 1.1 | American, brisk and flat: few words, said fast. |
| Ines | `af_bella` | 1.05 | American, bright and quick: the one with the question. |
| Corwin | `bm_george` | 0.9 | British, slow and low: weighing it as he goes. |
| Thea | `af_heart` | 1.0 | American, warm and open: the default voice. |
| Fitch | `bm_lewis` | 1.0 | British, level: the flat aside. |
| Yusuf | `am_fenrir` | 1.0 | American, deeper and guarded: not yet convinced. |
| Storyteller | `bm_daniel` | 0.95 | British, plain and a little dry: the clerk reading the minutes. |

### The night aloud

With the page's Voice on, the Storyteller tells the watcher the night as it happens, in its own plain voice
(`nightSpoken` in `src/ui/voice.js`); the same words make the night's list on the page. A role is named by
its display name.

| Event | Spoken |
| --- | --- |
| A seat is woken | The Storyteller wakes {Name}, the {Role}. |
| The Drunk is woken | The Storyteller wakes {Name}, the {Believed role}, who is truly the Drunk. |
| The Poisoner chooses | {Name} poisons {Target}. |
| The Monk chooses | {Name} guards {Target}. |
| The Imp or the Ravenkeeper chooses | {Name}, the {Role}, chooses {Target}. |
| The Fortune Teller chooses | {Name}, the Fortune Teller, checks {A} and {B}. |
| The Butler chooses | {Name}, the Butler, picks {Target} as master. |
| Any other choice | {Name}, the {Role}, picks {Target}. (No one: "nobody".) |
| A seat is told something | The Storyteller tells {Name}: {what the seat is told, as the seat hears it} |
| A death at night | {Name} dies. |
| The kill passes | The kill passes from {A} to {B}. |

Before dawn each seat's thought is said in its own voice, after the Storyteller's tag "{Name}, thinking.";
in the night's list it reads "{Name} thinks: {thought}", and in the talk it is marked "{Name} thinks, unheard".

## Portraits

One portrait per seat and one for the Storyteller, made by an image generator from the briefs below
(also in `src/data/portraits.js`). All eight share one style so they hang together; the owner may change
the style line and every brief follows. Rule: nothing of the official game's art is referenced, named or
imitated in a brief, and no official token, icon or frame appears. The characters are our own townsfolk.

**Style line (all eight):** painted portrait, muted palette, soft lamplight, plain dark background, head and shoulders

- **Odette.** A woman of about fifty, sturdy and upright, with a long patient face, grey-streaked brown hair pinned flat, and steady dark eyes. A plain wool dress with a clean white collar and ink on her fingers. She holds a small ledger open and keeps a pencil behind her ear. Composed, unhurried, a clerk who has already written it down.
- **Bram.** A man of about forty-five, broad and thick-necked, with a square weathered face, a short grey-flecked beard and cropped dark hair. A heavy canvas work coat over a rough shirt, sleeves pushed up, forearms scarred from the forge. He looks straight out with his jaw set, one fist resting on a hammer handle. Blunt, tired of hedging, ready to say it.
- **Ines.** A young woman of about twenty-five, slight and quick, with a narrow bright face, dark curly hair escaping a loose scarf, and wide attentive eyes, head tilted. A patched green shawl over a cotton blouse, a pencil stub and a folded scrap of paper in her hand. Curious, mid-question, half a smile.
- **Corwin.** A man of about sixty, tall and a little stooped, with a long thoughtful face, thinning white hair, and spectacles pushed low on his nose. A dark waistcoat and a loosened cravat, a pair of brass scales or a pocket watch held loosely in one hand. Careful and kind, brow furrowed, weighing both sides before he speaks.
- **Thea.** A woman of about thirty-five, round-faced and sturdy, with warm brown skin, thick black hair in a loose braid over one shoulder, and crinkled eyes. A flour-dusted apron over a rust-coloured dress, sleeves rolled, a small loaf held against her chest. Open and welcoming, the one who learns everyone's name.
- **Fitch.** A thin man of about fifty, with a long dry face, sunken cheeks, sparse sandy hair combed flat, and heavy-lidded eyes with one eyebrow raised. A shabby black coat buttoned to the throat, a stub of tobacco unlit between his lips, a gravedigger's or sexton's patient air. Unimpressed, amused by nothing, noticing everything.
- **Yusuf.** A man of about thirty-five, lean and watchful, with olive skin, a trimmed dark beard, short black hair, and narrowed dark eyes that do not quite believe you. A travelling coat with the collar turned up, a leather satchel strap across the chest, arms folded. Guarded, a slight frown, a man who tests a coin by biting it.
- **Storyteller.** An elderly person of indeterminate gender, thin and very still, with a pale lined face, silver hair worn long and tidy, and calm grey eyes. A dark high-collared coat of an old cut, a brass clock key on a chain at the throat, a small book of minutes closed in folded hands. Impassive, courteous, a town clerk who has read out worse weeks than this.
