module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
  extends: ['eslint:recommended'],
  ignorePatterns: ['node_modules/**'],
}
