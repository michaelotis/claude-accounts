import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Account, AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { WindowBinding } from './binding';
import { getAuthStatus, AuthStatus } from './cli';
import { snapshotAccount, defaultSourceDir, mirrorToDefault, stampIdentity } from './capture';
import { ensureSharedHistory } from './sharedHistory';
import { signOut, interruptSessions, dirsHoldingToken, looksLikeLogout } from './reclaim';
import {
  refreshStore,
  allWorkingDirs,
  materialize,
  syncMcpServers,
  linkUserSettings,
  foreignTokenConflict,
  sameCredential,
} from './workdir';
import { log } from './log';
import { emailsEqual, matchWorkspaceRoute, type WorkspaceRoute } from './workspaceRoutes';

/**
 * All the user-facing flows.
 *
 * The model, in one paragraph: an ACCOUNT is a store on disk (`~/.claude-<name>`)
 * plus its entry in the registry. A WINDOW never points at a store — it points at
 * a working dir of its own, stocked with a copy of the account it runs (see
 * workdir.ts for why that separation is load-bearing). Signing in inside a window
 * therefore rewrites only that window's working dir, and reconcile() simply
 * follows it: whatever account the window's dir now holds is the account that
 * window runs. Nothing else on disk, and no other window, is affected.
 */

/**
 * A message to show AFTER a window reload. A reload kills any toast raised just
 * before it, so news that has to outlive one goes here.
 */
export const NOTICE_KEY = 'claudeProfiles.pendingNotice';

/** workspaceState: when this window last reloaded itself automatically. */
const RELOAD_STAMP_KEY = 'claudeProfiles.lastAutoReload';

export class SetupWizard {
  constructor(
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding,
    private readonly context: vscode.ExtensionContext
  ) {}

  /**
   * The ONLY way any flow in this extension reloads the window.
   *
   * Auto-reloads are decided from state that SURVIVES the reload (disk,
   * workspaceState), so a bug that leaves the trigger state in place turns
   * "reload to recover" into a reload LOOP — v1.2.1 shipped exactly that.
   * Two lines of defence, both mandatory:
   *
   *   1. Every auto-reload site must change the state it triggered on BEFORE
   *      calling this, so the same condition cannot re-fire after the reload.
   *   2. The circuit breaker here: at most one AUTOMATIC reload per minute per
   *      window (the stamp lives in workspaceState, so it survives the reload).
   *      A second one inside that minute degrades to a message with a manual
   *      "Reload window" button — which breaks any loop a future bug could
   *      still construct, at the cost of one extra click.
   *
   * `userInitiated` bypasses the breaker (an explicit switch/forget must always
   * act) but still stamps, so a follow-up automatic reload is metered.
   */
  /** True if this window reloaded itself within the auto-reload cooldown. */
  private recentlyReloaded(withinMs = 60_000): boolean {
    const last = this.context.workspaceState.get<number>(RELOAD_STAMP_KEY, 0);
    return last > 0 && Date.now() - last < withinMs;
  }

