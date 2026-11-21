/** A toolkit bundle's source with its bare imports of the modules in `urls` (react, the UI kit) pointed at the app's copies (pb#353). */
export function linkShared(source: string, urls: Record<string, string>): string {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])([^"']+)\2/g,
    (whole: string, lead: string, q: string, spec: string) => (Object.hasOwn(urls, spec) ? `${lead}${q}${urls[spec]}${q}` : whole),
  );
}
