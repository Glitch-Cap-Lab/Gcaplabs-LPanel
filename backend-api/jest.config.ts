import type { Config } from "jest";

// sanitize-html 2.18 pulls in htmlparser2 v12 and its dom* / entities deps,
// which ship ESM only. Let ts-jest compile those packages to CommonJS.
const esmOnlyDeps = [
  "htmlparser2",
  "domhandler",
  "domutils",
  "domelementtype",
  "dom-serializer",
  "entities",
];

// The provisioner adapters mounted into backend-api (workers/provisioner/backends)
// load these packages. In the container they resolve from /app/node_modules; on a
// checkout they would resolve from workers/provisioner/node_modules, which is only
// present if that package was installed too. Pin them to backend-api's own install
// (all five are declared in backend-api/package.json) so the suites are hermetic.
const sharedWorkerDeps = ["ssh2", "tar-stream", "bullmq", "ioredis", "pg"];

const config: Config = {
  moduleNameMapper: {
    [`^(?:.*/workers/provisioner/node_modules/)?(${sharedWorkerDeps.join("|")})$`]:
      "<rootDir>/node_modules/$1",
  },
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json", "node"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json", diagnostics: false }],
    "^.+\\.js$": [
      "ts-jest",
      { tsconfig: { allowJs: true, module: "commonjs" }, diagnostics: false },
    ],
  },
  transformIgnorePatterns: [`/node_modules/(?!(${esmOnlyDeps.join("|")})/)`],
  setupFiles: ["<rootDir>/__tests__/support/sessionCheckStub.js"],
  testTimeout: 10000,
};

export default config;
