# Your own token images (never committed)

Drop images here and the page uses them in place of its drawn tokens, in the square and the grimoire. Everything in this
folder except this README is git-ignored: the images stay on your machine and the public repo stays a fan project with none of
the official art in it.

One image per token, PNG or WebP, named by its id (`imp.png` or `imp.webp`; when both are there the PNG wins), square, with a
transparent background (256 x 256 or larger looks best):

- Roles, by the role id: `washerwoman`, `librarian`, `investigator`, `chef`, `empath`, `fortune-teller`, `undertaker`, `monk`,
  `ravenkeeper`, `virgin`, `slayer`, `soldier`, `mayor`, `butler`, `drunk`, `recluse`, `saint`, `poisoner`, `spy`,
  `scarlet-woman`, `baron`, `imp` (so `fortune-teller.webp`, `scarlet-woman.png`, ...).
- Optional: `shroud` (laid over a dead seat), `ghost-vote` (the ghost vote coin).
- Optional reminders, by the reminder id: `poisoned`, `is-the-drunk`, `protected`, `master`, `red-herring`, `dead`, `executed`,
  `no-ability`, `registers-as`, `is-the-demon`.

Any token without an image keeps its drawn one. The page looks once when it loads: reload it after adding images. The game bar
says "local art: N of 22 tokens" when it found any.
