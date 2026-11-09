# Lore keeper memory

- Seat names in use: Odette, Bram, Ines, Corwin, Thea, Fitch, Yusuf (manners in docs/ROLES.md). The town is Thistlewick, the script The Stopped Hour. Owner approval of the skin names is not recorded yet; nothing rejected so far.
- Tone: the Storyteller is plain, a little dry, never cute, like a town clerk reading the minutes.
- Voices (2026-11-08, PR for #50, proposed, awaiting owner ears): Odette bf_emma 0.95, Bram am_michael 1.1, Ines af_bella 1.05, Corwin bm_george 0.9, Thea af_heart 1.0, Fitch bm_lewis 1.0, Yusuf am_fenrir 1.0, Storyteller bm_daniel 0.95. Engine: Kokoro-FastAPI at 127.0.0.1:8880. Data in src/data/voices.js, mirrored in docs/ROLES.md; npm run lorecheck keeps them in step.
- Portraits: briefs in docs/ROLES.md and src/data/portraits.js, style line "painted portrait, muted palette, soft lamplight, plain dark background, head and shoulders" (proposed, owner may change). Never reference official art.
- Tooling gotcha: in the Bash tool, long multi-heredoc commands failed to parse; write files with Write, keep shell calls short.
