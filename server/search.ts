/**
 * Turns a shopper's search text into PostgREST filters: every word must appear in the
 * listing's name, brand or description. Returns one `or` filter string per word; apply
 * them all (they are ANDed). User text is escaped twice: once so %, _ and \ are literal
 * in the LIKE pattern, then so quotes and backslashes are literal in PostgREST's
 * quoted-value syntax. Nothing from the query can add a filter or a column.
 */
export function searchFilters(query: string, columns = ['name', 'brand', 'description']): string[] {
  return query.split(/\s+/).filter(Boolean).slice(0, 6).map(word => {
    const like = word.replace(/[\\%_]/g, '\\$&');
    const quoted = `"%${like.replace(/[\\"]/g, '\\$&')}%"`;
    return columns.map(column => `${column}.ilike.${quoted}`).join(',');
  });
}
