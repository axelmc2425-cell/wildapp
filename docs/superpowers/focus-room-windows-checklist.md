# Focus Room: manual Windows verification checklist

All Windows-only code (service, named pipe, file permissions, browser encrypted-DNS policy, hosts-file locking, process killing, installer hooks, the Tauri pipe bridge) was only type-checked in CI, never run. This checklist is the only proof it works.

**RELEASE GATE: do not distribute the CI installer to other people until sections 1, 8, 9 and 10 pass on a snapshotted VM.**

**Getting the installer:** open the `build-windows` workflow run on GitHub (Actions tab), scroll to Artifacts, download `MyBrain-windows-installer`, unzip it, then right-click the `.exe` and choose "Run as administrator" on a Windows 10/11 PC. Use a spare PC or a VM (with a snapshot) first. The helper is designed to be hard to remove, so read the next section before testing any lock.

Note: `focus-helper` is not on PATH, so commands below spell out the full path (the folder is the 64-bit Program Files folder, normally `C:\Program Files`). Both services run the same exe, so Task Manager shows two `focus-helper.exe` rows: add the Command line column on the Details tab (`... service` is the main service, `... watchdog` the watchdog).

Install/uninstall steps are also logged to `%TEMP%\mybrain-focus-install.log` (the temp folder of the user who ran them; for the installer usually an Administrator profile). Look there first if an install or uninstall fails.

## Talking to the helper (`send`)

The checklist drives the helper with `focus-helper send`, one JSON request in, one JSON reply out. In PowerShell pipe the JSON on stdin (`send -`): Windows PowerShell 5.1 strips double quotes from native arguments. Paste this once per session:

```powershell
$h = "C:\Program Files\MyBrainFocus\focus-helper.exe"
function Send-Focus($obj) { ($obj | ConvertTo-Json -Depth 6 -Compress) | & $h send - }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
```

- GetStatus: `Send-Focus @{type='GetStatus'}` (shows `decision`, `windows`, `warnings`, `now_ms`; the number of `decision.locks` is the lock count)
- SetPartner (public key copied from the partner page): `Send-Focus @{type='SetPartner'; public_key='<paste key>'}`
- PushWindows, one locked window that started a minute ago and ends in 3 minutes:
  `Send-Focus @{type='PushWindows'; windows=@(@{id='t1'; starts=$now-60000; ends=$now+180000; lock='locked'; mode='block'; sites=@('example.com'); apps=@('notepad.exe')})}`
- RequestChallenge: `Send-Focus @{type='RequestChallenge'; window_id='t1'}` (returns `code`; paste it into the partner page)
- SubmitToken: `Send-Focus @{type='SubmitToken'; token='<paste token>'}`
- ResetClock (clock recovery, see section 7): `Send-Focus @{type='ResetClock'}`

`send` prints the reply and exits 0 whenever the helper answered (an Error reply included); it exits 1 with a message if the helper is unreachable. It works for normal (non-admin) users too.

Terms: "service" = a background Windows program; "ACL" = the permission list on a file or folder; "pipe" = the local channel (`\\.\pipe\mybrain-focus`) the app uses to talk to the helper; "DoH" = encrypted DNS in browsers, which would bypass the hosts-file block.

## Escape hatches (read before testing locks)

- [ ] Snapshot the VM before the locks sections (2-9) — Expected: you can always roll back
- [ ] Always test locks with SHORT durations (2-5 minutes) first — Expected: a mistake costs minutes, not days
- [ ] Keep a partner key ready (see section 6) and push only locks of about 2 minutes — Expected: you have an early exit and a mistake costs minutes
- [ ] If the clock was moved far into the future by mistake and no lock is pending, run ResetClock (`send` above) — Expected: `Ok`; GetStatus `now_ms` is the real time again. With a lock pending it answers `lock-active`
- [ ] Remember: locks always end at their end time — Expected: waiting is always a valid way out
- [ ] The partner token flow is the early exit while a lock is active — Expected: it ends exactly that one window
- [ ] If the helper misbehaves while NO lock is active, run `& "C:\Program Files\MyBrainFocus\focus-helper.exe" uninstall` in PowerShell as Administrator — Expected: services and policies are removed
- [ ] If a lock is active and something is wrong, wait out the end time or use the partner token — Expected: uninstall is refused during a lock (by design)
- [ ] If services are stuck disabled, run `& "C:\Program Files\MyBrainFocus\focus-helper.exe" install` again in PowerShell as Administrator — Expected: services are re-enabled (start=auto) and running

## 1. Install and service hardening

