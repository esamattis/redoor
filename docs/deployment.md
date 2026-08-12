# Deployment

Run Redoor behind an HTTPS reverse proxy when exposing it outside a trusted network.

## Streaming request bodies

Redoor streams uploads to the destination agent with bounded memory use. Configure reverse proxies to forward request bodies as they arrive. Otherwise, the proxy receives the complete file before Redoor starts uploading it to the agent, causing a long `(pending)` interval and using temporary storage proportional to the file size.

## Nginx

Disable request buffering for the Redoor proxy location:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
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

## Other reverse proxies

Other proxies often stream by default. Avoid features that buffer the complete request body:

| Proxy | Guidance |
| --- | --- |
| Caddy | `reverse_proxy` streams by default; avoid request-body buffering plugins. |
| Traefik | Streams by default; do not attach the `buffering` middleware. |
| HAProxy | Streams by default; do not enable `option http-buffer-request`. |
| Apache HTTP Server | Avoid filters that consume the complete body before `mod_proxy`. |
| Envoy | Do not add the HTTP buffer filter to the Redoor route. |
