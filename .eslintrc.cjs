module.exports = {
  env: {
    node: true,
    es2020: true,
  },
  parser: "@typescript-eslint/parser",
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
  ],
  rules: {
    "@typescript-eslint/explicit-module-boundary-types": "off",
  },
  overrides: [
    {
      files: ["*.ts"],
      rules: {
        "@typescript-eslint/explicit-module-boundary-types": ["error"],
      },
    },
  ],
};
