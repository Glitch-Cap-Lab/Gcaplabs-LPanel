FROM node:24-alpine
WORKDIR /app
COPY backend-api/package.json backend-api/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY tsconfig.base.json /tsconfig.base.json
COPY backend-api/ ./
COPY agent-runtime /agent-runtime
COPY workers/provisioner/backends /app/backends
COPY workers/provisioner/protectedReleaseStatus.ts workers/provisioner/protectedReleaseManifest.ts workers/provisioner/protectedReleaseArchive.ts workers/provisioner/protectedReleaseDocker.ts workers/provisioner/protectedReleasePrune.py workers/provisioner/deploymentLifecycle.ts workers/provisioner/protectedReleaseOperation.ts workers/provisioner/protectedReleaseTarget.ts workers/provisioner/protectedRuntimeRelease.ts workers/provisioner/protectedReleaseState.ts /app/protected-release/
COPY workers/provisioner/backends/dockerExecStream.ts /app/protected-release/backends/
EXPOSE 4000
CMD ["npm", "start"]
