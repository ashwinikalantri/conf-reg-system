# Debian-based, not alpine: sqlite3 ships prebuilt glibc binaries for its
# native bindings, so this avoids needing a C/C++ toolchain (python3, make,
# g++) in the image just to compile it from source, which alpine's musl libc
# would otherwise force.
FROM node:16-bookworm-slim

WORKDIR /app

# Dependencies first, and only the manifests -- so `npm ci` is only re-run
# when package*.json actually change, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Everything the app writes to at runtime -- .env (the admin panel writes
# secrets back into it via writeEnvVar), conference.db, uploads/,
# bank-statements/, and the OCR language-model cache -- lives under /data
# instead, symlinked back to where server.js actually looks for each of them
# (all resolved via __dirname/cwd; see ENV_PATH, UPLOAD_DIR, STATEMENT_DIR,
# and the sqlite3.Database() call). docker-compose.yml mounts ONE named
# volume onto /data, so all of it persists together across image rebuilds
# and container recreation.
#
# Symlinks, not volume mounts directly onto these paths: tested directly
# against Docker Engine 26.1.4, and a single-file named-volume mount either
# fails outright ("is not directory", when the image already has a file
# there) or silently creates an empty DIRECTORY instead of a file (when it
# doesn't) -- neither works for a file server.js reads/writes directly.
# Mounting one directory volume onto /data and symlinking into it avoids
# both failure modes.
RUN mkdir -p /data/uploads /data/bank-statements /data/ocr-cache \
 && touch /data/.env /data/conference.db \
 && rm -rf uploads bank-statements .ocr-cache \
 && ln -s /data/.env .env \
 && ln -s /data/conference.db conference.db \
 && ln -s /data/uploads uploads \
 && ln -s /data/bank-statements bank-statements \
 && ln -s /data/ocr-cache .ocr-cache

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
