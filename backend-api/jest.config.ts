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

const config: Config = {
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
