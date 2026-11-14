import { registerModule } from '../../shell/modules.js';
import { createController } from './controller.js';
import { createHelperClient, createTauriHelperCall } from './helper-client.js';
import { makeTzOffsetAt } from './tz.js';
import { startAutoResync } from './auto-resync.js';
import { mountHome } from './ui/home.js';
import { openListEditor } from './ui/list-editor.js';
import { openScheduleEditor } from './ui/schedule-editor.js';
import { openLimitEditor } from './ui/limit-editor.js';
import { openStartDialog } from './ui/start-dialog.js';
import { openPartnerSetup } from './ui/partner-setup.js';
import { openUnlockDialog } from './ui/unlock-dialog.js';
import { mountHelperDetails } from './ui/helper-details.js';
import { mountStatsPage } from './ui/stats-page.js';

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
    const ctl = getController(ctx);
    Promise.resolve(ctl.load()).catch(() => {});
    startAutoResync(ctl);
  },
  render(root, ctx) {
    const ctl = getController(ctx);
    let view = 'home';
    let cleanup = null;
    let alive = true;
    function show(next) {
      if (!alive) return;
      view = next;
      if (cleanup) { const c = cleanup; cleanup = null; try { c(); } catch { /* ignore */ } }
      cleanup = view === 'stats'
        ? mountStatsPage(root, ctl, { onBack: () => show('home'), subscribe })
        : mountHome(root, ctl, ctx, { subscribe, openListEditor, openScheduleEditor, openLimitEditor, openStartDialog, openPartnerSetup, openUnlockDialog, mountHelperDetails, openStats: () => show('stats') });
    }
    show('home');
    return () => {
      alive = false;
      if (cleanup) { const c = cleanup; cleanup = null; try { c(); } catch { /* ignore */ } }
    };
  },
});
