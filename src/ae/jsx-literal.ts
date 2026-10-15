/**
 * Serializes a JS value into ExtendScript (ES3-compatible) source literal text,
 * for splicing into a generated .jsx body. JSON.stringify's output (quoted
 * string keys, standard array/object literal syntax) is valid ES3 source, so
 * this covers strings/numbers/booleans/null/arrays/plain objects. `undefined`
 * has no JSON form, so it's mapped to the ExtendScript `undefined` literal.
 */
export function jsxLiteral(value: unknown): string {
    if (value === undefined) return "undefined";
    return JSON.stringify(value);
}
