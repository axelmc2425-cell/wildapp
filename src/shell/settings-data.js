import { registerSettingsSection } from './settings.js';
import { hasNative, invoke, pickZip, pickZipSavePath } from './native.js';

const pad = (n) => String(n).padStart(2, '0');

registerSettingsSection((box) => {
  const h = document.createElement('h3');
  h.textContent = 'Your data';
  const where = document.createElement('p');
  where.className = 'muted';
  const status = document.createElement('p');
  const backup = document.createElement('button');
  backup.textContent = 'Back up now…';
  const restore = document.createElement('button');
  restore.textContent = 'Restore from backup…';
  const row = document.createElement('div');
  row.className = 'row';
  row.append(backup, restore);
  box.append(h, where, row, status);

  const say = (msg, bad) => { status.textContent = msg; status.style.color = bad ? 'var(--danger)' : ''; };

  if (!hasNative()) {
    where.textContent = 'Backup and restore are available in the desktop app.';
    backup.disabled = restore.disabled = true;
    return;
  }
  invoke('data_dir').then(p => { where.textContent = 'Your notes live in: ' + p; }).catch(() => {});

  backup.addEventListener('click', async () => {
    try {
      const d = new Date();
      const dest = await pickZipSavePath(`mybrain-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`);
      if (!dest) return;
      await invoke('backup_create', { dest });
      say('Backup saved to ' + dest);
    } catch (e) { say("Couldn't back up: " + e, true); }
  });

  restore.addEventListener('click', async () => {
    try {
      const src = await pickZip();
      if (!src) return;
      if (!window.confirm('Restoring replaces ALL your current notes with the backup. A safety copy of your current data is saved first. Continue?')) return;
      await invoke('backup_restore', { src });
      say('Restore is ready. Close and reopen MyBrain to finish.');
    } catch (e) { say("Couldn't restore: " + e, true); }
  });
});
