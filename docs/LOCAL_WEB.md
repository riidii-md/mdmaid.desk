# Local browser URL

The canonical browser origin is:

```text
http://mdmaid.desk.localhost:43127/
```

It is served directly by mdmaid.desk. The application remains bound to
`127.0.0.1`; the `.localhost` name maps back to loopback without DNS or an
`/etc/hosts` entry. No reverse proxy or locally trusted certificate is needed.

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

The default backend port is stable at `43127`. To choose a different one:

```bash
node dist/cli.js web --port 43128
```

The public origin then becomes
`http://mdmaid.desk.localhost:43128/` automatically.

## Security boundary

- the application server refuses non-loopback bind addresses;
- public browser URLs accept only credential-free HTTP or HTTPS `.localhost`
  origins with no path, query, or fragment;
- a direct HTTP public URL must use the same port as the server;
- browser mutations authenticated by cookie must send the exact public origin;
- forwarding headers are not trusted or used for authentication;
- browser cookies are token-scoped and marked `HttpOnly` and `SameSite=Strict`;
- the persistent random `auth-token` and transient `daemon.json` descriptor use
  mode `0600` in the mode-`0700` state directory;
- bearer-authenticated local clients connect directly to the loopback address
  recorded in `daemon.json`.

HTTP is intentional here: the listener is local-only, and removing local TLS
avoids certificate installation and trust prompts. HTTPS `.localhost` origins
remain available as an advanced configuration and receive `Secure` cookies
and HSTS.
