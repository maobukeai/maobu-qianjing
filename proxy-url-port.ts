/** WHATWG URL clears explicit HTTP/HTTPS default ports during parsing. */
export function proxyUrlPort(raw: string, url: URL): string {
  if (url.port) return url.port;
  const defaultPort = url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "";
  if (!defaultPort) return "";
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i.exec(raw)?.[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const explicit = /:(\d+)$/.exec(hostPort)?.[1];
  return explicit !== undefined && Number(explicit) === Number(defaultPort) ? defaultPort : "";
}
