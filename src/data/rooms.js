// The day's places besides the Square: a few rooms of fixed sizes where a small group talks out of the table's hearing (#28).
// Data only; src/game/api.js runs them. The ids and names are placeholders the lore-keeper renames (docs/ROLES.md).
//   id     the room's id in code and in every event ('room' on a line or a move)
//   name   how the table names it in a sentence ("Odette and Bram went to the nook.")
//   size   the most seats it holds at once
// The Square (everyone hears) is no room: a seat at the Square has place null.
export const ROOMS = [
  {id: 'nook', name: 'the nook', size: 2},
  {id: 'parlour', name: 'the parlour', size: 3},
  {id: 'backroom', name: 'the back room', size: 4},
];
export const SQUARE = {id: null, name: 'the Square'};
