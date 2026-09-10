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
    .replace(/&(#\d+|[a-zA-Z]+);/g, (whole, entity: string) =>
      entity.startsWith("#")
        ? String.fromCharCode(Number(entity.slice(1)))
        : (ENTITIES[entity.toLowerCase()] ?? whole),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Storefront country code — affects prices only. */
export const CC = "ua";
