// ============================================================
// Small text-cleanup helpers shared across the app.
// ============================================================

const NAMED_ENTITIES = {
  amp: '&', quot: '"', apos: "'", nbsp: ' ',
};

// Decodes the handful of HTML entities that can realistically end up
// in a <title>/<h1> the model wrote -- mainly &amp; from correctly
// escaping "&" in HTML text content, or numeric entities. lt/gt are
// deliberately absent from the named table AND stripped from the
// final output: a numeric entity (&#60; / &#x3c;) produces the same
// "<" character regardless of the named-entity map, so filtering the
// decoded result is what actually guarantees project.name can never
// hold a raw angle bracket, no matter what renders it later. No
// legitimate site title needs one.
export function decodeHtmlEntities(str) {
  const decoded = String(str || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1].toLowerCase() === 'x';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    const key = entity.toLowerCase();
    return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : match;
  });
  return decoded.replace(/[<>]/g, '');
}
