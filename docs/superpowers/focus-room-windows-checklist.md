# Focus Room: manual Windows verification checklist

All Windows-only code (service, named pipe, file permissions, browser encrypted-DNS policy, hosts-file locking, process killing, installer hooks, the Tauri pipe bridge) was only type-checked in CI, never run. This checklist is the only proof it works.

**Getting the installer:** open the `build-windows` workflow run on GitHub (Actions tab), scroll to Artifacts, download `MyBrain-windows-installer`, unzip it, then right-click the `.exe` and choose "Run as administrator" on a Windows 10/11 PC. Use a spare PC or a VM (with a snapshot) first. The helper is designed to be hard to remove, so read the next section before testing any lock.

Terms: "service" = a background Windows program; "ACL" = the permission list on a file or folder; "pipe" = the local channel (`\\.\pipe\mybrain-focus`) the app uses to talk to the helper; "DoH" = encrypted DNS in browsers, which would bypass the hosts-file block.

## Escape hatches (read before testing locks)

- [ ] Always test locks with SHORT durations (2-5 minutes) first — Expected: a mistake costs minutes, not days
- [ ] Keep a partner key ready (see section 6) before starting any lock — Expected: you have an early exit
- [ ] Remember: locks always end at their end time — Expected: waiting is always a valid way out
- [ ] The partner token flow is the early exit while a lock is active — Expected: it ends exactly that one window
- [ ] If the helper misbehaves while NO lock is active, run `focus-helper uninstall` as Administrator — Expected: services and policies are removed
- [ ] If a lock is active and something is wrong, wait out the end time or use the partner token — Expected: uninstall is refused during a lock (by design)
- [ ] If services are stuck disabled, run `focus-helper install` again as Administrator — Expected: services are re-enabled (start=auto) and running

## 1. Install and service hardening

- [ ] Run the installer as Administrator — Expected: it completes with no error dialog
- [ ] Run `sc query MyBrainFocus` and `sc query MyBrainFocusWatchdog` — Expected: both exist and are RUNNING
- [ ] Run `sc qc MyBrainFocus` and `sc qc MyBrainFocusWatchdog` — Expected: START_TYPE is AUTO_START and SERVICE_START_NAME is LocalSystem
- [ ] Check BINARY_PATH_NAME in the `sc qc` output — Expected: it points at `C:\Program Files\MyBrainFocus\focus-helper.exe` (not a per-user folder)
- [ ] Check the Security tab / `icacls "C:\Program Files\MyBrainFocus"` — Expected: only SYSTEM can write; Administrators and Users are read-only
- [ ] In an Administrator prompt run `sc stop MyBrainFocus` — Expected: "Access is denied"
- [ ] In an Administrator prompt run `sc delete MyBrainFocus` — Expected: "Access is denied"
- [ ] Open Services (services.msc) as Administrator, right-click MyBrainFocus — Expected: Stop/Pause/Properties changes are denied or greyed out
- [ ] Kill `focus-helper.exe` in Task Manager (Details tab) — Expected: it is running again within about 10 seconds (watchdog)
- [ ] Stop the other service by any means available (e.g. kill its process) — Expected: its peer restarts it within about 10 seconds

## 2. Websites

Start a short lock that blocks a test site (e.g. `example.com`).

- [ ] Open the site (and its `www.` and `m.` variants) in Chrome — Expected: the page fails to load
- [ ] Repeat in Edge — Expected: fails to load
- [ ] Repeat in Firefox — Expected: fails to load
- [ ] Open a different subdomain that is not listed (e.g. `blog.example.com`) — Expected: it still loads (known limit: only listed names are blocked)
- [ ] Open `C:\Windows\System32\drivers\etc\hosts` in Notepad as Administrator — Expected: a managed block between `# BEGIN MYBRAIN-FOCUS` and `# END MYBRAIN-FOCUS` markers; any lines you added yourself are unchanged and outside the block
- [ ] As a normal user try to edit and save the hosts file — Expected: save is denied (ACL lock holds)
- [ ] Add a second block, then let both end (or remove them), twice in a row — Expected: the helper rewrites the hosts file every time (lock, apply, unlock cycle works as SYSTEM) with no error
- [ ] After all blocks end, view the hosts file and its Security tab — Expected: no managed block remains and the ACL is back to the Windows default

## 3. Encrypted DNS

- [ ] While blocking, open `chrome://policy` — Expected: the DoH policy (DnsOverHttpsMode) is shown as off/disabled
- [ ] While blocking, open `edge://policy` — Expected: same DoH policy shown as off/disabled
- [ ] While blocking, open `about:policies` in Firefox — Expected: the DoH policy is listed as disabled
- [ ] After all blocks end, reload the three policy pages — Expected: the values the helper wrote are gone
- [ ] Before a lock, set a conflicting DoH value yourself in the registry (e.g. Chrome `DnsOverHttpsMode` = `secure` under `HKLM\SOFTWARE\Policies\Google\Chrome`), then start a lock — Expected: the app's status (GetStatus warnings) reports that DoH is not enforced for that browser, and your admin value is left untouched
- [ ] Remove your test registry value afterwards — Expected: the key is clean

## 4. Apps

- [ ] Add a harmless app (e.g. `notepad.exe`) to a block and start a lock, then launch it — Expected: it closes within about 2 seconds of launching
- [ ] While a block is active, launch a test install of any VPN app from the built-in VPN list — Expected: it is closed
- [ ] When no block is active, launch the same VPN app — Expected: it stays open (VPN apps are closed only during a block)

## 5. Frozen mode

Start a short Frozen lock with an empty allow list.

