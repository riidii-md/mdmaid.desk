# Local browser URL

The canonical browser origin is:

```text
http://mdmaid.desk.localhost/
```

The application always binds to `127.0.0.1`; the `.localhost` name maps back
to loopback without DNS or an `/etc/hosts` entry. Mdmaid.desk first attempts
to serve the portless URL directly on port 80. On macOS, if an existing
Docker-backed Traefik service already owns port 80, mdmaid.desk can register a
small route container on Traefik's network and serve privately on port 43127.
No local certificate is needed.

## Start the workspace

```bash
npm run build
node dist/cli.js web
```

The command prints an authenticated URL containing a bootstrap token. Open
that complete URL once. Mdmaid.desk exchanges it for an HTTP-only,
same-site cookie and redirects to the clean root URL, which can be bookmarked.
The cookie name is scoped to the daemon's persistent token. This matters because
browsers share cookies across ports: token-scoped names let multiple local
mdmaid.desk daemons coexist on the same `.localhost` hostname without signing
each other out.

The default attempt is port `80`. When Traefik owns it, the private backend
uses fixed port `43127` and the browser URL stays portless. If port 80 cannot
be used and there is no compatible Traefik, the browser URL becomes
`http://mdmaid.desk.localhost:43127/`. Port 43127 must be free for either
fallback; startup fails rather than selecting a random port if it is occupied.

To choose a different port for isolated testing:

```bash
node dist/cli.js web --port 43128
```

The public origin then becomes
`http://mdmaid.desk.localhost:43128/` automatically.

For a persistent login service, install the existing daemon integration once:

```bash
mdmaid-desk daemon install
```

After that, `web`, `tui`, `daemon start`, and daemon-aware CLI mutations reuse
the healthy running service. They do not need to start another server. The
daemon never silently falls back to a random port. An explicit `--port`
disables both automatic fallbacks. The Traefik route container is created only
after the private backend has bound successfully, is labeled as mdmaid-owned,
and is reused on subsequent starts. It is not installed when Traefik is not
detected; removing the container is a separate administrative action.
If the healthy shared daemon is already running, `web` reuses it when the
requested port matches and rejects a conflicting second server.

## Live source refresh

Registered documents are shown as `live source`; imported durable copies are
shown as `snapshot`. While this service is running, mdmaid.desk watches only
the parent directories needed by active registered Markdown sources. Editing,
atomically replacing, removing, or restoring a registered source reconciles
its revision and refreshes an open matching Web or TUI reader. Web refresh
preserves the nearest available heading and reruns Mermaid without adding a
history entry or marking the revision opened again.

Linked text files and validated SVG media are re-read and re-authorized on each
request but are not watched. Without this service, opening or rendering a
registered document still reconciles its current source; there is simply no
automatic push event.

## Security boundary

- the application server refuses non-loopback bind addresses;
- public browser URLs accept only credential-free HTTP or HTTPS `.localhost`
  origins with no path, query, or fragment;
- an explicitly selected direct HTTP public URL must use the same port as the
  server; the managed Traefik route is the only default HTTP port exception;
- the Traefik proxy preserves the browser `Host` header and does not mount the
  daemon's state directory; the one-time bootstrap URL (including its token)
  passes through the proxy, so access logging for this route should stay off;
- browser mutations authenticated by cookie must send the exact public origin;
- forwarding headers are not trusted or used for authentication;
- browser cookies are token-scoped and marked `HttpOnly` and `SameSite=Strict`;
- registered workspace-local SVGs are served only through authenticated opaque
  media routes with repeated realpath checks and a script-denying sandbox CSP;
- the persistent random `auth-token` and transient `daemon.json` descriptor use
  mode `0600` in the mode-`0700` state directory;
- bearer-authenticated local clients connect directly to the loopback address
  recorded in `daemon.json`.

If Traefik publishes port 80 to the LAN, its mdmaid route is also reachable
there by a client supplying the hostname. The mdmaid backend still binds only
to loopback and requires the browser session or bearer token for document
access; limit Traefik's published port to local clients if LAN access is not
desired.

HTTP is intentional here: the application listener is local-only, and removing
local TLS avoids certificate installation and trust prompts. A shared Traefik
listener may have a broader reach as noted above. HTTPS `.localhost` origins
remain available as an advanced configuration and receive `Secure` cookies
and HSTS.
