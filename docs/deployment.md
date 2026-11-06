# Deployment

Run Redoor behind an HTTPS reverse proxy when exposing it outside a trusted network, or let it serve HTTPS itself with [`[server.tls]`](config.md#servertls-built-in-https), using your own certificate or a self-signed one it creates.

## Sessions behind a proxy

Browser sessions last the length picked on the login page (1 hour by default) without activity, and the page keeps them alive with `POST /api/v1/session/activity` while it is used. Proxies need no special configuration for this. The server enforces the length; the session cookie itself lasts a year, restarted by activity. When a session ends, Redoor closes the page's WebSockets with close code 4401, which the page answers by showing the login form. Upgrading to the release that introduced session lengths signs every browser out once.

## Streaming request bodies

Redoor streams uploads to the destination device through its agent with bounded memory use. Configure reverse proxies to forward request bodies as they arrive. Otherwise, the proxy receives the complete file before Redoor starts uploading it to the device, causing a long `(pending)` interval and using temporary storage proportional to the file size.

## Nginx

Disable request buffering for the Redoor proxy location:

```nginx
location / {
    proxy_pass http://127.0.0.1:7666;
    proxy_request_buffering off;
}
```

Configure `client_max_body_size` separately if Nginx rejects large files.

### Nginx Proxy Manager

In Nginx Proxy Manager, edit the Redoor **Proxy Host**, open the **Advanced** tab, and put this in **Custom Nginx Configuration**:

```nginx
proxy_request_buffering off;
```

Save the proxy host to apply it. This has been confirmed to make Nginx Proxy Manager stream uploads to Redoor.

## Client addresses

Behind a reverse proxy, every connection Redoor sees comes from the proxy. Log lines for sign-ins and refused agents, and the refused-agent list on the Agents page, therefore also show the client address the proxy forwards in `X-Forwarded-For` (or `X-Real-IP`), for example `remote=10.87.1.10:40318 (forwarded for 203.0.113.5)`. Nginx Proxy Manager, Caddy and Traefik send these headers by default; with plain Nginx add:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Any client can send these headers, so Redoor only displays the forwarded address and never trusts it. The login rate limiter counts failures per proxy address, so all users behind one proxy share its limit.

## Other reverse proxies

Other proxies often stream by default. Avoid features that buffer the complete request body:

| Proxy | Guidance |
| --- | --- |
| Caddy | `reverse_proxy` streams by default; avoid request-body buffering plugins. |
| Traefik | Streams by default; do not attach the `buffering` middleware. |
| HAProxy | Streams by default; do not enable `option http-buffer-request`. |
| Apache HTTP Server | Avoid filters that consume the complete body before `mod_proxy`. |
| Envoy | Do not add the HTTP buffer filter to the Redoor route. |
