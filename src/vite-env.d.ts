/// <reference types="vite/client" />

// Виртуальный модуль баланса (vite.config.ts, плагин balance-csv):
// содержимое docs/balance_1.csv как строка.
declare module 'virtual:balance' {
  const raw: string;
  export default raw;
}