  private async requestWindowReload(
    notice: string | undefined,
    opts: { userInitiated?: boolean } = {}
  ): Promise<void> {
    const now = Date.now();
    const last = this.context.workspaceState.get<number>(RELOAD_STAMP_KEY, 0);
    if (!opts.userInitiated && now - last < 60_000) {
      log(`auto-reload SUPPRESSED (${now - last}ms after the previous one): ${notice ?? ''}`);
      // Do not claim "was reloaded" when we are skipping — that is the confusing
      // toast after Switch Account (first reload already applied the account).
      void vscode.window
        .showWarningMessage(
          `Claude Accounts: already reloaded this window a moment ago, so a second automatic ` +
            `reload was skipped. If the account or usage still looks wrong, reload once more.`,
          'Reload window'
        )
        .then((pick) => {
          if (pick === 'Reload window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      return;
    }
    await this.context.workspaceState.update(RELOAD_STAMP_KEY, now);
    if (notice) await this.context.globalState.update(NOTICE_KEY, notice);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * "Your account is gone — here's what to do next", with the do-it button
   * attached: a bare "sign in" message when saved accounts exist reads as a
   * dead end, even though switching is one click away.
   */
  private offerAccountPick(reason: string): void {
    const hasAccounts = this.registry.listUniqueByEmail().length > 0;
    void vscode.window
      .showInformationMessage(
        `Claude Accounts: ${reason} ${
          hasAccounts
            ? 'Pick another saved account, or sign in with Claude Code (its account menu, or /login).'
            : 'Sign in with Claude Code (its account menu, or /login).'
        }`,
        ...(hasAccounts ? ['Switch account'] : [])
      )
      .then((pick) => {
        if (pick === 'Switch account') {
          void vscode.commands.executeCommand('claudeProfiles.switchAccount');
        }
      });
  }

  // ─── Saving the account a window is signed in as ────────────────────────────

  /**
   * Saves the account currently signed in inside `sourceDir` and binds this
   * window to it. The email IS the account's identity — nothing to name, and an
   * account already known by that email is reused rather than copied again, so
   * signing in twice as the same user can never mint a duplicate.
   *
   * `silent` suppresses even the "not signed in" warning: reconcile() calls this
   * on a timer, where a signed-out dir is a normal state and not an error.
   */
  async captureCurrentAccount(
    opts: { quiet?: boolean; sourceDir?: string; silent?: boolean } = {}
  ): Promise<Account | undefined> {
    const sourceDir = opts.sourceDir ?? this.binding.getEnvDir() ?? defaultSourceDir();

    // The identity file already names the account, and the token file next to it
    // says it's signed in — that's everything we need. Asking the CLI instead
    // means spawning a login shell and a 250MB binary, whose cold start is why a
    // freshly signed-in account used to take half a minute to show up. The CLI is
    // still used for the deliberate "Save current account" command, where the user
    // is waiting on an answer and a definitive check is worth the wait.
    const identity = readIdentity(sourceDir);
    const status: AuthStatus | null =
      opts.silent && identity && hasCredentials(sourceDir)
        ? { loggedIn: true, email: identity.email, orgName: identity.organizationName }
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Reading current Claude account…',
            },
            () => getAuthStatus(sourceDir)
          );

    if (!status?.loggedIn || !status.email) {
      if (!opts.silent) {
        vscode.window.showWarningMessage(
          'No signed-in Claude account detected in this window. Sign in with Claude Code first ' +
            '(Account menu → Login, or /login in a chat).'
        );
      }
      return undefined;
    }

    // Known account? Reuse its store — never a second copy of the same email.
    // Take the opportunity to freshen the store with the token now in use.
    const known = this.registry.savedForEmail(status.email);
    if (known) {
      known.email = status.email;
      await this.registry.add(known);
      refreshStore(known, sourceDir);
      await this.binding.bind(known);
      if (!opts.quiet) {
        vscode.window.showInformationMessage(`${status.email} — this window is bound to it.`);
      }
      return known;
    }

    // Forgotten before? Its store is still on disk (forget signs it out, it never
    // deletes), so restore the entry instead of inventing a second one.
    const restored = await this.registry.restoreForgotten(status.email);
    const target: Account =
      restored ??
      (() => {
        const name = suggestName(
          status.email!,
          (n) => !this.registry.get(n) && !fs.existsSync(path.join(os.homedir(), `.claude-${n}`))
        );
        return { name, dir: path.join(os.homedir(), `.claude-${name}`), email: status.email };
      })();

    try {
      snapshotAccount(sourceDir, target.dir, status);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not save account: ${(err as Error).message}`);
      return undefined;
    }
    await ensureSharedHistory([target.dir]);
    target.email = status.email;
    await this.registry.add(target);
    await this.binding.bind(target);
    if (!opts.quiet) {
      vscode.window.showInformationMessage(`Saved ${status.email} — this window is bound to it.`);
    }
    return target;
  }

  // ─── Keeping the window in step with what's on disk ─────────────────────────

  /**
   * Guards against overlapping runs. reconcile() is driven by three independent
   * triggers (activation, the file poll, window focus) and does slow async work,
   * so two runs in flight would save the same account twice.
   */
  private reconciling?: Promise<void>;

  async reconcile(opts: { atActivation?: boolean } = {}): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce(opts).finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileOnce(opts: { atActivation?: boolean }): Promise<void> {
    // Re-read the account list off disk first. `globalState` is per-extension-host,
    // so an account saved or forgotten in ANOTHER window is invisible here until
    // this one restarts — which is why a newly added account never showed up in the
    // other window's Switch list. The stores on disk are the shared truth, so every
    // window converges on them: discover what appeared, drop what was signed out.
    await this.registry.discoverAndMerge();
    await this.registry.pruneSignedOut();

    // Once bound, this is the window's OWN working dir: no other window writes to
    // it, so everything below concerns this window alone. Before the first bind
    // it is still the default dir — that's where Claude Code is signed in out of
    // the box, and where a brand-new user's account is found.
    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    const onDefault = path.normalize(dir) === path.normalize(defaultSourceDir());

    if (!hasCredentials(dir)) {
      const active = this.binding.getActiveName();

      // The account is gone from disk entirely — it was FORGOTTEN, most likely from
      // another window (there is no API to reload someone else's window, so this is
      // how the news reaches us).
      if (active && !this.registry.get(active)) {
        // Release FIRST: the stale name survives a reload (workspaceState, repo
        // map), and reloading with it in place re-enters this branch forever.
        const wasRunningIt = Boolean(this.binding.getEnvDir());
        await this.binding.release();
        if (wasRunningIt) {
          // The window is sitting on a dir we just found emptied, with a dead
          // session and a panel naming an account that no longer exists —
          // nothing here worth keeping, so reload rather than ask.
          await this.requestWindowReload(
            `The account this window was running was forgotten and signed out.`
          );
        } else {
          // The window merely REMEMBERED the forgotten account (it was closed
          // when the forget happened, so applyStored never bound it). Nothing
          // is running on it and a reload would change nothing — just point
          // the user at the way forward.
          this.offerAccountPick(`The account this window last used was forgotten and signed out.`);
        }
        return;
      }

      // Signed out, but the account still exists on disk ⇒ the user ran /logout in
      // THIS window. Careful, though: a dir is ALSO tokenless for the whole time a
      // sign-in is in flight — Claude Code deletes the old credentials before it
      // sends the user to the browser — and at this instant the two are
      // indistinguishable. Treating a sign-in as a logout would sign out a
      // perfectly good account while the user is away authorising.
      //
      // At ACTIVATION there is no ambiguity: an OAuth flow cannot survive a window
      // reload, so a dir still tokenless when the window comes up really is logged
      // out. That is the only moment it is safe to conclude anything.
      if (opts.atActivation) await this.handleLoggedOut(dir);
      return;
    }
    const email = readIdentity(dir)?.email;
    if (!email) return; // token but no identity yet — a sign-in mid-flight

    const active = this.binding.getActiveName();
    const bound = active ? this.registry.get(active) : undefined;

    const boundEmail = bound ? this.registry.emailOf(bound) : undefined;

    // Identity drift: the dir's .claude.json identity no longer matches the account
    // this window is bound to. That is EITHER a deliberate /login as another account
    // here, OR an identity BLEED — Claude Code re-stamped the dir's identity from the
    // shared home config while the TOKEN did not change. The identity field alone
    // can't tell them apart, and guessing wrong corrupts credentials, so we decide
    // by the TOKEN, never the identity: on drift we NEVER pull dir→store.
    //
    // boundEmail uses emailOf (reads the store) not bound.email — discovered
    // accounts carry no cached email, and missing it here would skip drift handling.
    const drifted = Boolean(boundEmail && !emailsEqual(boundEmail, email));
    if (drifted && !onDefault) {
      const dirTok = this.readToken(dir);
      const boundTok = bound ? this.readToken(bound.dir) : undefined;
      const owner = dirTok ? this.accountOwningToken(dirTok, dir) : undefined;

      // (A) A FRESH grant no saved store holds → a genuine new or re-auth sign-in.
      //     This is how a user RECOVERS a contaminated account, so it must run before
      //     the contaminated-store prompt (0): otherwise a real /login is short-
      //     circuited by the prompt and never lands (the exact way recovery got stuck).
      //     A fresh grant cannot be another account's, so capturing it is safe;
      //     captureCurrentAccount reuses/restores by email, heals the store, and binds.
      if (dirTok && !owner) {
        log(`reconcile: in-window sign-in as ${email} (fresh grant) — capturing`);
        const captured = await this.captureCurrentAccount({
          quiet: true,
          silent: true,
          sourceDir: dir,
        });
        if (captured && !this.recentlyReloaded()) {
          await this.requestWindowReload(
            `Signed in as ${email} — reloading so Claude Code switches to it.`
          );
        }
        return;
      }

      // (0) The bound account's OWN store is contaminated — its stored token belongs
      //     to a different account (the credential-mix end state). It can't be
      //     re-asserted; only signing in again fixes it. Surface that once. (A fresh
      //     login already returned above, so this can no longer block recovery.)
      if (bound && boundTok && foreignTokenConflict(bound.dir, boundTok, boundEmail)) {
        if (await this.noteContaminationPrompt()) {
          this.offerAccountPick(
            `${boundEmail}'s saved credentials were overwritten by another account. ` +
              `Sign in again as ${boundEmail} (Claude Code /login) to restore it.`
          );
        }
        return;
      }

      // (1) Identity-only bleed: the dir still HOLDS the bound account's token; only
      //     its identity field drifted. The window genuinely still runs `bound`, so
      //     correct the identity in place — no follow, no store write, no reload.
      //     This is what stops a bleed from flickering the account or looping a
      //     reload, even if Claude Code keeps re-stamping from the shared home file.
      if (bound && dirTok && boundTok && sameCredential(dirTok, boundTok)) {
        const id =
          readIdentity(bound.dir) ??
          (boundEmail ? { email: boundEmail, displayName: boundEmail } : undefined);
        if (id) {
          stampIdentity(dir, id);
          log(
            `reconcile: identity-only drift ${boundEmail} → ${email} (token unchanged) — ` +
              `restamped in place, no reload`
          );
        } else {
          log(`reconcile: identity-only drift but bound identity unreadable — left dir as-is`);
        }
        return;
      }

      // (2) The dir holds an EXISTING account's grant, consistent with its identity —
      //     a genuine in-window switch to that saved account. Follow (same-account
      //     store refresh + bind); decided by who OWNS the token, not the identity.
      if (owner && emailsEqual(this.registry.emailOf(owner), email)) {
        log(`reconcile: in-window switch to saved ${email} (token matches its store) — following`);
        const followed = await this.captureCurrentAccount({
          quiet: true,
          silent: true,
          sourceDir: dir,
        });
        // Only reload if the follow actually took (capture bound the account) — a
        // reload that left the trigger state unchanged would just re-fire this path.
        if (followed && !this.recentlyReloaded()) {
          await this.requestWindowReload(
            `Signed in as ${email} — reloading so Claude Code switches to it.`
          );
        }
        return;
      }

      // (3) The dir's token belongs to a DIFFERENT account than its identity claims —
      //     a mix. Never follow, never pull. Re-assert the bound account from its
      //     (verified-clean above) store: push store→dir, overwriting the foreign
      //     pair. Reload only if that actually cleared the drift, or a no-op/failed
      //     materialize would spin a metered reload loop.
      if (bound && hasCredentials(bound.dir)) {
        log(
          `reconcile: dir token belongs to ${owner ? (this.registry.emailOf(owner) ?? owner.name) : 'another account'} but ` +
            `identity says ${email} — re-asserting ${boundEmail} from store`
        );
        materialize(bound, dir, true);
        if (emailsEqual(readIdentity(dir)?.email, boundEmail)) {
          mirrorToDefault(dir, readIdentity(dir));
          if (!this.recentlyReloaded()) {
            await this.requestWindowReload(`Restored ${boundEmail ?? bound.name} for this window.`);
          }
        } else {
          log(
            `reconcile: re-assert did not clear drift (materialize no-op/failed) — not reloading`
          );
        }
        return;
      }
      if (await this.noteContaminationPrompt()) {
        this.offerAccountPick(
          `This window's account identity looks inconsistent. Pick an account or sign in again.`
        );
      }
      return;
    }

