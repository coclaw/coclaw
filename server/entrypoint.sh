#!/bin/sh
set -e

node_modules/.bin/prisma migrate deploy

exec node src/index.js
