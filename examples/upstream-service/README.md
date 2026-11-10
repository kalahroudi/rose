# Example: an upstream service behind Rose

This is the smallest possible "existing service" that Rose turns multi-tenant. Rose sits
in front, handles sign-in, tenants, roles and custom domains, and forwards
`https://<tenant>.<your-domain>/svc/*` to this service with a signed token.

```
browser ──▶ Rose app worker ──▶ this service
            (who? which tenant?)   (trusts only X-Rose-Tenant-Token)
```

## The contract

Rose adds two headers to every forwarded request:

| Header | Meaning |
|---|---|
| `X-Rose-Tenant-Token` | HS256 JWT, valid for 60 seconds. **This is the only thing to trust.** |
| `X-Rose-Tenant-Id` | Convenience copy of the tenant id for logs and routing. Never authorise with it. |

Token claims: `iss` = `rose`, `aud` = `upstream`, `tid` (tenant id), `tslug` (workspace
address), `sub` (user id or API key id), `sub_type` (`user` or `api_key`), `role`
(`owner`, `admin` or `member`), `iat`, `exp`.

Rose does **not** forward cookies or `Authorization`, and strips `Set-Cookie` and
security headers from your responses, so this service can not affect the tenant's session.

## Rules for your service

1. Verify the signature, `exp`, `iss` and `aud` on every request ([`worker.js`](worker.js) shows how, in about 20 lines of WebCrypto).
2. Pin the algorithm to HS256. Never read `alg` from the token to decide how to verify.
3. Use `tid` from the verified token as the tenant key for **every** read and write.
4. Make the service unreachable except through Rose where you can (private network, Cloudflare Tunnel, or a service binding). The token still protects you if it is reachable.

## Try it

```sh
node --test "examples/upstream-service/*.test.mjs"          # verification tests, no install needed

# run it next to `pnpm dev`:
cd examples/upstream-service
echo "UPSTREAM_SIGNING_SECRET=<copy the value from apps/app/.dev.vars>" > .dev.vars
npx wrangler dev --port 8799
```

Then add to `apps/app/.dev.vars` and restart `pnpm dev`:

```
UPSTREAM_MODE=origin
UPSTREAM_ORIGIN=http://127.0.0.1:8799
```

Sign in to a workspace and open `http://<slug>.localhost:5174/svc/whoami`.

See [docs/multi-tenanting-a-service.md](../../docs/multi-tenanting-a-service.md) for
origin mode, Workers for Platforms dispatch mode and custom domains.
