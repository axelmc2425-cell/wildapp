import { registerModule } from '../../shell/modules.js';
import { createController } from './controller.js';
import { createHelperClient, createTauriHelperCall } from './helper-client.js';
import { makeTzOffsetAt } from './tz.js';
import { mountHome } from './ui/home.js';

const listeners = new Set();
let controller = null;

/** Calls `fn` whenever the controller's state changes; returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function makeClient() {
  if (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) {
    return createHelperClient(createTauriHelperCall());
  }
  return createHelperClient(async () => {
    throw new Error('Focus Room blocking is only available in the desktop app');
  });
}

/** The module's controller, created on first use. */
export function getController(ctx) {
  if (!controller) {
    controller = createController({
      db: ctx.db,
      client: makeClient(),
      now: () => Date.now(),
      tzOffsetAt: makeTzOffsetAt(),
      onChange: () => { for (const fn of [...listeners]) fn(); },
    });
  }
  return controller;
}

registerModule({
  id: 'focus',
  name: 'Focus Room',
  icon: '🎯',
  ready: true,
  async onStart(ctx) {
    // Start loading but never await it: a slow or hung helper must not block app start.
    // The controller never throws; its onChange updates the UI when load settles.
    Promise.resolve(getController(ctx).load()).catch(() => {});
  },
  render(root, ctx) {
    return mountHome(root, getController(ctx), ctx, { subscribe });
  },
});
