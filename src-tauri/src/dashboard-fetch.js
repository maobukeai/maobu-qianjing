(port, session) => {
  const origin = `http://127.0.0.1:${port}`;
  if (window !== window.top || window.location.origin !== origin) return;
  const send = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, document.baseURI);
    if (url.origin !== origin || !url.pathname.startsWith("/ui/api/")) return send(input, init);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("X-Maobu-Desktop-Session", session);
    return send(new Request(request, { headers, redirect: "error" }));
  };
}
