#!/usr/bin/env bash
[ -f .env ] || cp .env.example .env
echo "Edit .env and set secure passwords, then run: docker compose up --build"
