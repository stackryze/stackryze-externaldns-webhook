# Stackryze ExternalDNS Webhook Provider

Run [ExternalDNS](https://github.com/kubernetes-sigs/external-dns) against
[Stackryze DNS](https://dns.stackryze.com) using the webhook provider interface.
The provider is a small sidecar that translates ExternalDNS changes into calls
to the Stackryze REST API with a Bearer token — no serving-path impact.

## How it works

```
Kubernetes Ingress/Service
        │
    ExternalDNS  ──(localhost webhook)──►  stackryze-externaldns-webhook
                                                   │  Bearer token
                                                   ▼
                                          api.stackryze.com/api
```

The provider manages records inside zones you already own on Stackryze. It does
not create or delete zones.

## Configuration

| Env | Required | Default | Description |
|-----|----------|---------|-------------|
| `STACKRYZE_API_TOKEN` | yes | — | Token with **write** scope (Settings → API tokens) |
| `STACKRYZE_API_URL` | no | `https://api.stackryze.com/api` | API base (include `/api`) |
| `PORT` | no | `8888` | Port ExternalDNS connects to |

## Run locally

```bash
cp .env.example .env   # fill in STACKRYZE_API_TOKEN
npm install
node --env-file=.env src/server.js
```

## Docker

```bash
docker build -t stackryze/externaldns-webhook .
docker run --rm -p 8888:8888 \
  -e STACKRYZE_API_TOKEN=sk_dns_xxx \
  stackryze/externaldns-webhook
```

## Kubernetes (sidecar)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
spec:
  replicas: 1
  selector:
    matchLabels: { app: external-dns }
  template:
    metadata:
      labels: { app: external-dns }
    spec:
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.15.0
          args:
            - --source=ingress
            - --source=service
            - --provider=webhook
            - --registry=txt
            - --txt-owner-id=my-cluster
        - name: stackryze-webhook
          image: stackryze/externaldns-webhook:latest
          env:
            - name: STACKRYZE_API_TOKEN
              valueFrom:
                secretKeyRef: { name: stackryze-dns, key: token }
          ports:
            - containerPort: 8888
```

ExternalDNS defaults to `http://localhost:8888` for the webhook provider, which
matches the sidecar above.

## Endpoints (webhook provider API)

- `GET /` — negotiation; returns the domain filter (your managed zones)
- `GET /records` — current records as ExternalDNS endpoints
- `POST /records` — apply create/update/delete changes (batched per zone)
- `POST /adjustendpoints` — normalizes TTLs (min 3600s, max 604800s)
- `GET /healthz` — liveness

## Notes

- TTLs below 3600s are clamped up to 3600s (Stackryze minimum).
- One Stackryze record is created per ExternalDNS target.
- Zones must already exist on Stackryze; this provider only manages records.
