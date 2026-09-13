#!/bin/sh
set -eu

# Run schema migrations only when explicitly asked (one-off task, or single-instance dev).
# In ECS the migration task and the API service share this image; the service runs with
# RUN_MIGRATIONS unset so a scale-out never races two migrators.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] applying Prisma migrations"
  ./node_modules/.bin/prisma migrate deploy
  if [ "${RUN_SEED:-false}" = "true" ]; then
    echo "[entrypoint] seeding reference data"
    ./node_modules/.bin/ts-node prisma/seed.ts
  fi
  if [ "${MIGRATE_ONLY:-false}" = "true" ]; then
    exit 0
  fi
fi

exec node dist/main
