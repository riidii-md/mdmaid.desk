# Local HTTPS

The canonical browser origin is:

```text
https://mdmaid.desk.localhost/
```

Mdmaid.desk does not terminate TLS itself. The Node service remains bound to
`127.0.0.1`, and a trusted local reverse proxy terminates HTTPS. This keeps the
daemon and TUI on the same authenticated loopback API while giving the browser
a stable, memorable origin.

## Caddy setup

The repository includes this configuration in `examples/Caddyfile`:

```caddyfile
mdmaid.desk.localhost {
    tls internal
    reverse_proxy 127.0.0.1:43127
}
```

Start Caddy and trust its local certificate authority once:

```bash
caddy start --config examples/Caddyfile
caddy trust
```

For an always-available workspace, install the same Caddyfile in the
user/system Caddy service instead of running it in a project terminal.

Start mdmaid.desk with the matching public origin:

```bash
npm run build
node dist/cli.js web --public-url https://mdmaid.desk.localhost
```

When `--public-url` is present and `--port` is omitted, mdmaid.desk uses the
stable backend port `43127`. An explicit `--port` remains available, but the
proxy target must match it.

The command prints an authenticated URL containing a bootstrap token. Open
that complete URL once. Mdmaid.desk exchanges it for an HTTP-only, secure,
same-site cookie and redirects to the clean root URL.

## Security boundary

- the application server still refuses non-loopback bind addresses;
- `--public-url` accepts only a credential-free HTTPS `.localhost` origin with
  no path, query, or fragment;
- browser mutations authenticated by cookie must send that exact origin;
- proxy forwarding headers are not trusted or used for authentication;
- the browser cookie is marked `Secure`, `HttpOnly`, and `SameSite=Strict`;
- HTTPS responses include HSTS and the existing restrictive CSP;
- the persistent random `auth-token` and transient `daemon.json` descriptor use
  mode `0600` in the mode-`0700` state directory;
- bearer-authenticated local clients continue to connect directly to the
  loopback address recorded in `daemon.json`.

Do not configure the proxy to listen on a LAN/public interface or change the
public URL to a public domain. The supported browser endpoint is local-only.
