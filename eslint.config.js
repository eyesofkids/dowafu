import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "tmp/**", "publish/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // TypeScript 編譯器本來就會抓未定義變數，且它認得 node 全域；
      // 這條在 .ts 上只會對 process／console／Buffer 誤報。
      "no-undef": "off",
    },
  },
);