- [ ] Run the installer as Administrator — Expected: it completes with no error dialog
- [ ] Run `sc query MyBrainFocus` and `sc query MyBrainFocusWatchdog` — Expected: both exist and are RUNNING
- [ ] Run `sc qc MyBrainFocus` and `sc qc MyBrainFocusWatchdog` — Expected: START_TYPE is AUTO_START and SERVICE_START_NAME is LocalSystem
- [ ] Check BINARY_PATH_NAME in the `sc qc` output — Expected: it points at `C:\Program Files\MyBrainFocus\focus-helper.exe` (not a per-user folder)
- [ ] Check the Security tab / `icacls "C:\Program Files\MyBrainFocus"` — Expected: SYSTEM full control; Administrators read/execute only; no Users entry
- [ ] In an Administrator prompt run `sc stop MyBrainFocus` — Expected: "Access is denied"
- [ ] In an Administrator prompt run `sc delete MyBrainFocus` — Expected: "Access is denied"
- [ ] Open Services (services.msc) as Administrator, right-click MyBrainFocus — Expected: Stop/Pause/Properties changes are denied or greyed out
- [ ] Watchdog check: in Task Manager Details (with the Command line column) kill the `focus-helper.exe ... watchdog` process — Expected: the main service restarts it within about 10 seconds
- [ ] Main check: kill the `focus-helper.exe ... service` process — Expected: the watchdog restarts it within about 10 seconds (the pipe answers again; run GetStatus)

## 2. Websites

Start a short lock that blocks a test site (e.g. `example.com`).

- [ ] Open the site (and its `www.` and `m.` variants) in Chrome — Expected: the page fails to load
- [ ] Repeat in Edge — Expected: fails to load
- [ ] Repeat in Firefox — Expected: fails to load
- [ ] Open a different subdomain that is not listed (e.g. `blog.example.com`) — Expected: it still loads (known limit: only listed names are blocked)
- [ ] Open `C:\Windows\System32\drivers\etc\hosts` in Notepad as Administrator — Expected: a managed block between `# BEGIN MYBRAIN-FOCUS` and `# END MYBRAIN-FOCUS` markers; any lines you added yourself are unchanged and outside the block
- [ ] During a block, open Notepad AS ADMINISTRATOR, edit the hosts file and save — Expected: "access denied" (a normal user is denied by Windows default, so this is the meaningful test)
- [ ] During a block, open the hosts file Security tab (or `icacls`) — Expected: SYSTEM full control, Administrators read/execute only, Users read only
- [ ] Start a block, let it end, start another, let it end — Expected: the hosts block and its ACL are correct each time (lock, apply, unlock works as SYSTEM) and `service.log` shows no error
- [ ] During a block, as Administrator take ownership/edit the hosts file back to remove the managed block (VM only) — Expected: within about 30 seconds the helper writes the block and the ACL lock back (drift repair)
- [ ] After all blocks end, view the hosts file and its Security tab — Expected: no managed block remains and the ACL is back to the Windows default (Administrators have full control again)

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

## 5. Frozen mode (rejected in this build) and the never-kill list

Frozen mode is not available until sub-project 4 (Ruling 17): the helper rejects every `frozen` window. The real frozen-mode runtime checks (lock screen, IME, Store apps, Windows Security under an empty allow list) move to "after sub-project 4".

- [ ] Push a window with `lock='frozen'` (copy the PushWindows example, change `lock`) — Expected: reply `Error` with code `frozen-unavailable`, and GetStatus shows no new window
- [ ] Push an allow-mode window with no apps (`mode='allow'; apps=@()`) — Expected: `Error`, code `bad-window`, message `allow-needs-apps`
- [ ] Push an allow-mode window with `apps=@('notepad.exe')` and start it (lock `none`), then use Explorer, the taskbar, Start, Win+L and unlock, the emoji panel (Win+.), Settings, Windows Security — Expected: all keep working; only non-listed ordinary apps are closed. The never-kill list (logonui, consent, credentialuibroker, userinit, lockapp, dllhost, wmiprvse, applicationframehost, textinputhost, securityhealthservice, msmpeng, nissrv, searchindexer, wudfhost, tiworker, trustedinstaller, sgrmbroker, dashost, smartscreen, backgroundtaskhost, Memory Compression, Secure System, sppsvc, searchapp, shellhost and the original system entries) is never touched
- [ ] Do the same with a block list that names `explorer.exe` and `dllhost.exe` — Expected: they are NOT closed
- [ ] Record anything that breaks or disappears: ______ (any breakage means CRITICAL_APPS must be widened)
- [ ] Reboot the PC during an active (locked, block-mode) lock — Expected: the lock is still in force after login

## 6. Partner unlock