- [ ] Use Explorer, the taskbar, the Start menu — Expected: all keep working
- [ ] Use MyBrain and move/snap windows — Expected: MyBrain and the window manager keep working
- [ ] Lock the PC with Win+L, then unlock it — Expected: unlock works. Record the result: ______
- [ ] Type in a text box, use the emoji panel (Win+.), switch input language — Expected: typing/IME/emoji work. Record: ______
- [ ] Open Settings and another Store (UWP) app — Expected: they open. Record: ______
- [ ] Open Windows Security — Expected: it opens. Record: ______
- [ ] Note anything else that breaks or disappears (watch for: dllhost.exe, wmiprvse.exe, ApplicationFrameHost.exe, TextInputHost.exe, LogonUI.exe, LockApp.exe, userinit.exe, SecurityHealthService.exe, MsMpEng.exe, SearchIndexer.exe, WUDFHost.exe, Memory Compression, Secure System being killed) — Expected: nothing breaks. ANY breakage means CRITICAL_APPS must be widened (Ruling 13); report it
- [ ] Reboot the PC during an active lock — Expected: the lock is still in force after login

## 6. Partner unlock

- [ ] With the network disabled, open `src/modules/focus/partner-unlock.html` in a browser — Expected: the page works fully offline
- [ ] Create a key on the page and copy the public key into the app — Expected: the app accepts it
- [ ] Create a short lock and request an unlock challenge — Expected: a challenge string is shown
- [ ] Paste the challenge into the partner page and sign it — Expected: a token is produced
- [ ] Submit the token in the app — Expected: only that one window ends; other windows stay locked
- [ ] Submit the same token again — Expected: fails with `used`
- [ ] Submit a token made for a different window — Expected: fails with `wrong-lock`
- [ ] Wait more than 10 minutes after requesting a challenge, then submit its token — Expected: fails with `expired`
- [ ] Try to set a new partner key while any locked/frozen window with a future end time exists, including a scheduled lock that has not started yet (Ruling 11) — Expected: refused
- [ ] While a locked window exists, push a smaller set of windows (remove or shorten it) — Expected: refused; the locked window stays unchanged

## 7. Clock

- [ ] During a lock, set the system clock back 1 hour — Expected: the lock neither ends early nor gets longer
- [ ] During a lock, shut down, set the clock forward past the end time, boot — Expected: the lock MAY end early (known limit). Record the result: ______

## 8. Named pipe and permissions

- [ ] Run MyBrain as a NON-admin user — Expected: it connects to the helper and shows Status (the pipe client must use explicit access rights; GENERIC_READ|GENERIC_WRITE would be denied)
- [ ] As a non-admin user, run a small test program that tries to create its own `\\.\pipe\mybrain-focus` instance — Expected: access denied
- [ ] From another PC on the network, try to open `\\<pc-name>\pipe\mybrain-focus` — Expected: cannot connect
- [ ] Open 20 connections to the pipe at once (script) and hang up abruptly — Expected: blocking continues; the app reconnects afterwards

## 9. State directory

- [ ] Run `icacls C:\ProgramData\MyBrainFocus` — Expected: owner is SYSTEM and Users have no access
- [ ] Before first install (clean PC), as a standard user create `C:\ProgramData\MyBrainFocus`, then install — Expected: that folder is renamed aside (quarantined) and a fresh protected one is created
- [ ] Inside the state directory create a junction (`mklink /J`) to a harmless test folder with a file in it, then restart the service (reboot or after the lock) — Expected: the junction is removed as a link and the test folder and its file are untouched
- [ ] As a standard user try to edit `state.json` — Expected: access denied
- [ ] Make the state directory read-only for SYSTEM (test VM only), then check Status — Expected: warnings contain `persist:`, and a request that changes state returns `persist-failed`
- [ ] Restore the directory permissions afterwards — Expected: Status warnings clear

## 10. Installer, upgrade, uninstall

- [ ] Uninstall via Settings > Apps while a locked/frozen window with a future end time exists — Expected: refused with the lock message (exit code 1); services still present
- [ ] Uninstall when no such window exists — Expected: succeeds
- [ ] Re-run the installer as Administrator over an existing install with no lock pending — Expected: succeeds
- [ ] Re-run the installer while a lock is pending and the service is running — Expected: refused with a clear message (known: upgrades wait for locks, up to 30 days)
- [ ] Kill the installer midway (e.g. while it runs `sc config`), then run `focus-helper install` as Administrator — Expected: both services end up with start=auto and running
- [ ] Confirm the first installer build compiled (NSIS hook macro names and `$UpdateMode` were not verified offline) — Expected: the build-windows run is green and the installer launches
- [ ] Install a newer app build over an older one (in-place update, no lock) — Expected: not blocked by the PREUNINSTALL Abort

## 11. Logs

- [ ] Open `C:\ProgramData\MyBrainFocus\service.log` — Expected: it exists and is readable by SYSTEM/Administrators
- [ ] After sections 8 and 9 tests, search the log — Expected: pipe and persist errors from those tests are recorded

## 12. Cleanup

With no lock pending, uninstall MyBrain.

- [ ] Run `sc query MyBrainFocus` and `sc query MyBrainFocusWatchdog` — Expected: both report "service does not exist"
- [ ] Open the hosts file — Expected: no managed block and no BEGIN/END MYBRAIN-FOCUS markers
- [ ] Check the Chrome/Edge/Firefox policy pages — Expected: DoH values written by the helper are gone
- [ ] Search `C:\Windows\System32\drivers\etc` and `C:\Program Files\MyBrainFocus` for `.focus-tmp` and `.new` files — Expected: none left (and the Program Files folder is gone)

## Report back

If any check fails, send: the section and line number, what you saw instead, the contents of `C:\ProgramData\MyBrainFocus\service.log`, the output of `sc qc` for both services, a screenshot of any error dialog, your Windows version (`winver`), and for Frozen mode the exact names of anything that broke.
