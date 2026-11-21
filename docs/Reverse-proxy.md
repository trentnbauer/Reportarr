# Reverse proxy

Reportarr works at `https://media.example.com/reportarr` as well as at its own port. The page works out where it is mounted from the URL it was loaded at, and the server accepts the path prefix whether or not your proxy strips it, so the simplest setup needs no setting at all. Setting `BASE_URL` makes it explicit and adds two things:

- `/reportarr` (no trailing slash) is redirected to `/reportarr/`, which matters if your proxy passes the prefix through.
- If you give the full URL (`BASE_URL=https://media.example.com/reportarr`), the browser's `Origin` for that host is accepted when saving settings. Saving settings is checked against the `Host` the app sees, which behind a proxy is often the internal one; the app also accepts `X-Forwarded-Host`, so either set `BASE_URL` to the full URL or have the proxy send that header.

Examples (adapt the container name and port; I have only tested these shapes against a small test proxy, not against nginx, Caddy or Traefik themselves):

```nginx
location = /reportarr { return 308 /reportarr/; }
location /reportarr/ {
    proxy_pass http://reportarr:8080/;          # the trailing slash strips the prefix
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
}
```

```caddy
media.example.com {
    redir /reportarr /reportarr/
    handle_path /reportarr/* {                   # strips the prefix
        reverse_proxy reportarr:8080
    }
}
```

If your proxy does not strip the prefix (for example `reverse_proxy /reportarr/* reportarr:8080` in Caddy), that works too; set `BASE_URL=https://media.example.com/reportarr`. The login, if you set one, is HTTP basic auth, which proxies pass through unchanged. Keep it behind TLS.
