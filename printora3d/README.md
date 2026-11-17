# Printora 3D — quotation-first 3D printing platform

A self-hostable starter application with:
- Expo / React Native customer app (Android + iOS)
- React admin dashboard
- Node.js / Express API
- PostgreSQL database
- MinIO object storage for customer photos
- Docker Compose deployment

## Important scope
This is a functional MVP foundation, not a finished audited commerce platform. It implements the core request → quote → customer approval → payment-pending → production → dispatch workflow. Payment collection is intentionally manual in this starter; add Razorpay/Stripe only after configuring merchant credentials and verifying webhooks. Do not accept card details in this app.

## Quick start (Docker)
1. Install Docker Desktop (Windows/macOS) or Docker Engine + Compose (Linux).
2. Copy `.env.example` to `.env`.
3. Change `JWT_SECRET`, database password and MinIO credentials.
4. Run:
   ```bash
   docker compose up --build
   ```
5. API: http://localhost:4000/health
6. Admin: http://localhost:8080
7. MinIO console: http://localhost:9001

Default admin (change immediately):
- Email: `admin@printora.local`
- Password: `ChangeMe123!`

The API seeds this account and demo products on first startup.

## Run the mobile app
The mobile app runs on a phone using Expo Go:
```bash
cd mobile
npm install
npx expo start
```
Set `EXPO_PUBLIC_API_URL` in `mobile/.env` to an API address reachable from your phone.
- Android emulator: `http://10.0.2.2:4000`
- iOS simulator: `http://localhost:4000`
- Physical phone: use your computer's LAN IP, e.g. `http://192.168.1.10:4000`
For physical-device testing, phone and computer must be on the same network and firewall must allow port 4000.

## Main API routes
- `POST /api/auth/login`
- `GET /api/products`
- `POST /api/requests` (multipart fields: `photo`, `customerName`, `email`, `phone`, `description`, `quantity`)
- `GET /api/requests/mine` (customer token)
- `GET /api/admin/requests` (admin token)
- `POST /api/admin/requests/:id/quote` (admin; JSON `{amount,currency,notes,estimatedDays}`)
- `POST /api/requests/:id/approve-quote` (customer token)
- `POST /api/requests/:id/payment-reference` (customer token; `{reference}`)
- `PATCH /api/admin/requests/:id/status` (admin; `{status}`)
- `POST /api/admin/products` (admin; JSON product)
- `PATCH /api/admin/products/:id` (admin; JSON product)
- `DELETE /api/admin/products/:id` (admin)

## Workflow
1. Customer registers/logs in, browses products or submits a custom photo request.
2. Admin reviews the request and submits a quote.
3. Customer approves or declines the quote.
4. Customer pays using the payment instructions you provide and submits a payment reference.
5. Admin verifies payment manually and moves the job through production / dispatch.
6. Customer sees status in My Requests.

## Before going live
- Replace default credentials and secrets.
- Configure HTTPS and a real domain / reverse proxy.
- Configure backups for PostgreSQL and MinIO.
- Add email/SMS/WhatsApp notifications.
- Add payment gateway integration with signed webhook verification.
- Add privacy policy, terms, refund policy and consent for uploaded images.
- Add rate limiting, malware scanning, image size limits and moderation.
- Test builds on real Android and iOS devices.
- Apple App Store distribution generally requires an Apple Developer membership; Google Play has a registration fee.

## Kubernetes / Killercoda
See [`k8s/README-KILLERCODA.md`](k8s/README-KILLERCODA.md) for the Kubernetes manifests, image build/push instructions, Killercoda deployment steps, port-forwarding, testing and cleanup.
