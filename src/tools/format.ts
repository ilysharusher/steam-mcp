const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Steam news arrives as markup; strip tags and decode the entities behind them. */
export function stripMarkup(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    // Hex entities (&#x27;) are as common as decimal ones in Steam's markup, and
    // fromCodePoint rather than fromCharCode because emoji in patch notes are
    // above U+FFFF, where fromCharCode silently produces the wrong character.
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
      if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()] ?? whole;
      const code = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Storefront country code — affects prices only. */
export const CC = "ua";
