/** Links to notes, `player-two://note/<id>`: making one, reading one, and finding them in a message's text. A note is a message or an answer, named by its event's id. No IO. */

const PREFIX = "player-two://note/";
const ID = /^[0-9a-f]{64}$/;
// A link inside other text: the id is 64 hex digits and no more, so a longer run of letters and digits is not a link at all.
const IN_TEXT = /player-two:\/\/note\/([0-9a-f]{64})(?![0-9A-Za-z])/gu;

/** A stretch of a message's text: plain, or a link to a note, with the id it names. */
export interface Piece {
  readonly text: string;
  readonly note: string | null;
}

/** The link to the note whose event has this id. */
export function noteLink(id: string): string {
  return `${PREFIX}${id}`;
}

/** The id a link names, when it is exactly a link to a note with a 64-hex id; null for anything else. */
export function noteOf(link: string): string | null {
  const id = link.startsWith(PREFIX) ? link.slice(PREFIX.length) : "";
  return ID.test(id) ? id : null;
}

/** A text cut into plain stretches and the links to notes in it, in order. */
export function notesIn(text: string): Piece[] {
  const pieces: Piece[] = [];
  let end = 0;
  for (const match of text.matchAll(IN_TEXT)) {
    pieces.push({ text: text.slice(end, match.index), note: null }, { text: match[0], note: match[1] ?? null });
    end = match.index + match[0].length;
  }
  return [...pieces, { text: text.slice(end), note: null }].filter((piece) => piece.text !== "");
}
