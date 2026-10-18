FROM node:24-alpine

WORKDIR /app
COPY services/headmaster-inference/package.json services/headmaster-inference/package-lock.json services/headmaster-inference/
RUN npm ci --prefix /app/services/headmaster-inference --omit=dev --no-audit --no-fund

# Copy only the existing provider resolver and the modules it imports. This
# image does not contain Docker CLI/runtime orchestration dependencies.
COPY backend-api/llmProviders.ts backend-api/llmProviders.ts
COPY backend-api/db.ts backend-api/db.ts
COPY backend-api/crypto.ts backend-api/crypto.ts
COPY backend-api/demoLlm.ts backend-api/demoLlm.ts
COPY backend-api/lib/advisoryLocks.ts backend-api/lib/advisoryLocks.ts
COPY backend-api/lib/connectionConfig.ts backend-api/lib/connectionConfig.ts
COPY agent-runtime/lib/nemoclawDefaults.ts agent-runtime/lib/nemoclawDefaults.ts
COPY agent-runtime/lib/hermesRuntimeBootstrap.ts agent-runtime/lib/hermesRuntimeBootstrap.ts
COPY agent-runtime/lib/headmasterInference.ts agent-runtime/lib/headmasterInference.ts
COPY agent-runtime/lib/headmasterStorage.ts agent-runtime/lib/headmasterStorage.ts
COPY services/headmaster-inference/ services/headmaster-inference/

ENV NODE_ENV=production \
    NODE_PATH=/app/services/headmaster-inference/node_modules \
    HEADMASTER_INFERENCE_LISTEN=0.0.0.0:8781
USER node
CMD ["npm", "--prefix", "/app/services/headmaster-inference", "start"]