    const account =
      this.registry.savedForEmail(email) ??
      (await this.captureCurrentAccount({ quiet: true, silent: true, sourceDir: dir }));
    if (!account) return;

    // No drift: the dir runs the account this window is bound to (or the window is
    // unbound / on the default dir). Copy the dir's token back to the store and
    // mirror to the default — but only when the dir's token is NOT another
    // account's (a bled identity that happens to match the bound name while carrying
    // a foreign token must not seed the store or the default dir).
    const ndTok = this.readToken(dir);
    const foreign = ndTok
      ? foreignTokenConflict(account.dir, ndTok, this.registry.emailOf(account))
      : null;
    if (foreign) {
      // This window's grant is byte-shared with another account's store. This window
      // is NOT the broken one — its token matches its identity and it works; the
      // account whose store was overwritten is surfaced in ITS window (the drift
      // path prompts the correctly-attributed account). Prompting here would nag the
      // wrong (victim) account, so just refuse to propagate and log it.
      log(
        `reconcile: dir token also lives in ${foreign} (shared grant); identity is ${email} — ` +
          `not refreshing store or mirroring`
      );
    } else {
      // Keep the store's token in step with the dir (same account — cannot
      // cross-contaminate; refreshStore also carries the tripwire as defence in
      // depth). And keep Claude Code's own default dir signed in as this account, so
      // losing the extension never leaves the user signed out.
      refreshStore(account, dir);
      mirrorToDefault(dir, readIdentity(dir));
    }
    // Propagate newly-added home MCP servers into already-stocked windows.
    syncMcpServers(dir);
    linkUserSettings(dir);
    const changed = active !== account.name;
    if (changed) await this.binding.bind(account);

