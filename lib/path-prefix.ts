export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname.startsWith(prefix + "/");
}
