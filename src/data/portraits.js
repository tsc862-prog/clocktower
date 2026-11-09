// Portrait briefs for the art generator. Pure data, browser-safe. Mirrors the Portraits section of
// docs/ROLES.md. Nothing of the official game's art is referenced; keep it that way.
export const PORTRAIT_STYLE =
  'painted portrait, muted palette, soft lamplight, plain dark background, head and shoulders';

const NEGATIVE = 'text, lettering, logo, border, frame, modern clothes, photograph, several people';

export const PORTRAITS = {
  Odette: {
    prompt: 'A woman of about fifty, sturdy and upright, with a long patient face, grey-streaked brown hair pinned flat, and steady dark eyes. A plain wool dress with a clean white collar and ink on her fingers. She holds a small ledger open and keeps a pencil behind her ear. Composed, unhurried, a clerk who has already written it down.',
    negative: NEGATIVE,
  },
  Bram: {
    prompt: 'A man of about forty-five, broad and thick-necked, with a square weathered face, a short grey-flecked beard and cropped dark hair. A heavy canvas work coat over a rough shirt, sleeves pushed up, forearms scarred from the forge. He looks straight out with his jaw set, one fist resting on a hammer handle. Blunt, tired of hedging, ready to say it.',
    negative: NEGATIVE,
  },
  Ines: {
    prompt: 'A young woman of about twenty-five, slight and quick, with a narrow bright face, dark curly hair escaping a loose scarf, and wide attentive eyes, head tilted. A patched green shawl over a cotton blouse, a pencil stub and a folded scrap of paper in her hand. Curious, mid-question, half a smile.',
    negative: NEGATIVE,
  },
  Corwin: {
    prompt: 'A man of about sixty, tall and a little stooped, with a long thoughtful face, thinning white hair, and spectacles pushed low on his nose. A dark waistcoat and a loosened cravat, a pair of brass scales or a pocket watch held loosely in one hand. Careful and kind, brow furrowed, weighing both sides before he speaks.',
    negative: NEGATIVE,
  },
  Thea: {
    prompt: "A woman of about thirty-five, round-faced and sturdy, with warm brown skin, thick black hair in a loose braid over one shoulder, and crinkled eyes. A flour-dusted apron over a rust-coloured dress, sleeves rolled, a small loaf held against her chest. Open and welcoming, the one who learns everyone's name.",
    negative: NEGATIVE,
  },
  Fitch: {
    prompt: "A thin man of about fifty, with a long dry face, sunken cheeks, sparse sandy hair combed flat, and heavy-lidded eyes with one eyebrow raised. A shabby black coat buttoned to the throat, a stub of tobacco unlit between his lips, a gravedigger's or sexton's patient air. Unimpressed, amused by nothing, noticing everything.",
    negative: NEGATIVE,
  },
  Yusuf: {
    prompt: 'A man of about thirty-five, lean and watchful, with olive skin, a trimmed dark beard, short black hair, and narrowed dark eyes that do not quite believe you. A travelling coat with the collar turned up, a leather satchel strap across the chest, arms folded. Guarded, a slight frown, a man who tests a coin by biting it.',
    negative: NEGATIVE,
  },
  Storyteller: {
    prompt: 'An elderly person of indeterminate gender, thin and very still, with a pale lined face, silver hair worn long and tidy, and calm grey eyes. A dark high-collared coat of an old cut, a brass clock key on a chain at the throat, a small book of minutes closed in folded hands. Impassive, courteous, a town clerk who has read out worse weeks than this.',
    negative: NEGATIVE,
  },
};