    // First run only: the window was still on the shared DEFAULT dir. It is bound
    // now, but Claude Code read the default at activation and won't look again —
    // so until a reload it keeps running there, where another window's sign-in
    // could still reach it. One reload moves it onto its own dir for good.
    if (onDefault) {
      if (this.recentlyReloaded()) {
        log(`reconcile: on default dir but already reloaded recently — skip second reload`);
        return;
      }
      await this.requestWindowReload(
        `${email} is set up. This window now runs it in a directory of its own — signing in to ` +
          `another account here will no longer disturb your other windows.`
      );
    } else if (changed && active) {
      // Name/account drift (Switch Account, capture, or Claude Code /login).
      // Switch Account already reloaded with userInitiated=true; after that
      // reload, Claude Code has re-read CLAUDE_CONFIG_DIR. A second automatic
      // reload only hits the circuit breaker and shows a scary "skipped" toast.
      if (this.recentlyReloaded()) {
        log(
          `reconcile: active ${active} → ${account.name} (${email}) after recent reload — bind only, no second reload`
        );
        return;
      }
      // Mid-session sign-in without our switchTo: Claude Code still has the old
      // process; reload so the panel matches the dir.
      await this.requestWindowReload(
        `Signed in as ${email} — reloading so Claude Code fully switches to it.`
      );
    }
  }

  /** This dir's `.credentials.json` bytes, or undefined if absent/unreadable. */
  private readToken(dir: string): Buffer | undefined {
    try {
      return fs.readFileSync(path.join(dir, '.credentials.json'));
    } catch {
      return undefined;
    }
  }

  /**
   * The saved account whose STORE holds this exact OAuth grant, or undefined —
   * i.e. who a token actually belongs to, decided by the credential bytes rather
   * than the (spoofable) identity field. `excludeDir` skips the working dir doing
   * the asking so it never matches itself.
   */
  private accountOwningToken(token: Buffer, excludeDir: string): Account | undefined {
    const skip = path.normalize(excludeDir);
    for (const a of this.registry.list()) {
      if (path.normalize(a.dir) === skip) continue;
      const buf = this.readToken(a.dir);
      if (buf && sameCredential(buf, token)) return a;
    }
    return undefined;
  }

  /**
   * Rate-limits the "your credentials were overwritten" prompt to once per window
   * per cooldown. The contaminated-store branch changes no state (re-materializing
   * the wrong token would loop), so without this every focus/watcher reconcile
   * would re-toast. Returns true when it's OK to prompt now.
   */
  private async noteContaminationPrompt(withinMs = 5 * 60_000): Promise<boolean> {
    const key = 'claudeProfiles.lastContaminationPrompt';
    const last = this.context.workspaceState.get<number>(key, 0);
    const now = Date.now();
    if (last && now - last < withinMs) return false;
    // Await the persist so a focus/watcher reconcile firing right after does not
    // read a stale timestamp and re-toast inside the cooldown.
    await this.context.workspaceState.update(key, now);
    return true;
  }

  /**
   * The user ran `/logout` in this window. That REVOKES the refresh token on
   * Anthropic's side — not just locally — so every copy of it is now a dead
   * credential, the account's store included. Leaving the account in the list
   * would be a lie: switching to it later would look signed in and fail on the
   * first request. Sign its store out and drop it, exactly as Forget would.
   *
   * Its data dir stays (nothing is deleted), so signing in again brings it back.
   */
  private async handleLoggedOut(dir: string): Promise<void> {
    const active = this.binding.getActiveName();
    const account = active ? this.registry.get(active) : undefined;
    if (!account) return;

    // A REAL logout deletes the token, clears oauthAccount from the dir's
    // config, and leaves that config file in place (Claude Code's own routine).
    // Anything else — identity still present, or no config file at all — is not
    // a logout but a working copy that failed to stock (an interrupted copy, a
    // full disk). The store is intact, so restock it; concluding "logout" here
    // would forget — and sign out — a perfectly good account over an IO hiccup.
    if (!looksLikeLogout(dir) && hasCredentials(account.dir)) {
      log(
        `working dir ${dir} lost its token but kept its identity — restocking from ${account.name}`
      );
      materialize(account, dir, true);
      await this.requestWindowReload(
        `Restored ${this.registry.emailOf(account) ?? account.name} for this window.`
      );
      return;
    }
    const email = this.registry.emailOf(account) ?? account.name;
    log(`logged out of ${email} in this window — its token is revoked everywhere`);

    await this.registry.forget(account);
    await this.binding.forget(account);
    // Every dir holding this (now revoked) token, not just the account's store:
    // the working copies AND Claude Code's default dir, which mirrorToDefault
    // keeps stocked. Missing the default one would leave the machine looking
    // signed in to an account whose token the server has already killed — it
    // would fail on the first request, with nothing on screen to explain why.
    const dirs = [
      ...dirsHoldingToken(email),
      ...allWorkingDirs().filter((d) => readIdentity(d)?.email === email),
    ];
    // Kill any live session on these dirs before deleting the token: on a
    // graceful shutdown Claude Code flushes its in-memory token back to disk,
    // which would resurrect the credential we are signing out.
    interruptSessions(dirs);
    for (const d of dirs) signOut(d);
    vscode.window.showInformationMessage(
      `Claude Accounts: you signed out of ${email}, so it was removed from the list — a logout ` +
        `revokes the account everywhere, not just in this window. Sign in again to bring it back.`
    );
  }

  // ─── Switching this window's account ────────────────────────────────────────

  async switchAccountInteractive(): Promise<void> {
    const accounts = this.registry.listUniqueByEmail();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage(
        'No accounts yet. Sign in with Claude Code and this window will remember the account automatically.'
      );
      return;
    }

    const activeName = this.binding.getActiveName();
    type Item = vscode.QuickPickItem & { account: Account };
    const items: Item[] = accounts.map((a) => ({
      label: `${a.name === activeName ? '$(check) ' : '$(account) '}${this.registry.emailOf(a) ?? a.name}`,
      description: a.name === activeName ? 'current' : '',
      account: a,
    }));

    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const settingsRoutes = (
      vscode.workspace
        .getConfiguration('claudeAccounts')
        .get<WorkspaceRoute[]>('workspaceRoutes', []) || []
    ).filter((r) => r?.pathPrefix && r?.email);
    const settingsPin =
      folderPath && settingsRoutes.length ? matchWorkspaceRoute(folderPath, settingsRoutes) : null;

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Switch Claude account for this window (reloads the window)',
      placeHolder: settingsPin
        ? `Settings pin this folder to ${settingsPin.email} (re-applies on reload)`
        : 'Pick the account this window should use',
    });
    if (!picked) return;
    if (picked.account.name === activeName) {
      // Never a silent no-op: to the user a click that does nothing is a bug.
      vscode.window.showInformationMessage(
        `${this.registry.emailOf(picked.account) ?? picked.account.name} is already this window's account.`
      );
      return;
    }
    if (settingsPin) {
      const pickEmail = this.registry.emailOf(picked.account);
      if (pickEmail && pickEmail.toLowerCase() !== settingsPin.email.toLowerCase()) {
        const go = await vscode.window.showWarningMessage(
          `This folder is pinned in settings to ${settingsPin.email}. ` +
            `Switching to ${pickEmail} reloads once, but the pin re-applies the next time the window opens ` +
            `(edit claudeAccounts.workspaceRoutes to change that).`,
          { modal: true },
          'Switch anyway'
        );
        if (go !== 'Switch anyway') return;
      }
    }
    await this.switchTo(picked.account, { userInitiated: true });
  }

  /**
   * Stocks this window's working dir with the account and reloads.
   *
   * The reload is not a nicety: Claude Code reads CLAUDE_CONFIG_DIR once, when its
   * extension host activates, and keeps a long-lived process — a live swap would
   * be invisible to it, leaving the panel showing one account while every request
   * billed another. On reload this extension activates first (activation event
   * `*`) and the new account is already in place.
   */
  /**
   * Bind + reload. Explicit user actions use userInitiated (bypass breaker).
   * Automatic folder-route correction should pass userInitiated: false so a
   * broken loop degrades to a manual "Reload window" button.
   */
  async switchTo(
    account: Account,
    opts: { userInitiated?: boolean; notice?: string } = {}
  ): Promise<void> {
    await this.binding.bind(account);
    await this.requestWindowReload(opts.notice, {
      userInitiated: opts.userInitiated !== false,
    });
  }

  // ─── Forgetting an account ──────────────────────────────────────────────────

  async removeAccountInteractive(): Promise<void> {
    const accounts = this.registry.listUniqueByEmail();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage('No accounts to forget.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((a) => ({
        label: this.registry.emailOf(a) ?? a.name,
        description: a.dir,
        account: a,
      })),
      {
        title: 'Forget a saved account',
        placeHolder: 'Pick an account to sign out and remove from the list',
      }
    );
    if (!picked) return;

    const email = this.registry.emailOf(picked.account) ?? picked.account.name;
    const choice = await vscode.window.showWarningMessage(
      `Forget ${email}?\n\n` +
        `• It's removed from this extension's list.\n` +
        `• Its OAuth token is deleted from every copy on disk — the account is signed out ` +
        `everywhere, including any window running it.\n` +
        `• Active Claude Code sessions on it, in ANY window, are interrupted.\n` +
        `• History, settings and its data folder stay on disk; signing in again restores it.`,
      { modal: true },
      'Forget'
    );
    if (choice !== 'Forget') return;

    const copies = this.registry
      .list()
      .filter((a) => this.registry.emailOf(a) === this.registry.emailOf(picked.account));

    // Was THIS window running it? Decide before the binding is released.
    const usedHere = copies.some((c) => c.name === this.binding.getActiveName());

    for (const copy of copies) {
      await this.registry.forget(copy);
      await this.binding.forget(copy);
    }

    // Drop forgotten email from CLI policy cache so orch cannot pick it
    try {
      const { prunePolicyEmails } = await import('./usage');
      prunePolicyEmails([email]);
    } catch {
      /* non-fatal */
    }

    // Sign the account out of EVERY dir holding it: its store, the default dir
    // (where a sign-in may have left the original), and every window's working
    // copy. Missing any one of them leaves the account still signed in somewhere,
    // and a reloaded window would quietly restore itself from it.
    const dirs = [
      ...dirsHoldingToken(email),
      ...allWorkingDirs().filter((d) => readIdentity(d)?.email === email),
    ];
    // Kill live sessions FIRST, and with SIGKILL: on a graceful shutdown Claude
    // Code flushes its in-memory token back to disk, undoing the delete.
    const interrupted = interruptSessions(dirs);
    let signedOut = 0;
    for (const dir of dirs) if (signOut(dir)) signedOut++;

    const parts = [`Forgot ${email}.`];
    parts.push(
      signedOut > 0
        ? `Signed it out of ${signedOut} ${signedOut > 1 ? 'directories' : 'directory'}; history and settings stay on disk.`
        : `Its data stays on disk — sign in again to restore it.`
    );
    if (interrupted > 0) {
      parts.push(`Interrupted ${interrupted} active session${interrupted > 1 ? 's' : ''}.`);
    }

    // If this window was running it, reload: Claude Code only reads its account at
    // activation, so otherwise the window sits on a dir we just emptied, with a
    // dead session and a panel still naming an account that no longer exists.
    if (usedHere) {
      await this.requestWindowReload(parts.join(' '), { userInitiated: true });
      return;
    }
    vscode.window.showInformationMessage(parts.join(' '));
  }
}

/**
 * Derives a directory slug from an email. Tries the local part first; if that is
 * taken (same local part, different domain — daniil@gmail.com vs daniil@work.dev)
 * it disambiguates with the domain rather than an opaque counter: `daniil`, then
 * `daniil-work-dev`. A numeric suffix is the last resort only.
 */
function suggestName(email: string, available: (n: string) => boolean): string {
  const slug = (s: string) =>
    s
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'account';
  const [local = 'account', domain = ''] = email.split('@');
  const candidates = [slug(local), domain ? slug(`${local}-${domain}`) : ''].filter(Boolean);
  for (const c of candidates) if (available(c)) return c;
  for (let i = 2; i < 100; i++)
    if (available(`${candidates[0]}${i}`)) return `${candidates[0]}${i}`;
  return candidates[0];
}
