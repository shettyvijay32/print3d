# Printora 3D on Killercoda Kubernetes

This deploys the API, React admin UI, PostgreSQL and MinIO into namespace `printora3d`. The Expo mobile app is a separate client and is not run as a Kubernetes pod.

## A. Build and publish the two container images

Kubernetes nodes need to pull the images. The simplest lab workflow is to build and push them to a public Docker Hub repository from your own PC (or any machine with Docker):

```bash
# Replace YOUR_DOCKERHUB_USERNAME with your Docker Hub username
docker login
docker build -t YOUR_DOCKERHUB_USERNAME/printora-api:1.0 ./backend
docker build -t YOUR_DOCKERHUB_USERNAME/printora-admin:1.0 ./admin
docker push YOUR_DOCKERHUB_USERNAME/printora-api:1.0
docker push YOUR_DOCKERHUB_USERNAME/printora-admin:1.0
```

Edit `k8s/api.yaml` and `k8s/admin.yaml`: replace `YOUR_DOCKERHUB_USERNAME` in each image field with your actual username. Keep the repositories public for this disposable lab, or configure an imagePullSecret for private images.

## B. Open a Killercoda Kubernetes playground

Start a Kubernetes playground/scenario that provides a working `kubectl` context. In the terminal, check:

```bash
kubectl get nodes
kubectl get storageclass
```

The PVCs need a default StorageClass. If `kubectl get storageclass` shows no default class, use the scenario's supported storage provisioner or change the PVCs to match the available class. Some short-lived playground scenarios may not preserve PVC data after the lab ends.

## C. Put the project folder in the lab

Upload/extract the project ZIP in the Killercoda terminal, or copy the `k8s/` directory contents into the lab. Then:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml.example
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/minio.yaml
kubectl apply -f k8s/api.yaml
kubectl apply -f k8s/admin.yaml
```

Before applying `secrets.yaml.example`, edit its demo passwords. It is intentionally named `.example` so it is not mistaken for a production secret file.

## D. Watch the pods

```bash
kubectl -n printora3d get pods -w
```

In another terminal, diagnose failures:

```bash
kubectl -n printora3d get all
kubectl -n printora3d get pvc
kubectl -n printora3d describe pod POD_NAME
kubectl -n printora3d logs deploy/printora-api
kubectl -n printora3d logs deploy/printora-admin
```

Wait until all four deployments are ready. API startup waits for PostgreSQL and MinIO to become reachable; if the API starts too early, Kubernetes restarts it and it should retry on the next start. If it keeps restarting, inspect logs and dependencies.

## E. Access the app using port-forward

Run these in separate terminal tabs:

```bash
kubectl -n printora3d port-forward --address 0.0.0.0 svc/printora-admin 8080:80
```

```bash
kubectl -n printora3d port-forward --address 0.0.0.0 svc/printora-api 4000:4000
```

Use Killercoda's exposed-port / access-port feature for port `8080` (admin) and `4000` (API), if provided by the scenario. Test API health at `/health`. If the scenario does not expose forwarded ports, use the scenario's documented service exposure method.

Admin demo login is the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you configured in the Kubernetes Secret. Change these before any non-disposable deployment.

## F. Test the quotation workflow

1. Open the admin UI and sign in.
2. Register a customer from the mobile app (Expo) or call the API registration endpoint.
3. Submit a JPG/PNG photo request with a customer account.
4. In admin, review the request and send a quote.
5. Customer approves the quote. Payment is deliberately manual in this MVP; customer payment gateway integration is not yet implemented.
6. Admin records payment verification and moves the request through printing, quality check, shipped and delivered.

API registration example:

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Customer","email":"customer@example.com","password":"CustomerPass123!"}'
```

For a real photo-upload test, use the Expo app with `EXPO_PUBLIC_API_URL` set to a reachable API URL, or use Postman/curl with a bearer token and multipart form fields.

## G. Clean up the lab

```bash
kubectl delete namespace printora3d
```

## Lab limitations and production notes

- Killercoda playgrounds are temporary; do not store real customer data or production secrets there.
- Docker Hub image publishing is needed unless the selected scenario supports building/importing images directly into its cluster runtime.
- The React Native app is not deployed as a pod. It is built separately with Expo/EAS or local Android/iOS toolchains and calls the Kubernetes API.
- MinIO is configured as an in-cluster object store for testing. For production, use durable storage, backups and TLS.
- This MVP has manual payment-reference handling; a verified payment gateway webhook is required before automatic payment confirmation.
- The sample admin panel uses basic prompts for quote entry and is a prototype UI. Improve validation, audit logs, authorization policy, and customer communication before launch.