- [ ] With the network disabled, open `src/modules/focus/partner-unlock.html` in a browser — Expected: the page works fully offline
- [ ] Create a key on the page and set it with SetPartner (`send`) — Expected: `Ok`
- [ ] Push a 3-minute locked window (PushWindows example) and run RequestChallenge for `t1` — Expected: a `Challenge` reply with a `code`
- [ ] Paste the challenge into the partner page and sign it — Expected: a token is produced
- [ ] Submit the token with SubmitToken — Expected: `Ok`; only that one window ends; other windows stay locked
- [ ] Right after, push the SAME window again (same PushWindows command) — Expected: `Ok`, but GetStatus shows 0 locks: the lock does not come back (unlock is remembered until the window's original end)
- [ ] Submit the same token again — Expected: fails with `used`
- [ ] Submit a token made for a different window — Expected: fails with `wrong-lock`
- [ ] Sign a token, wait more than 10 minutes (the token's 10-minute life counts from when it is signed), then submit it — Expected: fails with `expired`
- [ ] Optional: submit a token for a challenge requested more than 1 hour ago (the challenge itself is valid for 1 hour) — Expected: fails with `challenge-expired`
- [ ] Try to set a new partner key while any locked/frozen window with a future end time exists, including a scheduled lock that has not started yet (Ruling 11) — Expected: refused
- [ ] While a locked window exists, push a smaller set of windows (remove or shorten it) — Expected: refused; the locked window stays unchanged

## 7. Clock

- [ ] During a lock, set the system clock back 1 hour — Expected: the lock neither ends early nor gets longer
- [ ] Before the clock tests turn off Windows time sync (Settings > Time & language > Date & time > "Set time automatically" off), and turn it back on afterwards — Expected: Windows does not undo your changes mid-test
- [ ] During a lock, set the clock FORWARD past the end time (even while Windows is running) — Expected: the lock ends early (known limit: only backward moves are defeated). Record the result: ______
- [ ] Set the clock a year forward with no lock pending, run GetStatus, set it back, then run ResetClock — Expected: `now_ms` stayed in the future until ResetClock returned `Ok`; afterwards it is real time. With a pending lock ResetClock returns `lock-active`
- [ ] During a lock, shut down, set the clock forward past the end time, boot — Expected: the lock MAY end early (known limit). Record the result: ______

## 8. Named pipe and permissions

- [ ] As a NON-admin interactive user run GetStatus with `send`, and run MyBrain — Expected: both connect and show Status (the pipe ACL grants interactive users read/write without the create-instance right; the clients use explicit access rights)
- [ ] Trust boundary (informational): any interactive local user can drive the helper through the pipe (push windows, request challenges). Hard mode is friction, not a security boundary against other local users
- [ ] As a non-admin user, run a small test program that tries to create its own `\\.\pipe\mybrain-focus` instance — Expected: access denied
- [ ] From another PC on the network, try to open `\\<pc-name>\pipe\mybrain-focus` — Expected: cannot connect
- [ ] Open 20 connections to the pipe at once (script) and hang up abruptly — Expected: blocking continues; the app reconnects afterwards

## 9. State directory

- [ ] Run `dir /q C:\ProgramData` (or Security > Advanced > Owner) and `icacls C:\ProgramData\MyBrainFocus` — Expected: owner is SYSTEM; SYSTEM full control, Administrators read/execute only, no Users entry
- [ ] Before first install (clean PC), as a standard user create `C:\ProgramData\MyBrainFocus`, then install — Expected: that folder is renamed aside (quarantined, named `MyBrainFocus.untrusted-<n>`) and a fresh protected one is created
- [ ] (VM only, no lock active; needs a SYSTEM shell, e.g. `psexec -s cmd` from Sysinternals, because even Administrators cannot write there) Inside the state directory create a junction (`mklink /J`) to a harmless test folder with a file in it, then restart the service (reboot or after the lock) — Expected: the junction is removed as a link and the test folder and its file are untouched
- [ ] As a standard user try to edit `state.json` — Expected: access denied
- [ ] (VM only, take a snapshot first, NO lock active: this can corrupt persistence mid-lock; needs a SYSTEM shell as above) Make the state directory read-only for SYSTEM, then check Status — Expected: warnings contain `persist:`, and a request that changes state returns `persist-failed`
- [ ] Corrupt `state.json` and `state.json.bak` (VM only, no lock, SYSTEM shell), restart the service, run GetStatus — Expected: warnings contain `state: unreadable, started empty` and name a `state.json.corrupt-<n>` file that still exists
- [ ] Restore the directory permissions afterwards — Expected: Status warnings clear

## 10. Installer, upgrade, uninstall

- [ ] Uninstall via Settings > Apps while a locked/frozen window with a future end time exists — Expected: refused with the lock message (the GUI shows a message box and aborts; it does not show an exit code); services still present
- [ ] Run `& "C:\Program Files\MyBrainFocus\focus-helper.exe" uninstall` from an elevated PowerShell while such a window exists, then check `$LASTEXITCODE` (PowerShell) or `%ERRORLEVEL%` (cmd) — Expected: 1
- [ ] Check the refusal text from the uninstall command — Expected: the end time is shown as `YYYY-MM-DD HH:MM:SS UTC`
- [ ] Uninstall when no such window exists — Expected: succeeds; plain uninstall leaves `C:\ProgramData\MyBrainFocus` in place (no `--purge-state`) and that is NOT a failure
- [ ] Re-run the installer as Administrator over an existing install with no lock pending — Expected: succeeds
- [ ] Re-run the installer while a lock is pending and the service is running — Expected: the helper refuses with a clear message (known: upgrades wait for locks, up to 30 days), the installer continues and shows "could not be installed or upgraded (exit code 1)"; details are in `%TEMP%\mybrain-focus-install.log`
- [ ] Kill the installer midway (e.g. while it runs `sc config`), then run `& "C:\Program Files\MyBrainFocus\focus-helper.exe" install` in PowerShell as Administrator — Expected: both services end up with start=auto and running
- [ ] Confirm the first installer build compiled (NSIS hook macro names and `$UpdateMode` were not verified offline) — Expected: the build-windows run is green and the installer launches
- [ ] Install a newer app build over an older one (in-place update, no lock) — Expected: not blocked by the PREUNINSTALL Abort

## 11. Logs

- [ ] Open `%TEMP%\mybrain-focus-install.log` — Expected: every install/uninstall step and error from sections 1 and 10 is listed
- [ ] Open `C:\ProgramData\MyBrainFocus\service.log` — Expected: it exists and is readable by SYSTEM/Administrators
- [ ] After sections 8 and 9 tests, search the log — Expected: pipe and persist errors from those tests are recorded

## 12. Focus Room screens (sub-project 2)

- [ ] Open Focus Room, start a block from the UI on a list containing a site you can open (e.g. reddit.com), then reload that site in a browser — Expected: the site stops loading; after pressing Cancel on the block the site loads again
- [ ] With no lock pending and no block running, stop the `MyBrainFocus` service (`sc stop MyBrainFocus`) and watch the Focus Room page — Expected: the red "helper isn't running" banner appears within 10 seconds; after `sc start MyBrainFocus` it returns to green within 10 seconds
- [ ] Stop the `MyBrainFocus` service, start a block from the UI, then start the service — Expected: the listed site is blocked without touching the UI again
- [ ] While a block is running, edit a list in it (add a site, remove another) and save — Expected: the new site is blocked and the removed one loads again
- [ ] Block an app whose name contains spaces (e.g. a game launcher such as `League of Legends.exe`) and try to run it — Expected: it is closed while the block runs
- [ ] On a fresh profile, click each starter on the first-run card (Social media, News, Games, Blank list) and save — Expected: each creates a list that you can edit and delete afterwards

## 13. Focus locks (sub-project 4a)

Nothing here has been run on Windows; these items are the only proof. Use short locks (the shortest allowed wait is 1 hour, so only the wait items take long). Snapshot the VM first.

- [ ] In Focus Room open Start a block, choose Locked, and set up a partner (paste the key from the partner page) — Expected: partner setup is accepted and the Locked option becomes selectable
- [ ] Start a locked block of about 10 minutes with a 1 hour wait option, then try to change the partner key — Expected: refused during the lock
- [ ] During the lock, look for a way to cancel or shorten the block in the app — Expected: there is none; the card shows "Locked" and offers only Unlock
- [ ] During the lock, edit the list in the block (remove a site) — Expected: the removal is refused; the block stays unchanged
- [ ] During the lock, close the app completely and open the blocked site — Expected: the site is still blocked and a blocked app is still closed
- [ ] During the lock, reboot Windows and, without opening the app, open the blocked site — Expected: still blocked; reopening Focus Room still shows the locked block with the correct time left
- [ ] During the lock, run `sc stop MyBrainFocus` and `sc delete MyBrainFocus` in an Administrator prompt — Expected: both denied
- [ ] During the lock, run the uninstaller (or `focus-helper.exe uninstall`) — Expected: refused; the services and hosts block remain
- [ ] During the lock, choose Unlock with a partner token, copy the code to the partner page, sign it, paste the token back — Expected: the block ends and the site loads again
- [ ] Reopen Focus Room after a token unlock — Expected: the block does not return as locked (the unlock is remembered until the original end time)
- [ ] Paste a wrong token (for example one made for another window) in the unlock dialog — Expected: a clear error and the block stays locked
- [ ] Start a new locked block (10 minutes or more) and choose Unlock by waiting with the 1 hour option — Expected: a pending card shows the time until the unlock and the site stays blocked in the meantime
- [ ] Leave the wait running, close and reopen the app, then reboot — Expected: the pending card and its countdown are still correct
- [ ] While a wait is pending, set the system clock back 1 hour (turn off automatic time first) — Expected: the countdown does not get shorter; the unlock time does not move earlier
- [ ] While a wait is pending, choose Cancel wait — Expected: the card returns to the plain locked state and the block stays locked until its end
- [ ] Start another wait and let the full hour pass (or, if the block ends first, note that it simply ends) — Expected: the block unlocks at the wait time and the site loads again
- [ ] Start a locked block while the service is stopped (only possible with no lock pending: `sc stop MyBrainFocus`, then try to start a Locked block) — Expected: the start is refused with the "helper isn't running" error and no block is created; restart the service afterwards
- [ ] With a locked block pending its start time in the future, try to change the partner key — Expected: refused

## 14. Folder blocking and file pickers

Use a throwaway folder such as `C:\Games\Foo` containing a copy of a harmless program (for example `notepad.exe`), and a sibling `C:\GamesX` with another copy.

- [ ] In a list editor, click Browse files and choose one or more `.exe` files — Expected: the dialog opens filtered to programs (.exe); each pick becomes an app chip with just the file name
- [ ] Click Browse folder and choose `C:\Games\Foo` — Expected: a folder chip appears (`Foo`, with the full path on hover) and can be removed with its x
- [ ] Start a block on a list with that folder, then run the copy of the program from `C:\Games\Foo` — Expected: it is closed within a few seconds
- [ ] While the block runs, run the copy from `C:\GamesX` — Expected: it keeps running (a sibling folder with the same prefix is not blocked)
- [ ] While the block runs, copy another program into `C:\Games\Foo` (or a subfolder) and run it — Expected: it is closed too (programs installed afterwards are covered)
- [ ] Try to add `C:\Windows` (or `C:\Program Files`) with Browse folder — Expected: refused with "That folder is part of Windows and can't be blocked." and no chip is added
- [ ] Start a locked block with a folder, reboot Windows without opening the app, then run a program from the folder — Expected: it is closed; reopening Focus Room still shows the locked block
- [ ] Known limit: run an elevated (Run as administrator) program from the blocked folder whose path the helper cannot read — Expected: record what happens (the helper runs as LocalSystem and can normally read and close elevated programs; only protected programs return no path and are skipped); blocking it by file name in Apps still works
- [ ] In the partner setup dialog, click Save the partner page — Expected: a Windows Save dialog opens with `partner-unlock.html` suggested
- [ ] Choose the Desktop and Save — Expected: `partner-unlock.html` lands on the Desktop and the dialog shows "Saved to <path>. Send this file to your partner..."
- [ ] After saving — Expected: Explorer opens with `partner-unlock.html` selected
- [ ] Save the partner page into a folder whose name has spaces (for example `My Files`) — Expected: the file is written there, the message shows the full path, and Show in folder opens Explorer with the file selected
- [ ] Cancel the Save dialog — Expected: nothing is written and no message appears
- [ ] Open the saved page in a browser with the network off — Expected: it loads and works offline

## 15. Recurring schedules

Use a list with one site you can test (for example `reddit.com`). Set the schedule times a few minutes ahead so you do not have to wait.

- [ ] Create an unlocked schedule that starts in about 3 minutes and ends 10 minutes later, then close Focus Room completely — Expected: at the start time the site is blocked with the app closed, and at the end time it loads again
- [ ] Create a schedule that crosses midnight (for example 23:55 to 00:10) — Expected: it blocks before midnight, keeps blocking after midnight, and stops at 00:10; its row reads "(overnight)"
- [ ] Create a locked schedule (Locked, an end date a few days ahead, a 1 hour waiting period) and let one occurrence start — Expected: the site is blocked and a locked card with Unlock early appears
- [ ] Reboot Windows during a locked occurrence and do not open the app — Expected: the site is still blocked after the reboot; reopening Focus Room shows the locked card and the locked schedule row
- [ ] Look at the locked schedule row — Expected: Edit, Pause and Delete are disabled with the reason "locked until <date>"; the list it uses cannot be edited or deleted either
- [ ] During a locked occurrence, unlock it with the partner code — Expected: the site loads again, and the schedule's next occurrence (the next day or the next matching day) still blocks when it starts
- [ ] Create an unlocked schedule, then choose Pause before its next start — Expected: the row reads "Paused", and nothing is blocked at the next start time; Resume brings it back
- [ ] Delete an unlocked schedule — Expected: its row goes and no further occurrence blocks

## 16. Usage analytics

A small sampler process (`focus-helper sampler`) runs in your signed-in session and reports the foreground program to the helper service every second (older installs report every 5 seconds until the next sign-in). Titles are read only for browsers, to attribute time to a site. The sampler is started by a Run entry at sign-in, so after installing, sign out and in once before testing this section.

- [ ] After install, sign out and sign back in — Expected: Task Manager (Details tab) shows `focus-helper.exe` running in your user session (not as SYSTEM) with the `sampler` argument, and no window or console appears
- [ ] Check `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` — Expected: a value `MyBrainFocusSampler` with the quoted installed exe path followed by `sampler`
- [ ] End the sampler process in Task Manager and wait 20 seconds, then work in a program — Expected: `focus-helper send "{\"type\":\"GetStatus\"}"` shows `usage_tracking` false and nothing is counted, and Focus Room > Stats still shows the earlier history together with the "not tracking right now" banner; after the next sign-in tracking resumes
- [ ] With the sampler running (signed in since install), run the installer again as Administrator — Expected: it succeeds (running samplers are stopped first); sign out and in once to bring the sampler back
- [ ] With the sampler running, uninstall — Expected: it succeeds and `C:\Program Files\MyBrainFocus` is removed
- [ ] With two Windows users signed in at once (fast user switching), work in one — Expected: time is not double counted (the usage total grows by about the real elapsed time)
- [ ] Unlock the PC after a long lock — Expected: at most a few seconds of time appear around the unlock (the 15-second cap), not the whole lock period
- [ ] Work in a program (for example Notepad) for a couple of minutes, then open Focus Room > Stats — Expected: that program's time is counted
- [ ] Leave the PC untouched for more than 5 minutes with the program in front — Expected: time stops counting once the last input is older than 5 minutes
- [ ] Lock the PC (Win+L) for a few minutes, then unlock — Expected: nothing is counted while locked (this verifies that the sampler cannot open the input desktop on the lock screen)
- [ ] Open different sites in Chrome or Edge in separate tabs, switching between them — Expected: time is attributed to the right site for each tab title, and browser time is counted too
- [ ] Reboot Windows, do not open Focus Room, work for a few minutes, then open it — Expected: tracking continued after the reboot with the app closed
- [ ] Work across midnight (or change the date after a day of use) — Expected: usage rolls over to a new day entry at the local day boundary
- [ ] Open `C:\ProgramData\MyBrainFocus\usage.json` after browsing — Expected: it holds program and site names and seconds only, with no window titles

## 17. Cleanup

With no lock pending, uninstall MyBrain.

- [ ] Open `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` — Expected: the `MyBrainFocusSampler` value is gone (also after a plain uninstall without `--purge-state`)
- [ ] Run `sc query MyBrainFocus` and `sc query MyBrainFocusWatchdog` — Expected: both report "service does not exist"
- [ ] Open the hosts file — Expected: no managed block and no BEGIN/END MYBRAIN-FOCUS markers
- [ ] Check the Chrome/Edge/Firefox policy pages — Expected: DoH values written by the helper are gone
- [ ] Search `C:\Windows\System32\drivers\etc` and `C:\Program Files\MyBrainFocus` for `.focus-tmp` and `.new` files — Expected: none left (and the Program Files folder is gone)

## 18. Detailed analytics (second-level timeline, hours, averages, drill-down)

Focus Room > Stats has a Today tab (a second-accurate timeline of the day with zoom 24 h, 6 h, 1 h and 10 min, plus active time, longest stretch, switches per active hour, first and last activity and streaks), an Hours-of-the-day bar chart on Day, Week, Month and Year (with the weekday-by-hour heatmap on Week, Month and Year) and Averages, and a drill-down page for any app or site (daily trend, peak hour, per-day timeline). The helper keeps second detail for 90 days and per-hour totals for 730 days. Sign out and in once after installing so the new 1-second sampler runs.

- [ ] Open Today, then switch between Notepad and Calculator at times you note with a stopwatch (for example 2 minutes in each, three rounds) — Expected: at the 10 min zoom the stretch edges match your stopwatch within about 2 seconds
- [ ] Leave the PC untouched for more than 5 minutes with a program in front — Expected: the timeline shows no stretch for the time after the 5 minute idle limit
- [ ] Lock the PC (Win+L) for a few minutes, then unlock — Expected: a gap in the timeline for the locked time
- [ ] Browse two different sites in Chrome or Edge for a few minutes each — Expected: the browser stretches are labelled with the site; the site drill-down shows its stretches on the day it was used
- [ ] Upgrade over an existing install that already has `usage.json` — Expected: old days keep their totals and charts; the Hours-of-the-day section says "Hour detail is recorded from the update onwards" only when NO day in the range has hour data, otherwise its caption reads "Based on N of M days"; Today and the drill-down timeline say the detailed timeline is not available for old days
- [ ] Restart the service (`sc stop MyBrainFocus`, then `sc start MyBrainFocus`) after working for a few minutes — Expected: Today still shows the earlier stretches (at most the last minute before a stop is lost only in a crash, not in a normal stop)
- [ ] Look in `C:\ProgramData\MyBrainFocus` — Expected: `sessions-YYYY-MM-DD.json` files next to `usage.json`, and Focus Room > Stats opens without a warning
- [ ] Reinstall or update with `sessions-*` files present — Expected: the state directory still adopts cleanly (permissions applied, no errors in the install log); then create an unexpected extra file there (for example `junk.txt`) and reinstall — Expected: the extra file is still removed, the `sessions-*` files stay
- [ ] Use a day with a time change (spring forward 23 hours, or fall back 25 hours; set the Windows time zone to one with DST and move the date) — Expected: the Today/drill-down timeline spans the real 23 or 25 hours with correct clock labels and no overlap or missing hour
- [ ] Watch `focus-helper.exe` (sampler and service) in Task Manager for a minute while idle and while working — Expected: CPU stays near 0 percent for the 1-second reports
- [ ] Open the drill-down for a program, use the previous-day button, and drag the zoom pan — Expected: the timeline moves; note if the 60 second auto refresh interrupts a drag

Accepted limits (not failures):
- A crash or power loss can lose up to the last minute of stretches (they are flushed about once a minute and on a normal stop); totals follow the same flush.
- Seconds at an hour boundary can be attributed one second to the neighbouring hour.
- A sampler started before the update keeps reporting every 5 seconds until the next sign-in, so its time has coarser stretches.
- Second detail is kept for 90 days and hour totals for 730 days; older days show daily totals only.
- A very busy day can stop recording stretches (the page says "Timeline incomplete"); totals stay complete.
- The per-app peak hour is shown for the viewed day only.
- Stretches are dropped while wall time is behind the last recorded end after a clock step; the totals keep counting, so Today's Active time shows the larger of the two.
- A short lock or stall can merge or split a stretch by up to a few seconds.
- The day the update is installed has no hour data for the rest of that day (hours are never mixed with pre-update seconds).
- If an old and a new sampler both report on one day, hours can end up lower than the day's total.
- A pan drag can be interrupted when the page refreshes itself every 60 seconds.

## 19. Time limits (sub-project 6b)

Focus Room > Time limits keeps a daily or weekly allowance per group of apps and sites. The helper counts the time from the usage the sampler reports (the same numbers as Stats) and, once a limit is used up, ends the apps and blocks the sites until the period ends. All items in one limit share one pool. A locked limit cannot be deleted or made weaker from the app. Snapshot the VM first; sign out and in once after installing so the sampler runs. Limit ids are `limit-<n>` (see GetLimits below).

- GetLimits: `Send-Focus @{type='GetLimits'}` (shows `limits`, `status` with `used_secs`, `cap_secs`, `blocked`, `period_ends_day`, and `pending_unlocks`; a limit appears in `status` once the sampler has reported a day)
- PushLimits (a 2 minute daily limit on Notepad): `Send-Focus @{type='PushLimits'; limits=@(@{id='limit-1'; name='Notepad'; apps=@('notepad.exe'); sites=@(); period='daily'; cap_secs=120; lock='none'})}`; the reply is `LimitsPushed` with `kept_locked` and `skipped_tombstoned`

- [ ] Add a daily limit of 2 minutes for `notepad.exe` in the app, then work in Notepad — Expected: the row shows the time used and left growing; at 2 minutes Notepad is closed, reopening it is closed again within a few seconds, and the row says "Blocked" and "Used up, back on" tomorrow's date
- [ ] While Notepad is blocked, run `Send-Focus @{type='GetStatus'}` — Expected: `block_apps` lists `notepad.exe` and `limit_blocks` lists the limit with its `until_day` (raw helper JSON field names)
- [ ] Add a daily limit of 2 minutes for a site (for example `youtube.com`) and use that site in Chrome or Edge for 2 minutes (tab title carrying the site name) — Expected: the site stops loading (hosts file) and the row says Blocked; other sites still load
- [ ] Add a limit that holds two apps (for example Notepad and Calculator) and use both — Expected: their time is added into one pool and the block hits both together
- [ ] With a limit used up, wait for local midnight with the PC on and keep working (the sampler reports the new day) — Expected: the limit lifts at midnight, the row shows the full allowance again, and the program/site works
- [ ] With a weekly limit used up, check on a Sunday night and then on Monday — Expected: it still blocks on Sunday and lifts at the start of Monday (local time); the row says "back on" the Monday date
- [ ] Use a limit up, then leave the PC idle across midnight without any program in front (nothing reports) and check GetLimits — Expected: still `blocked` until the first sampler report of the new day
- [ ] Pause a limit in the app, then resume it — Expected: while paused nothing is blocked; resume restores enforcement from the day's recorded usage. Usage keeps being recorded during the pause for apps and for sites in the built-in site map only: a paused limit is not pushed to the helper, so a site outside that map is labelled `other` while paused (or before the limit existed) and is never counted retroactively
- [ ] Create a locked limit (the partner key must be set; choose a 1 hour wait) and try to delete it, raise its cap, remove an app, switch daily to weekly, and set it to Normal in the editor — Expected: the app cannot weaken it; each attempt is refused or reported and `GetLimits` still shows the original terms; lowering the cap or adding an app works
- [ ] With the locked limit, `Send-Focus` a push that omits it or raises its cap — Expected: the reply lists its id in `kept_locked` and `GetLimits` is unchanged
- [ ] Unlock the locked limit with the partner code (Unlock in the editor or the unlock dialog, sign the code on the partner page, paste the token) — Expected: the limit becomes a normal limit; an older locked copy cannot come back (a re-push reports the id in `skipped_tombstoned`)
- [ ] Create another locked limit and choose Unlock by waiting; leave it for the full wait (reboot and reopen the app in between) — Expected: the pending card survives, and after the wait the limit becomes a normal limit; cancelling the wait keeps it locked
- [ ] Use a limit up, close the app completely, then reboot and, before you sign in, check from another admin session or the service log (or sign in and test the program at once) — Expected: limits survive the reboot with the app closed, and an exceeded limit still blocks right after the service starts, before any new sampler report
- [ ] With a limit used up, run `sc stop MyBrainFocus` then `sc start MyBrainFocus` (no lock pending) and immediately check `GetStatus` — Expected: `limit_blocks` still lists the limit
- [ ] Use a day with a time change (spring forward or fall back, set the time zone to one with DST) with a daily limit — Expected: the limit resets at the local midnight of that 23 or 25 hour day, not an hour early or late
- [ ] Change the Windows time zone while a limit is used up (for example to one 5 hours behind) — Expected: it keeps blocking until the sampler reports a later day; the used time never drops because of the change
- [ ] As a standard user (no admin), change the Windows time zone to one far east (for example UTC+14 or UTC+13) while a limit is used up, and keep working until the sampler reports — Expected on this build: the sampler reports local date = UTC date + 1, which is accepted as the current day, so the limit lifts for the rest of that real day (an accepted limit, see below); record it, do not file it as a failure
- [ ] End the sampler process (Task Manager, as the signed-in standard user) while a limit is not yet used up, and keep using the program — Expected: nothing is counted while it is not running and the limit never reaches its cap; Focus Room shows "Not counting right now" with no bar after a short while (accepted limit, see below)
- [ ] With only a limit used up (no block window active), start `openvpn.exe` or `tor.exe` if available and check that DoH settings are unchanged — Expected: the limit's app is closed but VPN apps are not killed and encrypted DNS is not turned off; start a block window and both friction measures apply as before
- [ ] Day spoof: with a limit used up, send `Send-Focus @{type='ReportForeground'; exe='x.exe'; title=$null; idle_secs=0; day='<yesterday>'}` — Expected: still blocked (a day going backwards never lowers used time); a report for a day more than 2 days from today is refused (`bad-request`), and a day one ahead of the UTC date is accepted and can lift a limit (see accepted limits)
- [ ] Stop the service and open Focus Room > Time limits — Expected: saved limits are listed with "Enforcement is not running", no zero or "0m left" numbers

Accepted limits (not failures):
- Site limits are approximate: time is attributed from browser tab titles, so a tab whose title does not carry the site name (or a page title that happens to) counts wrongly, and a limit on a site that is not in the title alias table needs the title to contain the site's name. The alias table maps multi-word labels such as X (titles ending in "/ X"), Twitter, YouTube, Reddit, Google Docs, Google Sheets, Google Slides, Google Drive, Google Calendar, Google Maps, Google Meet, Google Photos, Google Translate, Google Scholar, Google News, Microsoft Teams, Stack Overflow and Hacker News, plus many common sites (Facebook, Instagram, TikTok, Twitch, GitHub, Gmail, LinkedIn, Discord, Spotify, ChatGPT, Notion, Slack, Zoom and others). Other multi-word labels may not match.
- There are no notifications when a limit is nearly used up; the program or site is simply closed or blocked at the cap.
- Silence never unblocks: a used-up limit stays blocking until the first sampler report of a new day, which can be a while after sign-in.
- A local user who can write to the helper pipe can spoof a report for a day one ahead of the UTC date and so lift a day early, the same trust level as spoofing usage reports.
- Moving the system clock forward can lift a limit a day early, as it can for locks.
- Locked limits do not yet gate uninstall or stopping the service; that is part of the uninstall protection project (6c).
- One shared pool per limit: there is no per-app split inside a limit.
- A standard user can change the Windows time zone without admin rights. Moving east makes the sampler report local date = UTC date + 1, which the helper accepts as the current day, so a used-up limit resets for the rest of that real day. Moving west does not lift anything. This is not prevented.
- The sampler runs as the signed-in user, who can end it. While it is not running nothing is counted, so the limit never reaches its cap; the app shows "Not counting right now" (the helper reports `usage_tracking: false`), but nothing restarts it by force.
- An unlisted site (one outside the built-in site map) counts only while its limit exists in the helper: the domain stem used to label usage comes from pushed limits, so earlier or paused time on it was recorded as `other` and is never counted retroactively.
- Limit blocks do not trigger the VPN-kill or encrypted-DNS-off friction; only block windows do. So DoH and VPN apps can bypass a site limit. Accepted, the same trust level as the rest of the friction design.
- Weeks start on Monday (local time), not on a setting.

## Report back

If any check fails, send: the section and line number, what you saw instead, the contents of `C:\ProgramData\MyBrainFocus\service.log` and `%TEMP%\mybrain-focus-install.log`, the output of `sc qc` for both services, a screenshot of any error dialog, your Windows version (`winver`), and the exact names of any process that was wrongly closed.
