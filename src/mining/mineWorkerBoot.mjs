import { register } from 'node:module';
register('tsx/esm', import.meta.url);
await import('./mineWorker.ts');
